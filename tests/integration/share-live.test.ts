/**
 * T3.5 只读分享「活视图」集成测试（tmp cwd 隔离，不触真实 .govio/）。
 *
 * 取代 T3.2 的 share-fork.test.ts（快照语义已废弃，见 docs/tasks/T3.5-live-share-view/design.md）：
 *  - token：由会话指纹派生、32-hex、同一会话恒定；开关 sidecar 幂等开启 / 删除即撤销
 *  - 活视图：GET 返回**当前**画布（源改动后立即可见），不再产生 .govio/shares/ 快照
 *  - ETag：内容 hash；If-None-Match 命中 → 304（轮询不重渲染的服务端契约）
 *  - 只读纪律：GET/fork 不改源画布 sidecar；复跑路由已删除；载荷与 sidecar 不含凭据
 *  - fork：从当前活画布暂存 + forkFrom 血缘（含链式传承、抗 autosave，两条 T3.2 断言不回退）
 *  - deleteSession 级联删除开关 sidecar（会话删了分享必须一并失效）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// handleShareApi 的「当前活动会话」来自 pi AgentSession；测试用替身注入会话文件路径。
const agentStub = vi.hoisted(() => ({ sessionFile: null as string | null }));
vi.mock("../../server/agent.js", () => ({
  getSession: () => (agentStub.sessionFile ? { sessionManager: { getSessionFile: () => agentStub.sessionFile } } : null),
}));

import { saveCanvas, loadCanvas, deleteSession } from "../../server/session-history.js";
import { localEtag } from "../../server/storage/local-backend.js";
import { shareStatePathFor } from "../../server/storage/paths.js";
import { handleShareApi } from "../../server/share-api.js";
import {
  SHARE_ID_RE,
  SHARE_STATE_VERSION,
  SHARE_TOKEN_DOMAIN,
  clearShareIndexCache,
  deriveShareToken,
  disableShare,
  enableShare,
  forkShare,
  ifNoneMatchHits,
  liveShareEtag,
  liveShareView,
  readShareState,
  readStagedFork,
  consumeStagedFork,
  resolveShareToken,
  shareStateOf,
} from "../../server/share.js";

/** main.tsx 的分享路由正则——token 形状必须继续被它匹配，否则渲染主应用而不是 ShareView */
const SHARE_ROUTE = /^\/share\/([a-f0-9]{32})\/?$/;

const tmpDirs: string[] = [];
let prevCwd = "";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "govio-t35-share-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".govio"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(dir);
  agentStub.sessionFile = null;
  clearShareIndexCache();
});

