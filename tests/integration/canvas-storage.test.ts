/**
 * T3.1 存储抽象集成测试：StorageBackend 契约 + 逐画布绑定 + 同步门面。
 *
 * - LocalBackend：tmp 根目录，真实 fs。
 * - S3Backend：fetchImpl 内存替身 + targetResolver 注入（零网络、零凭据依赖）。
 * - 绑定/同步：setBackendFactoryForTests 注入内存后端；安全边界断言（非法 id 拒绝、
 *   凭据不进任何工件文件）。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidCanvasId,
  StorageConflictError,
  canvasIdFromSessionFile,
  type CanvasStorageBackend,
} from "../../server/storage/backend.js";
import { LocalCanvasBackend, localEtag } from "../../server/storage/local-backend.js";
import { S3CanvasBackend } from "../../server/storage/s3-backend.js";
import {
  bindCanvasStorage,
  refreshCanvasFromRemote,
  syncCanvasToRemote,
  setBackendFactoryForTests,
  clearStorageBinding,
} from "../../server/storage/canvas-storage.js";
import { saveCanvas, loadCanvas } from "../../server/session-history.js";

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "govio-t31-storage-"));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => setBackendFactoryForTests(null));
afterEach(() => {
  setBackendFactoryForTests(null);
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ── 契约套件：同一断言跑两个后端 ────────────────────────────────────────────

function contractSuite(name: string, make: () => Promise<CanvasStorageBackend> | CanvasStorageBackend) {
  describe(`CanvasStorageBackend 契约 · ${name}`, () => {
    it("write→read 往返等值，etag 稳定且随内容变化", async () => {
      const b = await make();
      const json = JSON.stringify({ nodes: [{ id: "n1" }], edges: [] });
      const w = await b.write("canvas-a", json);
      const r = await b.read("canvas-a");
      expect(r?.json).toBe(json);
      expect(r?.etag).toBe(w.etag);
      const w2 = await b.write("canvas-a", JSON.stringify({ nodes: [], edges: [] }));
      expect(w2.etag).not.toBe(w.etag);
    });
    it("miss → null；remove 幂等；list 排序", async () => {
      const b = await make();
      expect(await b.read("ghost")).toBeNull();
      await b.write("c2", "{}");
      await b.write("c1", "{}");
      expect(await b.list()).toEqual(expect.arrayContaining(["c1", "c2"]));
      const listed = await b.list();
      expect(listed).toEqual([...listed].sort());
      expect(await b.remove("c1")).toBe(true);
      expect(await b.remove("c1")).toBe(false);
    });
    it("ifMatch 陈旧 etag → StorageConflictError；正确 etag 通过", async () => {
      const b = await make();
      const w = await b.write("cw", "{\"v\":1}");
      await b.write("cw", "{\"v\":2}");
      await expect(b.write("cw", "{\"v\":3}", { ifMatch: w.etag })).rejects.toBeInstanceOf(StorageConflictError);
      const cur = await b.read("cw");
      const w2 = await b.write("cw", "{\"v\":3}", { ifMatch: cur!.etag });
      expect(w2.etag).toBeTruthy();
    });
    it("非法 canvasId（穿越/分隔符/超长）被拒", async () => {
      const b = await make();
      for (const bad of ["../evil", "a/b", "a\b", "..", "", "x".repeat(200), ".hidden"]) {
        await expect(b.read(bad)).rejects.toThrow(/invalid canvas id/);
        await expect(b.write(bad, "{}")).rejects.toThrow(/invalid canvas id/);
      }
    });
  });
}

contractSuite("LocalBackend", () => new LocalCanvasBackend(tmpRoot()));

contractSuite("S3Backend(mock fetch)", async () => {
  const store = new Map<string, string>();
  const fetchImpl = (async (url: string | URL | undefined, init?: RequestInit) => {
    const key = new URL(String(url)).pathname.replace(/^\/bucket\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      const rh = (init?.headers ?? {}) as Record<string, string>;
      const putIfMatch = String(rh["if-match"] ?? "").replace(/^"|"$/g, "");
      const cur = store.get(key);
      if (putIfMatch && (cur === undefined || localEtag(cur) !== putIfMatch)) {
        return new Response("", { status: 412 });
      }
      store.set(key, String(init?.body ?? ""));
      return new Response("", { status: 200, headers: { etag: `"${localEtag(store.get(key)!)}"` } });
    }
    if (method === "DELETE") {
      const had = store.delete(key);
      return new Response(had ? null : "", { status: had ? 204 : 404 });
    }
    if (key === "" || key === "/") {
      const xml = `<?xml version="1.0"?><ListBucketResult>${[...store.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (!store.has(key)) return new Response("", { status: 404 });
    const body = store.get(key)!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifMatch = String(headers["if-match"] ?? "");
    if (ifMatch && ifMatch.replace(/"|"$/g, "") !== localEtag(body)) return new Response("", { status: 412 });
    return new Response(body, { status: 200, headers: { etag: `"${localEtag(body)}"` } });
  }) as typeof fetch;
  return new S3CanvasBackend("p1", {
    fetchImpl,
    targetResolver: () => ({
      profileId: "p1",
      endpoint: "http://mock-s3",
      region: "us-east-1",
      bucket: "bucket",
      prefix: "govio",
      accessKeyId: "AK-mock",
      secretAccessKey: "SK-mock",
      forcePathStyle: true,
    }),
  });
});

// ── 内存 S3 替身（供绑定/同步门面测试）──────────────────────────────────────

interface MemS3 {
  backend: CanvasStorageBackend;
  objects: Map<string, string>;
  writes: number;
}

function memS3(): MemS3 {
  const objects = new Map<string, string>();
  let writes = 0;
  const backend: CanvasStorageBackend = {
    kind: "s3",
    async read(canvasId) {
      const k = `${canvasId}/canvas.json`;
      const json = objects.get(k);
      return json === undefined ? null : { json, etag: localEtag(json) };
    },
    async write(canvasId, json, opts) {
      const k = `${canvasId}/canvas.json`;
      const cur = objects.get(k);
      if (opts?.ifMatch && (cur === undefined || localEtag(cur) !== opts.ifMatch)) {
        throw new StorageConflictError(canvasId);
      }
      objects.set(k, json);
      writes += 1;
      return { etag: localEtag(json) };
    },
    async remove(canvasId) {
      return objects.delete(`${canvasId}/canvas.json`);
    },
    async list() {
      return [...objects.keys()].filter((k) => k.endsWith("/canvas.json")).map((k) => k.slice(0, -"/canvas.json".length)).sort();
    },
  };
  return { backend, objects, get writes() { return writes; } } as unknown as MemS3;
}

/** 绕过 saveCanvas 挂点直写本地 sidecar（专测显式同步路径，避免 fire-and-forget 竞态）。 */
function writeLocalCanvas(sessionFile: string, nodes: unknown[], edges: unknown[]): void {
  writeFileSync(sessionFile + ".canvas.json", JSON.stringify({ nodes, edges }));
}

