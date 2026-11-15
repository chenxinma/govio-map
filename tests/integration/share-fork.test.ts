/**
 * T3.2 分享与 fork 集成测试（tmp cwd 隔离，不触真实 .govio/）：
 *  - createShare → resolveShare 往返；Manifest 抽取；视图载荷剥 profile/凭据
 *  - 只读纪律：resolve/fork 不改源画布 sidecar；不存在写回路径
 *  - fork 血缘：forkFrom 进 canvas.json 顶层且 autosave 不抹掉；再分享继承血缘
 *  - 远端 share：S3 绑定画布的分享写远端（transport 替身），跨实例按 profile 发现
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCanvas, loadCanvas } from "../../server/session-history.js";
import { bindCanvasStorage } from "../../server/storage/canvas-storage.js";
import { localEtag } from "../../server/storage/local-backend.js";
import {
  SHARE_ID_RE,
  createShare,
  forkShare,
  readStagedFork,
  consumeStagedFork,
  resolveShare,
  parseShareRecord,
  shareViewPayload,
  setShareTransportFactoryForTests,
  remoteShareKey,
} from "../../server/share.js";

const tmpDirs: string[] = [];
let prevCwd = "";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "govio-t32-share-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".govio"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  setShareTransportFactoryForTests(null);
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function manifestNode(extra: Record<string, unknown> = {}) {
  return {
    id: "gov-7",
    type: "dataFrame",
    position: { x: 10, y: 20 },
    data: {
      type: "dataFrame",
      title: "orders_summary",
      dfName: "orders_summary",
      ...extra,
      manifest: {
        schemaVersion: 1,
        origin: "sql-editor",
        sql: "SELECT 1",
        datasource: "duck",
        executedAt: "2026-11-14T00:00:00.000Z",
        rowCount: 3,
        columnCount: 2,
        checksum: { algorithm: "schema-v1", rowCount: 3, columnCount: 2, schemaHash: "aa11", sqlHash: "bb22" },
        sessionId: "s1",
      },
    },
  };
}

function sessionFile(name: string): string {
  const dir = join(process.cwd(), ".govio", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.jsonl`);
}

describe("分享快照与只读语义", () => {
  it("createShare → resolveShare 往返；Manifest 抽取；令牌形状", async () => {
    const f = sessionFile("2026-11-14T00-00-00-000Z_sess-share1");
    saveCanvas(f, [manifestNode()], [{ id: "e1", source: "gov-7", target: "gov-8" }]);
    const rec = await createShare(f, "share-session");
    expect(SHARE_ID_RE.test(rec.shareId)).toBe(true);
    expect(rec.canvas.nodes).toHaveLength(1);
    expect(rec.manifests).toHaveLength(1);
    expect(rec.manifests[0].manifest.sql).toBe("SELECT 1");
    expect(rec.originBackend).toBe("local");
    expect(existsSync(join(".govio", "shares", `${rec.shareId}.json`))).toBe(true);

    const back = await resolveShare(rec.shareId);
    expect(back?.shareId).toBe(rec.shareId);
    expect(back?.canvas).toEqual(rec.canvas);
    expect(await resolveShare("0000000000000000000000000000dead")).toBeNull();
    expect(parseShareRecord("{bad json")).toBeNull();
  });

  it("视图载荷剥 profile/originBackend；一切工件不含凭据", async () => {
    process.env.GOVIO_T32_AK = "AKIA-SECRET-VALUE";
    process.env.GOVIO_T32_SK = "sk-SECRET-VALUE";
    const profilesPath = join(".govio", "storage-profiles.json");
    writeFileSync(profilesPath, JSON.stringify({
      version: 1,
      profiles: { t32: { region: "us-east-1", bucket: "govio-test", prefix: "p", accessKeyIdEnv: "GOVIO_T32_AK", secretAccessKeyEnv: "GOVIO_T32_SK" } },
    }));
    const f = sessionFile("2026-11-14T00-00-00-000Z_sess-cred");
    saveCanvas(f, [manifestNode()], []);
    bindCanvasStorage(f, { profile: "t32" });
    const puts: Array<{ key: string; json: string }> = [];
    setShareTransportFactoryForTests(() => ({
      async put(key, json) { puts.push({ key, json }); },
      async get() { return null; },
    }));
    const rec = await createShare(f, "cred-check");
    const view = JSON.stringify(shareViewPayload(rec));
    const localRecord = readFileSync(join(".govio", "shares", `${rec.shareId}.json`), "utf-8");
    const bindingRaw = readFileSync(f + ".storage.json", "utf-8");
    for (const artifact of [view, localRecord, bindingRaw, puts.map((x) => x.json).join("")]) {
      expect(artifact).not.toContain("AKIA-SECRET-VALUE");
      expect(artifact).not.toContain("sk-SECRET-VALUE");
    }
    expect(shareViewPayload(rec)).not.toHaveProperty("profile");
    expect(view).not.toContain("t32");
    delete process.env.GOVIO_T32_AK;
    delete process.env.GOVIO_T32_SK;
  });

  it("只读纪律：resolve/fork 不改动源画布 sidecar（内容+etag 恒定）", async () => {
    const f = sessionFile("2026-11-14T00-00-00-000Z_sess-ro");
    saveCanvas(f, [manifestNode()], []);
    const before = readFileSync(f + ".canvas.json", "utf-8");
    const rec = await createShare(f, "ro");
    await resolveShare(rec.shareId);
    await forkShare(rec.shareId);
    expect(readFileSync(f + ".canvas.json", "utf-8")).toBe(before);
    expect(localEtag(readFileSync(f + ".canvas.json", "utf-8"))).toBe(localEtag(before));
  });

  it("S3 绑定画布的分享写远端 key，并可经 profile 枚举跨实例发现", async () => {
    const profilesPath = join(".govio", "storage-profiles.json");
    writeFileSync(profilesPath, JSON.stringify({
      version: 1,
      profiles: { peer: { region: "us-east-1", bucket: "govio-test", prefix: "p2", accessKeyIdEnv: "NO_AK", secretAccessKeyEnv: "NO_SK" } },
    }));
    const remote = new Map<string, string>();
    setShareTransportFactoryForTests(() => ({
      async put(key, json) { remote.set(key, json); },
      async get(key) { return remote.get(key) ?? null; },
    }));
    const f = sessionFile("2026-11-14T00-00-00-000Z_sess-remote");
    saveCanvas(f, [manifestNode()], []);
    bindCanvasStorage(f, { profile: "peer" });
    const rec = await createShare(f, "remote-share");
    expect(remote.get(remoteShareKey("peer", rec.shareId))).toBeDefined();

    // 模拟「对端实例」：本机没有分享记录，只能经配置的 profile 在远端发现
    rmSync(join(".govio", "shares", `${rec.shareId}.json`));
    const found = await resolveShare(rec.shareId);
    expect(found?.shareId).toBe(rec.shareId);
    expect(found?.manifests[0].nodeId).toBe("gov-7");
  });
});

describe("fork 续写与派生血缘", () => {
  it("forkShare 暂存 → 应用到新画布：forkFrom 落 canvas.json 顶层", async () => {
    const src = sessionFile("2026-11-14T00-00-00-000Z_sess-src");
    saveCanvas(src, [manifestNode()], [{ id: "e1" }]);
    const rec = await createShare(src, "src-name");
    const forked = await forkShare(rec.shareId);
    expect(forked).not.toBeNull();
    expect(SHARE_ID_RE.test(forked!.forkId)).toBe(true);

    const staged = readStagedFork(forked!.forkId);
    expect(staged?.forkFrom.shareId).toBe(rec.shareId);
    expect(staged?.canvas.nodes).toEqual(rec.canvas.nodes);

    const dst = sessionFile("2026-11-14T00-00-00-000Z_sess-dst");
    saveCanvas(dst, staged!.canvas.nodes, staged!.canvas.edges, { forkFrom: staged!.forkFrom });
    const raw = JSON.parse(readFileSync(dst + ".canvas.json", "utf-8"));
    expect(raw.forkFrom.shareId).toBe(rec.shareId);
    expect(raw.forkFrom.canvasId).toBe(rec.canvasId);
    expect(raw.forkFrom.kind).toBe("share");
    expect(consumeStagedFork(staged!.forkId)).toBe(true);
    expect(readStagedFork(staged!.forkId)).toBeNull();
    expect(forked!.forkFrom.forkedAt).toBeTruthy();
  });

  it("血缘抗 autosave：后续无 meta 的 saveCanvas（1s debounce 快照）保留 forkFrom", async () => {
    const src = sessionFile("2026-11-14T00-00-00-000Z_sess-src2");
    saveCanvas(src, [manifestNode()], []);
    const rec = await createShare(src, "src2");
    const forked = await forkShare(rec.shareId);
    const staged = readStagedFork(forked!.forkId)!;
    const dst = sessionFile("2026-11-14T00-00-00-000Z_sess-dst2");
    saveCanvas(dst, staged.canvas.nodes, staged.canvas.edges, { forkFrom: staged.forkFrom });
    // 模拟前端 autosave（不带 meta）
    saveCanvas(dst, [{ id: "changed" }], []);
    const canvas = loadCanvas(dst);
    expect(canvas?.nodes).toEqual([{ id: "changed" }]);
    const raw = JSON.parse(readFileSync(dst + ".canvas.json", "utf-8"));
    expect(raw.forkFrom.shareId).toBe(rec.shareId);
  });

  it("派生画布再分享：ShareRecord 继承 forkFrom（血缘链可追溯）；fork 未知令牌 404 语义", async () => {
    const src = sessionFile("2026-11-14T00-00-00-000Z_sess-gen");
    saveCanvas(src, [manifestNode()], []);
    const rec1 = await createShare(src, "gen1");
    const f1 = await forkShare(rec1.shareId);
    const staged1 = readStagedFork(f1!.forkId)!;
    const dst = sessionFile("2026-11-14T00-00-00-000Z_sess-gen2");
    saveCanvas(dst, staged1.canvas.nodes, staged1.canvas.edges, { forkFrom: staged1.forkFrom });
    const rec2 = await createShare(dst, "gen2");
    expect(rec2.forkFrom?.shareId).toBe(rec1.shareId);
    expect(rec2.forkFrom?.canvasId).toBe(rec1.canvasId);

    expect(await forkShare("0000000000000000000000000000beef")).toBeNull();
    expect(readStagedFork("not-a-fork-id")).toBeNull();
  });
});