afterEach(() => {
  agentStub.sessionFile = null;
  clearShareIndexCache();
  process.chdir(prevCwd);
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 建一个真实存在的会话文件（token 解析靠枚举 sessions 目录里的 .jsonl）。 */
function sessionFile(name: string): string {
  const dir = join(process.cwd(), ".govio", "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.jsonl`);
  if (!existsSync(f)) writeFileSync(f, "");
  return f;
}

function manifestNode(id = "gov-7", extra: Record<string, unknown> = {}) {
  return {
    id,
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
  const handled = await handleShareApi(req, res as unknown as ServerResponse);
  return {
    handled,
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    json: () => (res.body ? (JSON.parse(res.body) as Record<string, never>) : null),
  };
}

describe("token 派生与分享开关 sidecar", () => {
  it("token = sha256(域前缀+sessionId) 前 32 位小写 hex，形状兼容既有路由正则", () => {
    const sessionId = "2026-11-15T09-30-00-000Z_ab12cd34";
    const token = deriveShareToken(sessionId);
    expect(SHARE_ID_RE.test(token)).toBe(true);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    expect(SHARE_ROUTE.exec(`/share/${token}`)?.[1]).toBe(token);
    // 域分隔：把已带前缀的串再派生一次结果不同（前缀真的参与了 hash）
    expect(deriveShareToken(`${SHARE_TOKEN_DOMAIN}${sessionId}`)).not.toBe(token);
    // 派生是纯函数：同一 sessionId 恒定，不同 sessionId 不同
    expect(deriveShareToken(sessionId)).toBe(token);
    expect(deriveShareToken(`${sessionId}-other`)).not.toBe(token);
  });

  it("开关默认关：无 sidecar 即未开启，其派生 token 不可解析（开关就是访问控制）", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-default-off");
    saveCanvas(f, [manifestNode()], []);
    expect(existsSync(shareStatePathFor(f))).toBe(false);
    const state = shareStateOf(f);
    expect(state.enabled).toBe(false);
    expect(state.token).toBe(deriveShareToken("2026-11-15T09-30-00-000Z_sess-default-off"));
    expect(resolveShareToken(state.token)).toBeNull();
    expect(liveShareView(state.token)).toBeNull();
  });

  it("开启幂等：重复开启返回同一 token（链接恒定），sidecar 形状固定", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-enable");
    saveCanvas(f, [manifestNode()], []);
    const first = enableShare(f);
    const second = enableShare(f);
    expect(first.enabled).toBe(true);
    expect(second.token).toBe(first.token);
    expect(second.enabledAt).toBe(first.enabledAt);
    const raw = JSON.parse(readFileSync(shareStatePathFor(f), "utf-8"));
    expect(raw).toEqual({ version: SHARE_STATE_VERSION, enabled: true, enabledAt: first.enabledAt, token: first.token });
    expect(readShareState(f)?.token).toBe(first.token);
    expect(resolveShareToken(first.token)?.sessionFile).toBe(f);
  });

  it("撤销即失效：删 sidecar → token 解析不到；重新开启得到同一 token（链接可恢复）", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-revoke");
    saveCanvas(f, [manifestNode()], []);
    const token = enableShare(f).token;
    expect(liveShareView(token)).not.toBeNull();

    const off = disableShare(f);
    expect(off.enabled).toBe(false);
    expect(existsSync(shareStatePathFor(f))).toBe(false);
    expect(resolveShareToken(token)).toBeNull();
    expect(liveShareView(token)).toBeNull();
    expect(disableShare(f).enabled).toBe(false); // 幂等：已关闭再关不抛错

    expect(enableShare(f).token).toBe(token);
    expect(liveShareView(token)).not.toBeNull();
  });

  it("旧快照时代的随机 token 与非法形状一律解析不到（旧链接失效 → 404）", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-legacy");
    saveCanvas(f, [manifestNode()], []);
    enableShare(f);
    expect(resolveShareToken("6d6aa27396782536ecad2be1a3ac5597")).toBeNull(); // 用户实测的旧 shareId
    expect(resolveShareToken("0000000000000000000000000000dead")).toBeNull();
    expect(resolveShareToken("not-a-token")).toBeNull();
    expect(resolveShareToken("")).toBeNull();
    expect(resolveShareToken("../sessions/x")).toBeNull();
  });

  it("坏 sidecar（脏 JSON / 版本不符 / enabled:false）视为未开启", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-bad-sidecar");
    saveCanvas(f, [manifestNode()], []);
    const token = deriveShareToken("2026-11-15T09-30-00-000Z_sess-bad-sidecar");
    writeFileSync(shareStatePathFor(f), "{bad json");
    expect(readShareState(f)).toBeNull();
    expect(resolveShareToken(token)).toBeNull();
    writeFileSync(shareStatePathFor(f), JSON.stringify({ version: 99, enabled: true, token }));
    expect(readShareState(f)).toBeNull();
    expect(resolveShareToken(token)).toBeNull();
    writeFileSync(shareStatePathFor(f), JSON.stringify({ version: SHARE_STATE_VERSION, enabled: false, enabledAt: null, token }));
    expect(readShareState(f)?.enabled).toBe(false);
    expect(resolveShareToken(token)).toBeNull();
  });

  it("deleteSession 级联删除开关 sidecar：会话删了分享一并失效", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-cascade");
    saveCanvas(f, [manifestNode()], []);
    const token = enableShare(f).token;
    expect(existsSync(shareStatePathFor(f))).toBe(true);
    deleteSession(f);
    expect(existsSync(shareStatePathFor(f))).toBe(false);
    expect(existsSync(f)).toBe(false);
    expect(resolveShareToken(token)).toBeNull();
  });
});

