/**
 * T3.6 session 打包（/export）**服务端文件集收集**集成测试（tmp cwd 隔离，不触真实 .govio/）。
 *
 * 覆盖：
 *  - 打包清单：transcript / canvas / manifests（派生）/ audit / injection 全入包，sha256 与
 *    base64 可被独立复核（T3.7 就靠这份校验和验收）
 *  - token 一致性：= deriveShareToken(sessionId)，同一会话两次导出恒定，且**不要求**开启分享
 *  - 缺失 sidecar 如实记进 missing；parquet 排除记账（count/bytes/names/absent）
 *  - 凭据不泄漏（反向断言）：.storage.json 本体不入包，只留 profile 引用名
 *  - 分享开关 sidecar / 旧格式孤儿 .injection.zip 不入包
 *  - 安全：目录穿越被拒（assertValidSessionPath）、超总量上限抛 BundleTooLargeError
 *  - HTTP 路由：GET /api/session-bundle 的 200/400/404/405/409 + no-store + CORS 面未扩大
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

// 「当前活动会话」来自 pi AgentSession；测试用替身注入会话文件路径（与 share-live.test.ts 同款）。
const agentStub = vi.hoisted(() => ({ sessionFile: null as string | null }));
vi.mock("../../server/agent.js", () => ({
  getSession: () => (agentStub.sessionFile ? { sessionManager: { getSessionFile: () => agentStub.sessionFile } } : null),
}));

import { saveCanvas } from "../../server/session-history.js";
import { auditPathFor } from "../../server/permission-audit.js";
import { injectionTracePathFor } from "../../server/prompt-injection.js";
import {
  canvasPathFor,
  dataframeParquetDir,
  shareStatePathFor,
  storageBindingPathFor,
} from "../../server/storage/paths.js";
import { deriveShareToken, extractManifests } from "../../server/share.js";
import {
  BundleTooLargeError,
  collectSessionBundle,
  excludedParquetOf,
  MAX_BUNDLE_TOTAL_BYTES,
} from "../../server/session-bundle.js";
import { handleBundleApi } from "../../server/bundle-api.js";
import {
  BUNDLE_AUDIT_PATH,
  BUNDLE_CANVAS_PATH,
  BUNDLE_FORMAT,
  BUNDLE_INJECTION_PATH,
  BUNDLE_MANIFESTS_PATH,
  BUNDLE_SESSION_PATH,
  BUNDLE_VERSION,
  bundleFileName,
  isSafeBundlePath,
  type BundleFileEntry,
} from "../../src/types/bundle.js";

/**
 * 夹具用的**故意假**凭据值：刻意不带任何真实凭据的已知前缀形态，否则仓库密钥扫描
 * （GitGuardian）会把反向断言的夹具误报成真泄漏（T3.5 / PR #46 踩过）。
 */
const FAKE_PROFILE = "TEST-ONLY-PROFILE";
const FAKE_AK = "TEST-ONLY-AK-9999";
const FAKE_SK = "TEST-ONLY-SK-9999";
const FAKE_BUCKET = "test-only-bucket-do-not-leak";

const tmpDirs: string[] = [];
let prevCwd = "";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "govio-t36-bundle-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".govio"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(dir);
  agentStub.sessionFile = null;
});