describe("逐画布绑定 + 同步门面（本地写 + 异步同步模型）", () => {
  it("无绑定：saveCanvas 行为与旧实现等价（文件字节一致、同步 no-op）", async () => {
    const dir = tmpRoot();
    const sessionFile = join(dir, "2026-11-14T00-00-00-000Z_sess-plain.jsonl");
    saveCanvas(sessionFile, [{ id: "n1" }], [{ id: "e1" }]);
    const raw = readFileSync(sessionFile + ".canvas.json", "utf-8");
    expect(raw).toBe(JSON.stringify({ nodes: [{ id: "n1" }], edges: [{ id: "e1" }] }));
    expect(existsSync(sessionFile + ".storage.json")).toBe(false);
    const res = await syncCanvasToRemote(sessionFile);
    expect(res.synced).toBe(false);
  });

  it("绑定后：同步上传、重复同步跳过（内容 hash 未变）、冲突时最后写入胜出", async () => {
    const dir = tmpRoot();
    const sessionFile = join(dir, "2026-11-14T00-00-00-000Z_sess-bound.jsonl");
    const mem = memS3();
    setBackendFactoryForTests(() => mem.backend);

    const binding = bindCanvasStorage(sessionFile, { profile: "team-a" });
    expect(binding.canvasId).toBe(canvasIdFromSessionFile(sessionFile));
    writeLocalCanvas(sessionFile, [{ id: "n1" }], []);
    const first = await syncCanvasToRemote(sessionFile);
    expect(first.synced).toBe(true);
    const key = binding.canvasId + "/canvas.json";
    expect(mem.objects.get(key)).toBe(readFileSync(sessionFile + ".canvas.json", "utf-8"));

    const again = await syncCanvasToRemote(sessionFile);
    expect(again.synced).toBe(false);
    expect(again.error).toBeUndefined();

    // 远端被另一端改过（本地 etag 记录陈旧）+ 本地又有新改动 → 冲突路径：最后写入胜出
    mem.objects.set(key, JSON.stringify({ nodes: [{ id: "peer" }], edges: [] }));
    writeLocalCanvas(sessionFile, [{ id: "n2" }], []);
    const conflicted = await syncCanvasToRemote(sessionFile);
    expect(conflicted.synced).toBe(true);
    expect(conflicted.conflict).toBe(true);
    expect(JSON.parse(mem.objects.get(key)!).nodes).toEqual([{ id: "n2" }]);
  });

  it("refresh：本地无未同步改动时拉远端覆盖；有未同步改动时保本地并报冲突", async () => {
    const dir = tmpRoot();
    const sessionFile = join(dir, "2026-11-14T00-00-00-000Z_sess-pull.jsonl");
    const mem = memS3();
    setBackendFactoryForTests(() => mem.backend);
    const binding = bindCanvasStorage(sessionFile, { profile: "p" });
    const key = binding.canvasId + "/canvas.json";

    writeLocalCanvas(sessionFile, [{ id: "local" }], []);
    await syncCanvasToRemote(sessionFile);

    // 对端改了远端，本地无未同步改动 → refresh 拉回
    mem.objects.set(key, JSON.stringify({ nodes: [{ id: "remote-edit" }], edges: [] }));
    const pulled = await refreshCanvasFromRemote(sessionFile);
    expect(pulled.pulled).toBe(true);
    expect(loadCanvas(sessionFile)?.nodes).toEqual([{ id: "remote-edit" }]);

    // 本地又有未同步改动 → 冲突保本地
    writeLocalCanvas(sessionFile, [{ id: "local-wip" }], []);
    mem.objects.set(key, JSON.stringify({ nodes: [{ id: "remote-later" }], edges: [] }));
    const conflicted = await refreshCanvasFromRemote(sessionFile);
    expect(conflicted.pulled).toBe(false);
    expect(conflicted.conflict).toBe(true);
    expect(loadCanvas(sessionFile)?.nodes).toEqual([{ id: "local-wip" }]);

    // 无绑定 → no-op
    clearStorageBinding(sessionFile);
    expect((await refreshCanvasFromRemote(sessionFile)).pulled).toBe(false);
  });

  it("saveCanvas 挂点：绑定画布的本地写自动触发远端上传（fire-and-forget）", async () => {
    const dir = tmpRoot();
    const sessionFile = join(dir, "2026-11-14T00-00-00-000Z_sess-auto.jsonl");
    const mem = memS3();
    setBackendFactoryForTests(() => mem.backend);
    const binding = bindCanvasStorage(sessionFile, { profile: "team-auto" });
    saveCanvas(sessionFile, [{ id: "autosave" }], []);
    const key = binding.canvasId + "/canvas.json";
    for (let i = 0; i < 20 && !mem.objects.has(key); i++) await new Promise((r) => setTimeout(r, 10));
    expect(mem.objects.get(key)).toBeDefined();
    expect(JSON.parse(mem.objects.get(key)!).nodes).toEqual([{ id: "autosave" }]);
  });

  it("凭据安全：绑定文件与画布工件不含 secret（profiles 只存 env 名）", () => {
    const dir = tmpRoot();
    const sessionFile = join(dir, "2026-11-14T00-00-00-000Z_sess-cred.jsonl");
    bindCanvasStorage(sessionFile, { profile: "s3-team" });
    const bindingRaw = readFileSync(sessionFile + ".storage.json", "utf-8");
    expect(bindingRaw).toContain("s3-team");
    for (const leak of ["accessKey", "secret", "endpoint", "bucket"]) {
      expect(bindingRaw.toLowerCase()).not.toContain(leak);
    }
  });

  it("assertValidCanvasId 与 canvasIdFromSessionFile 等价安全边界", () => {
    expect(canvasIdFromSessionFile("/x/y/2026-11-14T00-00-00-000Z_uuid.jsonl")).toBe("2026-11-14T00-00-00-000Z_uuid");
    expect(() => assertValidCanvasId("../escape")).toThrow(/invalid canvas id/);
    expect(() => assertValidCanvasId("a/b")).toThrow(/invalid canvas id/);
    expect(assertValidCanvasId("ok.id-1_2")).toBe("ok.id-1_2");
  });
});