describe("活视图：GET 返回当前画布（不是快照）", () => {
  it("源画布新增节点后，同一 token 的载荷立即含新节点；不产生任何 .govio/shares/ 快照", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-live");
    saveCanvas(f, [manifestNode("gov-1")], [{ id: "e1", source: "gov-1", target: "gov-2" }]);
    const token = enableShare(f).token;

    const before = liveShareView(token)!;
    expect(before.record.canvas.nodes).toHaveLength(1);
    expect(before.record.manifests).toHaveLength(1);
    expect(before.record.manifests[0].manifest.sql).toBe("SELECT 1");
    expect(before.record.token).toBe(token);
    expect(before.record.canvasId).toBe("2026-11-15T09-30-00-000Z_sess-live");
    expect(before.record.version).toBe(1);

    // 源画布长出新节点（模拟 AI 又跑了一次取数）：链接不变，内容变新
    saveCanvas(f, [manifestNode("gov-1"), manifestNode("gov-2", { dfName: "df_new", title: "df_new" })], []);
    const after = liveShareView(token)!;
    expect(after.record.canvas.nodes).toHaveLength(2);
    expect(after.record.manifests.map((m) => m.nodeId)).toEqual(["gov-1", "gov-2"]);
    // 快照机制已废弃：整个 .govio/shares/ 目录都不该出现
    expect(existsSync(join(".govio", "shares"))).toBe(false);
  });

  it("etag 随画布内容变化；内容不变则 etag 恒定（304 的判等依据）", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-etag");
    saveCanvas(f, [manifestNode()], []);
    const token = enableShare(f).token;
    const e1 = liveShareView(token)!.etag;
    expect(liveShareView(token)!.etag).toBe(e1);
    expect(liveShareEtag(JSON.stringify(liveShareView(token)!.record.canvas))).toBe(e1);
    saveCanvas(f, [manifestNode(), { id: "gov-9", type: "chart", data: { type: "chart" } }], []);
    expect(liveShareView(token)!.etag).not.toBe(e1);
  });

  it("ifNoneMatchHits：引号 / W 弱校验 / 多值 / * / 脏头", () => {
    const etag = "abc123";
    expect(ifNoneMatchHits(`"${etag}"`, etag)).toBe(true);
    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits(`W/"${etag}"`, etag)).toBe(true);
    expect(ifNoneMatchHits(`"other", "${etag}"`, etag)).toBe(true);
    expect(ifNoneMatchHits("*", etag)).toBe(true);
    expect(ifNoneMatchHits(['"nope"', `"${etag}"`], etag)).toBe(true);
    expect(ifNoneMatchHits('"nope"', etag)).toBe(false);
    expect(ifNoneMatchHits(undefined, etag)).toBe(false);
    expect(ifNoneMatchHits("", etag)).toBe(false);
    expect(ifNoneMatchHits(",,", etag)).toBe(false);
  });

  it("画布 sidecar 还没落盘时返回空画布（不是 404）——链接先开、内容随后长出来", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-empty");
    const token = enableShare(f).token;
    const view = liveShareView(token)!;
    expect(view.record.canvas).toEqual({ nodes: [], edges: [] });
    expect(view.record.manifests).toEqual([]);
  });

  it("只读纪律：活视图 GET / fork 前后源画布 sidecar 字节与 etag 恒定", () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-readonly");
    saveCanvas(f, [manifestNode()], [{ id: "e1" }]);
    const token = enableShare(f).token;
    const before = readFileSync(f + ".canvas.json", "utf-8");
    liveShareView(token);
    forkShare(token);
    expect(readFileSync(f + ".canvas.json", "utf-8")).toBe(before);
    expect(localEtag(readFileSync(f + ".canvas.json", "utf-8"))).toBe(localEtag(before));
    expect(loadCanvas(f)?.nodes).toEqual([manifestNode()]);
  });

  it("凭据与后端拓扑不外泄：活视图载荷与开关 sidecar 都不含 profile 名/凭据值", () => {
    // 夹具用的是**故意假**的凭据值，且刻意不带任何真实凭据的已知前缀形态——
    // 否则仓库密钥扫描（GitGuardian）会把这行反向断言的夹具误报成真泄漏。
    // 断言意图不变：这两个值（以及 profile 名 / "profile" 字样）绝不能出现在任何分享产物里。
    const FAKE_AK = "TEST-ONLY-AK-1234";
    const FAKE_SK = "TEST-ONLY-SK-1234";
    process.env.GOVIO_T35_AK = FAKE_AK;
    process.env.GOVIO_T35_SK = FAKE_SK;
    const profilesPath = join(".govio", "storage-profiles.json");
    writeFileSync(profilesPath, JSON.stringify({
      version: 1,
      profiles: { t35: { region: "us-east-1", bucket: "govio-test", prefix: "p", accessKeyIdEnv: "GOVIO_T35_AK", secretAccessKeyEnv: "GOVIO_T35_SK" } },
    }));
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-cred");
    saveCanvas(f, [manifestNode()], []);
    const token = enableShare(f).token;
    const view = JSON.stringify(liveShareView(token)!.record);
    const sidecar = readFileSync(shareStatePathFor(f), "utf-8");
    for (const artifact of [view, sidecar]) {
      expect(artifact).not.toContain(FAKE_AK);
      expect(artifact).not.toContain(FAKE_SK);
      expect(artifact).not.toContain("t35");
      expect(artifact).not.toContain("profile");
    }
    delete process.env.GOVIO_T35_AK;
    delete process.env.GOVIO_T35_SK;
  });
});