afterEach(() => {
  agentStub.sessionFile = null;
  process.chdir(prevCwd);
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 建一个真实存在的会话文件（transcript 内容可指定）。 */
function sessionFile(name: string, transcript = '{"type":"message","id":"u0"}\n'): string {
  const dir = join(process.cwd(), ".govio", "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.jsonl`);
  writeFileSync(f, transcript);
  return f;
}

function dfNode(id: string, dfName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "dataFrame",
    position: { x: 10, y: 20 },
    data: {
      type: "dataFrame",
      title: dfName,
      dfName,
      ...extra,
      manifest: {
        schemaVersion: 1,
        origin: "sql-editor",
        sql: "SELECT 1",
        datasource: "duck",
        dfName,
        executedAt: "2026-11-17T00:00:00.000Z",
        rowCount: 3,
        columnCount: 2,
        checksum: { algorithm: "schema-v1", rowCount: 3, columnCount: 2, schemaHash: "aa11", sqlHash: "bb22" },
        sessionId: "s1",
      },
    },
  };
}

function sha256Hex(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function decode(entry: BundleFileEntry): Buffer {
  return Buffer.from(entry.contentBase64, "base64");
}

function byPath(entries: BundleFileEntry[], path: string): BundleFileEntry {
  const hit = entries.find((e) => e.path === path);
  if (!hit) throw new Error(`bundle 缺少包内文件 ${path}（实际：${entries.map((e) => e.path).join(", ")}）`);
  return hit;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  writeHead: (code: number, h?: Record<string, unknown>) => void;
  end: (b?: string) => void;
}

function fakeRes(): FakeRes {
  const res = { statusCode: 0, headers: {}, body: "" } as FakeRes;
  res.writeHead = (code: number, h?: Record<string, unknown>) => {
    res.statusCode = code;
    Object.assign(res.headers, h ?? {});
  };
  res.end = (b?: string) => {
    if (b) res.body += b;
  };
  return res;
}

async function callApi(method: string, url: string, headers: Record<string, string> = {}) {
  const req = { method, url, headers } as unknown as IncomingMessage;
  const res = fakeRes();
  const handled = await handleBundleApi(req, res as unknown as ServerResponse);
  return {
    handled,
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    json: () => (res.body ? (JSON.parse(res.body) as Record<string, never>) : null),
  };
}

describe("打包清单与校验和", () => {
  it("五类会话文件全入包，sha256 与 base64 可被独立复核（T3.7 的验收依据）", () => {
    const f = sessionFile("2026-11-17T00-00-00-000Z_sess-full", "line-1\nline-2\n");
    saveCanvas(f, [dfNode("gov-1", "orders_summary")], [{ id: "e1", source: "gov-1", target: "gov-1" }]);
    writeFileSync(auditPathFor(f), '{"type":"permission_decision","decisionId":"pd-1"}\n');
    writeFileSync(injectionTracePathFor(f), '{"type":"injection","entities":[]}\n');

    const payload = collectSessionBundle(f);
    const paths = payload.files.map((e) => e.path).sort();
    expect(paths).toEqual(
      [BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_MANIFESTS_PATH, BUNDLE_AUDIT_PATH, BUNDLE_INJECTION_PATH].sort(),
    );
    expect(payload.missing).toEqual([]);

    // 磁盘文件逐字节对上：base64 解码 === 原文件，sha256 === 独立重算值
    const diskPairs: Array<[string, string]> = [
      [BUNDLE_SESSION_PATH, f],
      [BUNDLE_CANVAS_PATH, canvasPathFor(f)],
      [BUNDLE_AUDIT_PATH, auditPathFor(f)],
      [BUNDLE_INJECTION_PATH, injectionTracePathFor(f)],
    ];
    for (const [bundlePath, diskPath] of diskPairs) {
      const entry = byPath(payload.files, bundlePath);
      const disk = readFileSync(diskPath);
      expect(decode(entry).equals(disk), `${bundlePath} base64 应还原为磁盘原字节`).toBe(true);
      expect(entry.bytes).toBe(disk.byteLength);
      expect(entry.sha256).toBe(sha256Hex(disk));
    }

    // manifests.json 是**派生**产物：内容与 share.ts 的 extractManifests 一致（真源仍是 canvas.json）
    const manifestsEntry = byPath(payload.files, BUNDLE_MANIFESTS_PATH);
    const canvasJson = JSON.parse(readFileSync(canvasPathFor(f), "utf-8")) as { nodes: unknown[] };
    expect(JSON.parse(decode(manifestsEntry).toString("utf-8"))).toEqual(extractManifests(canvasJson.nodes));
    expect(manifestsEntry.sha256).toBe(sha256Hex(decode(manifestsEntry)));
    const first = (JSON.parse(decode(manifestsEntry).toString("utf-8")) as Array<{ nodeId: string; manifest: { sql: string } }>)[0];
    expect(first.nodeId).toBe("gov-1");
    expect(first.manifest.sql).toBe("SELECT 1");
  });

  it("包内路径全部是单层正斜杠相对路径（isSafeBundlePath 白名单）", () => {
    const f = sessionFile("2026-11-17T00-00-01-000Z_sess-paths");
    saveCanvas(f, [], []);
    const payload = collectSessionBundle(f);
    for (const entry of payload.files) {
      expect(isSafeBundlePath(entry.path), `${entry.path} 必须是安全包内路径`).toBe(true);
      expect(entry.path.includes("\\")).toBe(false);
      expect(entry.path.startsWith("/")).toBe(false);
    }
    // 白名单本身：穿越 / 绝对路径 / 反斜杠 / 多层 / 空段一律拒
    for (const bad of ["../evil.jsonl", "/etc/passwd", "C:\\Windows\\x", "a/b.json", "", ".", "..", "dir/"]) {
      expect(isSafeBundlePath(bad), `${bad || "(空)"} 应被拒`).toBe(false);
    }
    expect(isSafeBundlePath("session.jsonl")).toBe(true);
    expect(isSafeBundlePath(bundleFileName("a".repeat(32)))).toBe(true);
  });

  it("缺失的可选 sidecar 如实记进 missing；无画布时 manifests.json 是空数组", () => {
    const f = sessionFile("2026-11-17T00-00-02-000Z_sess-bare");
    const payload = collectSessionBundle(f);
    expect(payload.files.map((e) => e.path).sort()).toEqual([BUNDLE_MANIFESTS_PATH, BUNDLE_SESSION_PATH].sort());
    expect(payload.missing.sort()).toEqual([BUNDLE_AUDIT_PATH, BUNDLE_CANVAS_PATH, BUNDLE_INJECTION_PATH].sort());
    expect(JSON.parse(decode(byPath(payload.files, BUNDLE_MANIFESTS_PATH)).toString("utf-8"))).toEqual([]);
  });
});

describe("token 一致性与包名", () => {
  it("token = deriveShareToken(sessionId)，同一会话两次导出恒定，且不要求已开启分享", () => {
    const sessionId = "2026-11-17T00-00-03-000Z_sess-token";
    const f = sessionFile(sessionId);
    saveCanvas(f, [], []);
    // 刻意**不**创建 .share.json：打包与分享开关解耦（归档不该要求先开分享）
    expect(existsSync(shareStatePathFor(f))).toBe(false);

    const a = collectSessionBundle(f);
    const b = collectSessionBundle(f);
    expect(a.token).toBe(deriveShareToken(sessionId));
    expect(a.token).toMatch(/^[a-f0-9]{32}$/);
    expect(b.token).toBe(a.token);
    expect(a.sessionId).toBe(sessionId);
    expect(a.sessionId).toBe(basename(f).replace(/\.jsonl$/, ""));
    expect(bundleFileName(a.token)).toBe(`${a.token}.govio-bundle.zip`);
  });

  it("不同会话 token 不同（指纹来自 sessionId）", () => {
    const f1 = sessionFile("2026-11-17T00-00-04-000Z_sess-a");
    const f2 = sessionFile("2026-11-17T00-00-05-000Z_sess-b");
    expect(collectSessionBundle(f1).token).not.toBe(collectSessionBundle(f2).token);
  });

  it("载荷形状契约：format/version/exportedAt（T3.7 校验先行的输入）", () => {
    const f = sessionFile("2026-11-17T00-00-06-000Z_sess-shape");
    const now = new Date("2026-11-17T01:02:03.000Z");
    const payload = collectSessionBundle(f, { now: () => now });
    expect(payload.format).toBe(BUNDLE_FORMAT);
    expect(payload.version).toBe(BUNDLE_VERSION);
    expect(payload.exportedAt).toBe("2026-11-17T01:02:03.000Z");
    // 固定时钟 ⇒ 载荷逐字节可复现（不含时间漂移）
    expect(JSON.stringify(collectSessionBundle(f, { now: () => now }))).toBe(JSON.stringify(payload));
  });
});

describe("凭据与本机状态不入包", () => {
  it(".storage.json 本体不入包，只留 profile 引用名；凭据值/桶名 anywhere 不出现", () => {
    const f = sessionFile("2026-11-17T00-00-07-000Z_sess-storage");
    saveCanvas(f, [], []);
    writeFileSync(
      storageBindingPathFor(f),
      JSON.stringify({ version: 1, backend: "s3", profile: FAKE_PROFILE, canvasId: "c-1", updatedAt: "2026-11-17T00:00:00.000Z" }),
    );
    // profiles 文件里有假凭据与桶名：任何情况下都不得进包
    writeFileSync(
      join(process.cwd(), ".govio", "storage-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { [FAKE_PROFILE]: { region: "us-east-1", bucket: FAKE_BUCKET, accessKeyIdEnv: "GOVIO_T36_AK", secretAccessKeyEnv: "GOVIO_T36_SK" } },
      }),
    );
    process.env.GOVIO_T36_AK = FAKE_AK;
    process.env.GOVIO_T36_SK = FAKE_SK;
    try {
      const payload = collectSessionBundle(f);
      expect(payload.storageProfile).toBe(FAKE_PROFILE);
      expect(payload.files.map((e) => e.path)).not.toContain(".storage.json");
      const everything = JSON.stringify(payload) + payload.files.map((e) => decode(e).toString("utf-8")).join("\n");
      expect(everything).not.toContain(FAKE_AK);
      expect(everything).not.toContain(FAKE_SK);
      expect(everything).not.toContain(FAKE_BUCKET);
      expect(everything).not.toContain("us-east-1");
      // profile 引用名本身允许出现（它就是给接收方的可追溯线索）
      expect(everything).toContain(FAKE_PROFILE);
    } finally {
      delete process.env.GOVIO_T36_AK;
      delete process.env.GOVIO_T36_SK;
    }
  });

  it("无存储绑定时 storageProfile 键缺省（不写 null、不写空串）", () => {
    const f = sessionFile("2026-11-17T00-00-08-000Z_sess-nobinding");
    saveCanvas(f, [], []);
    const payload = collectSessionBundle(f);
    expect("storageProfile" in payload).toBe(false);
  });

  it("分享开关 sidecar 与旧格式孤儿 .injection.zip 不入包", () => {
    const f = sessionFile("2026-11-17T00-00-09-000Z_sess-local-only");
    saveCanvas(f, [], []);
    writeFileSync(shareStatePathFor(f), JSON.stringify({ version: 1, enabled: true, enabledAt: "2026-11-17T00:00:00.000Z", token: "a".repeat(32) }));
    writeFileSync(f.replace(/\.jsonl$/, ".injection.zip"), "LEGACY-ORPHAN-MARKER");
    const payload = collectSessionBundle(f);
    const everything = JSON.stringify(payload) + payload.files.map((e) => decode(e).toString("utf-8")).join("\n");
    expect(everything).not.toContain("LEGACY-ORPHAN-MARKER");
    expect(payload.files.some((e) => e.path.endsWith(".share.json") || e.path.endsWith(".injection.zip"))).toBe(false);
    // 分享开关是「本机运行态」：包里既不含它，也不会因为开着分享而多出任何文件
    expect(payload.files.map((e) => e.path)).toEqual([BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_MANIFESTS_PATH]);
  });
});

describe("大数据排除记账（parquet 不入包但必须写明缺什么）", () => {
  it("画布引用的 parquet：存在的计 count/bytes/names，不存在的进 absent", () => {
    const f = sessionFile("2026-11-17T00-00-10-000Z_sess-parquet");
    saveCanvas(f, [dfNode("gov-1", "df_present"), dfNode("gov-2", "df_absent")], []);
    mkdirSync(dataframeParquetDir(), { recursive: true });
    const parquetBytes = Buffer.alloc(2048, 7);
    writeFileSync(join(dataframeParquetDir(), "df_present.parquet"), parquetBytes);

    const excluded = collectSessionBundle(f).excluded.parquet;
    expect(excluded.count).toBe(1);
    expect(excluded.bytes).toBe(2048);
    expect(excluded.names).toEqual(["df_present.parquet"]);
    expect(excluded.absent).toEqual(["df_absent"]);
    // parquet 本体绝不在包里
    expect(collectSessionBundle(f).files.some((e) => e.path.endsWith(".parquet"))).toBe(false);
  });

  it("excludedParquetOf 是纯函数：去重、排序、非法 dfName 不触盘只记 absent", () => {
    expect(excludedParquetOf([])).toEqual({ count: 0, bytes: 0, names: [], absent: [] });
    const nodes = [dfNode("a", "df_dup"), dfNode("b", "df_dup"), dfNode("c", "../escape")];
    const out = excludedParquetOf(nodes);
    expect(out.absent.sort()).toEqual(["../escape", "df_dup"].sort());
    expect(out.count).toBe(0);
    // 非法名字不得被解析成任何磁盘路径（防穿越）：目录里没被创建过任何东西
    expect(existsSync(join(process.cwd(), ".govio", "observe", "dataframes"))).toBe(false);
  });

  it("dfName 缺失/非字符串时不记账、不抛错", () => {
    const nodes = [
      { id: "n1", type: "sqlQuery", data: { manifest: { sql: "SELECT 1" } } },
      { id: "n2", type: "dataFrame", data: { dfName: 42 } },
      { id: "n3", type: "dataFrame", data: {} },
    ];
    expect(excludedParquetOf(nodes)).toEqual({ count: 0, bytes: 0, names: [], absent: [] });
  });
});

describe("安全边界", () => {
  it("目录穿越 / 越界路径 / 非 .jsonl 一律被拒（assertValidSessionPath 同款纪律）", () => {
    const sessionsDir = join(process.cwd(), ".govio", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(process.cwd(), ".govio", "evil.jsonl"), "SECRET-MARKER");
    for (const bad of [
      join(sessionsDir, "..", "..", "evil.jsonl"),
      join(process.cwd(), ".govio", "evil.jsonl"),
      join(sessionsDir, "not-a-session.txt"),
      "../../etc/passwd",
    ]) {
      expect(() => collectSessionBundle(bad), `${bad} 应被拒`).toThrow(/invalid session path/);
    }
  });

  it("路径合法但文件不存在 → BundleSessionNotFoundError", () => {
    const sessionsDir = join(process.cwd(), ".govio", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const ghost = join(sessionsDir, "2026-11-17T00-00-11-000Z_ghost.jsonl");
    expect(() => collectSessionBundle(ghost)).toThrowError(/session file not found/);
  });

  it("总量超限抛 BundleTooLargeError（带 bytes/limitBytes/path，供前端给明确提示）", () => {
    const f = sessionFile("2026-11-17T00-00-12-000Z_sess-big", "x".repeat(64));
    expect(() => collectSessionBundle(f, { maxTotalBytes: 16 })).toThrowError(BundleTooLargeError);
    try {
      collectSessionBundle(f, { maxTotalBytes: 16 });
      throw new Error("应当抛出 BundleTooLargeError");
    } catch (err) {
      const e = err as BundleTooLargeError;
      expect(e.name).toBe("BundleTooLargeError");
      expect(e.limitBytes).toBe(16);
      expect(e.bytes).toBe(64);
      expect(e.path).toBe(BUNDLE_SESSION_PATH);
    }
    // 默认上限是常量（前端提示与文档都引它）
    expect(MAX_BUNDLE_TOTAL_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("HTTP 路由 GET /api/session-bundle", () => {
  it("无活动会话 → 409（与既有 /api/share-state 纪律一致）", async () => {
    const res = await callApi("GET", "/api/session-bundle");
    expect(res.handled).toBe(true);
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({ error: "session bundle requires an active session" });
  });

  it("当前会话 → 200 + no-store + JSON，载荷与直接调用 collectSessionBundle 一致", async () => {
    const f = sessionFile("2026-11-17T00-00-13-000Z_sess-current");
    saveCanvas(f, [dfNode("gov-1", "df_x")], []);
    agentStub.sessionFile = f;

    const res = await callApi("GET", "/api/session-bundle");
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = res.json() as unknown as ReturnType<typeof collectSessionBundle>;
    expect(body.format).toBe(BUNDLE_FORMAT);
    expect(body.token).toBe(deriveShareToken("2026-11-17T00-00-13-000Z_sess-current"));
    expect(body.files.map((e) => e.path)).toEqual([BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_MANIFESTS_PATH]);
  });

  it("?session=<合法路径> → 200，导出的是指定会话（历史会话导出能力）", async () => {
    const f = sessionFile("2026-11-17T00-00-14-000Z_sess-explicit");
    saveCanvas(f, [], []);
    const res = await callApi("GET", `/api/session-bundle?session=${encodeURIComponent(f)}`);
    expect(res.status).toBe(200);
    const body = res.json() as unknown as { sessionId: string; token: string };
    expect(body.sessionId).toBe("2026-11-17T00-00-14-000Z_sess-explicit");
    expect(body.token).toBe(deriveShareToken(body.sessionId));
  });

  it("?session= 越界路径 → 400 invalid-session-path（不泄露存在性）", async () => {
    for (const bad of ["../../evil.jsonl", "/etc/passwd", join(process.cwd(), ".govio", "evil.jsonl")]) {
      const res = await callApi("GET", `/api/session-bundle?session=${encodeURIComponent(bad)}`);
      expect(res.status, `${bad} 应 400`).toBe(400);
      expect(res.json()).toEqual({ error: "invalid-session-path" });
    }
  });

  it("?session= 合法但不存在 → 404 session-not-found", async () => {
    const dir = join(process.cwd(), ".govio", "sessions");
    mkdirSync(dir, { recursive: true });
    const ghost = join(dir, "2026-11-17T00-00-15-000Z_ghost.jsonl");
    const res = await callApi("GET", `/api/session-bundle?session=${encodeURIComponent(ghost)}`);
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: "session-not-found" });
  });

  it("非 GET → 405；未知路径 → 不接管（handled=false，落到 backend 兜底）", async () => {
    const f = sessionFile("2026-11-17T00-00-16-000Z_sess-method");
    agentStub.sessionFile = f;
    expect((await callApi("POST", "/api/session-bundle")).status).toBe(405);
    expect((await callApi("DELETE", "/api/session-bundle")).status).toBe(405);
    const other = await callApi("GET", "/api/session-bundles");
    expect(other.handled).toBe(false);
    expect(other.status).toBe(0);
  });

  it("CORS 面未因本路由扩大：本地 Origin 被回显，方法白名单仍是 T3.5 那份", async () => {
    const f = sessionFile("2026-11-17T00-00-17-000Z_sess-cors");
    agentStub.sessionFile = f;
    const res = await callApi("GET", "/api/session-bundle", { origin: "http://localhost:5173" });
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(res.headers["Access-Control-Allow-Headers"]).toBe("Content-Type, If-None-Match");
    // 非白名单 Origin 不回显（沿用 security.ts 既有行为）
    const evil = await callApi("GET", "/api/session-bundle", { origin: "http://evil.example.com" });
    expect(evil.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("畸形 URL 不炸进程：交给兜底 404", async () => {
    const res = await callApi("GET", "///");
    expect(res.handled).toBe(false);
  });
});