describe("HTTP 路由：开关 / 活视图 / 304 / 复跑已删除", () => {
  it("GET /api/share-state：无活动会话 409；有会话返回 {enabled, token}", async () => {
    const off = await callApi("GET", "/api/share-state");
    expect(off.status).toBe(409);

    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-state-api");
    saveCanvas(f, [manifestNode()], []);
    agentStub.sessionFile = f;
    const before = await callApi("GET", "/api/share-state");
    expect(before.json()).toEqual({
      enabled: false,
      token: deriveShareToken("2026-11-15T09-30-00-000Z_sess-state-api"),
      enabledAt: null,
    });

    enableShare(f);
    const after = await callApi("GET", "/api/share-state");
    expect(after.json()?.enabled).toBe(true);
    expect(after.json()?.token).toBe(before.json()?.token);
  });

  it("POST /api/shares 开启（幂等）→ 同一 token、同一 url；DELETE 撤销 → 随后 GET 404", async () => {
    const noSession = await callApi("POST", "/api/shares");
    expect(noSession.status).toBe(409);

    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-toggle-api");
    saveCanvas(f, [manifestNode()], []);
    agentStub.sessionFile = f;

    const first = await callApi("POST", "/api/shares");
    const second = await callApi("POST", "/api/shares");
    expect(first.status).toBe(200);
    expect(first.json()?.enabled).toBe(true);
    expect(second.json()?.token).toBe(first.json()?.token);
    expect(first.json()?.url).toBe(`/share/${first.json()?.token}`);

    const token = first.json()?.token as string;
    const ok = await callApi("GET", `/api/shares/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.json()?.readonly).toBe(true);
    expect((ok.json()?.canvas as { nodes: unknown[] }).nodes).toHaveLength(1);

    const off = await callApi("DELETE", "/api/shares");
    expect(off.json()).toEqual({ enabled: false, token });
    expect((await callApi("DELETE", "/api/shares")).status).toBe(200); // 幂等

    const gone = await callApi("GET", `/api/shares/${token}`);
    expect(gone.status).toBe(404);
    expect(gone.json()).toEqual({ error: "share-not-found" });
  });

  it("GET /api/shares/<token> 带 ETag；If-None-Match 命中 → 304 无 body；未开启 → 404", async () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-etag-api");
    saveCanvas(f, [manifestNode()], []);
    agentStub.sessionFile = f;
    const token = (await callApi("POST", "/api/shares")).json()?.token as string;

    const first = await callApi("GET", `/api/shares/${token}`);
    const etag = first.headers.ETag as string;
    expect(etag).toBe(`"${first.json()?.etag}"`);
    expect(first.headers["Cache-Control"]).toBe("no-store");

    const cached = await callApi("GET", `/api/shares/${token}`, { "if-none-match": etag });
    expect(cached.status).toBe(304);
    expect(cached.body).toBe("");
    expect(cached.headers.ETag).toBe(etag);

    // 源画布变了 → 同一 If-None-Match 不再命中，回 200 与新 etag
    saveCanvas(f, [manifestNode(), { id: "gov-9", type: "chart", data: { type: "chart" } }], []);
    const changed = await callApi("GET", `/api/shares/${token}`, { "if-none-match": etag });
    expect(changed.status).toBe(200);
    expect(changed.json()?.etag).not.toBe(first.json()?.etag);
    expect((changed.json()?.canvas as { nodes: unknown[] }).nodes).toHaveLength(2);

    expect((await callApi("GET", "/api/shares/6d6aa27396782536ecad2be1a3ac5597")).status).toBe(404);
    expect((await callApi("GET", "/api/shares/zzz")).json()).toEqual({ error: "share-not-found" });
  });

  it("POST /api/shares/<token>/rerun 路由已删除（不再被 share API 接管）", async () => {
    const f = sessionFile("2026-11-15T09-30-00-000Z_sess-no-rerun");
    saveCanvas(f, [manifestNode()], []);
    agentStub.sessionFile = f;
    const token = (await callApi("POST", "/api/shares")).json()?.token as string;

    const rerun = await callApi("POST", `/api/shares/${token}/rerun`);
    expect(rerun.handled).toBe(false); // 落到 backend.ts 的 404 兜底，路由不复存在
    expect(rerun.status).toBe(0);
    // fork 仍在
    expect((await callApi("POST", `/api/shares/${token}/fork`)).status).toBe(201);
    // 其它方法不被允许
    expect((await callApi("PUT", `/api/shares/${token}`)).status).toBe(405);
    expect((await callApi("DELETE", `/api/shares/${token}`)).status).toBe(405);
  });

  it("跨源预检：CORS 放行 DELETE 与 If-None-Match，并暴露 ETag 响应头", async () => {
    const res = await callApi("GET", "/api/share-state", { origin: "http://localhost:5173" });
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("DELETE");
    expect(res.headers["Access-Control-Allow-Headers"]).toContain("If-None-Match");
    expect(res.headers["Access-Control-Expose-Headers"]).toBe("ETag");
  });
});

describe("fork 续写与派生血缘（活画布版）", () => {
  it("forkShare 从**当前**活画布暂存 → forkFrom 落新画布 canvas.json 顶层", () => {
    const src = sessionFile("2026-11-15T09-30-00-000Z_sess-fork-src");
    saveCanvas(src, [manifestNode()], [{ id: "e1" }]);
    const token = enableShare(src).token;
    // fork 前源画布又长了节点：fork 必须拿到最新内容，而不是开启分享那一刻的内容
    saveCanvas(src, [manifestNode(), manifestNode("gov-8")], [{ id: "e1" }]);

    const forked = forkShare(token);
    expect(forked).not.toBeNull();
    expect(SHARE_ID_RE.test(forked!.forkId)).toBe(true);
    expect(forked!.shareId).toBe(token);
    expect(forked!.canvas.nodes).toHaveLength(2);

    const staged = readStagedFork(forked!.forkId);
    expect(staged?.forkFrom.shareId).toBe(token);
    expect(staged?.forkFrom.kind).toBe("share");
    expect(staged?.forkFrom.canvasId).toBe("2026-11-15T09-30-00-000Z_sess-fork-src");
    expect(staged?.forkFrom.forkedAt).toBeTruthy();
    expect(staged?.canvas.nodes).toEqual(forked!.canvas.nodes);

    const dst = sessionFile("2026-11-15T09-30-00-000Z_sess-fork-dst");
    saveCanvas(dst, staged!.canvas.nodes, staged!.canvas.edges, { forkFrom: staged!.forkFrom });
    const raw = JSON.parse(readFileSync(dst + ".canvas.json", "utf-8"));
    expect(raw.forkFrom.shareId).toBe(token);
    expect(raw.forkFrom.canvasId).toBe("2026-11-15T09-30-00-000Z_sess-fork-src");
    expect(consumeStagedFork(staged!.forkId)).toBe(true);
    expect(readStagedFork(staged!.forkId)).toBeNull();
    expect(readStagedFork("not-a-fork-id")).toBeNull();
  });

  it("血缘抗 autosave：后续无 meta 的 saveCanvas（1s debounce 快照）保留 forkFrom", () => {
    const src = sessionFile("2026-11-15T09-30-00-000Z_sess-fork-src2");
    saveCanvas(src, [manifestNode()], []);
    const token = enableShare(src).token;
    const staged = readStagedFork(forkShare(token)!.forkId)!;
    const dst = sessionFile("2026-11-15T09-30-00-000Z_sess-fork-dst2");
    saveCanvas(dst, staged.canvas.nodes, staged.canvas.edges, { forkFrom: staged.forkFrom });
    saveCanvas(dst, [{ id: "changed" }], []); // 模拟前端 autosave（不带 meta）
    expect(loadCanvas(dst)?.nodes).toEqual([{ id: "changed" }]);
    expect(JSON.parse(readFileSync(dst + ".canvas.json", "utf-8")).forkFrom.shareId).toBe(token);
  });

  it("派生画布再分享：活视图载荷继承 forkFrom（血缘链可追溯）；未知/已撤销 token fork → null", () => {
    const src = sessionFile("2026-11-15T09-30-00-000Z_sess-chain-src");
    saveCanvas(src, [manifestNode()], []);
    const token1 = enableShare(src).token;
    const staged = readStagedFork(forkShare(token1)!.forkId)!;
    const dst = sessionFile("2026-11-15T09-30-00-000Z_sess-chain-dst");
    saveCanvas(dst, staged.canvas.nodes, staged.canvas.edges, { forkFrom: staged.forkFrom });
    const token2 = enableShare(dst).token;
    expect(token2).not.toBe(token1);
    const view = liveShareView(token2)!.record;
    expect(view.forkFrom?.shareId).toBe(token1);
    expect(view.forkFrom?.canvasId).toBe("2026-11-15T09-30-00-000Z_sess-chain-src");

    expect(forkShare("0000000000000000000000000000beef")).toBeNull();
    const revoked = disableShare(dst).token;
    expect(forkShare(revoked)).toBeNull();
  });
});
