/**
 * T3.7 session 打包**导入**集成测试（tmp cwd 隔离，不触真实 `.govio/`）。
 *
 * 覆盖四组契约：
 *  1. **往返一致性**：用 T3.6 的真实产物（`collectSessionBundle` + `exportSessionBundle`）
 *     走一遍导入，画布 nodes/edges/Manifest、审计与注入留痕逐项与源一致；transcript
 *     除 header 一行外**逐字节不变**。
 *  2. **原子性（decisions ④）**：每一条拒绝路径都断言「sessions 目录零文件写入」。
 *  3. **安全（decisions ⑤ + 口径 ⑥）**：读侧六道校验、zip 元数据闸门（先判后解压）、
 *     zip-slip 样本、清单外夹带条目、超限、不覆盖既有会话、写盘失败回滚。
 *  4. **HTTP 面**：`POST /api/session-import` 的状态码/错误码映射、跨源预检 204、
 *     响应不回显包内容。
 *
 * 包文件刻意放在 `.govio/sessions/` **之外**（`<tmp>/incoming/`）——用户裁决 ⑤（C3=b）：
 * 读侧可任意路径，写侧才严格限定 sessions 目录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Node } from "@xyflow/react";

// 「当前活动会话」来自 pi AgentSession；本文件的 HTTP 用例不需要它，但 bundle-api 会 import。
const agentStub = vi.hoisted(() => ({ sessionFile: null as string | null }));
vi.mock("../../server/agent.js", () => ({
  getSession: () => (agentStub.sessionFile ? { sessionManager: { getSessionFile: () => agentStub.sessionFile } } : null),
}));

import { deleteSession, listSessions, loadCanvas, saveCanvas } from "../../server/session-history.js";
import { auditPathFor } from "../../server/permission-audit.js";
import { injectionTracePathFor } from "../../server/prompt-injection.js";
import { canvasPathFor, importMetaPathFor, storageBindingPathFor } from "../../server/storage/paths.js";
import { collectSessionBundle } from "../../server/session-bundle.js";
import {
  BundleImportError,
  assertBundleEntryLimits,
  importSessionBundle,
  inspectBundleEntries,
  newSessionFileName,
  parseBundleManifest,
  readImportMeta,
  resolveBundlePath,
  rewriteTranscriptHeader,
} from "../../server/session-import.js";
import { importStatusFor, handleBundleApi } from "../../server/bundle-api.js";
import { exportSessionBundle } from "../../src/commands/export-session";
import {
  SessionImportError,
  describeImportResult,
  importSessionBundle as importSessionBundleFront,
} from "../../src/commands/import-session";
import {
  BUNDLE_AUDIT_PATH,
  BUNDLE_CANVAS_PATH,
  BUNDLE_FORMAT,
  BUNDLE_INJECTION_PATH,
  BUNDLE_MANIFEST_PATH,
  BUNDLE_MANIFESTS_PATH,
  BUNDLE_REPORT_PATH,
  BUNDLE_SESSION_PATH,
  BUNDLE_VERSION,
  IMPORT_ERROR_CODES,
  bundleFileName,
  isSafeBundlePath,
  type BundleManifest,
  type ImportErrorCode,
} from "../../src/types/bundle";

/** 夹具假凭据：不带任何真实凭据的已知前缀形态（GitGuardian 误报教训，见 T3.5/T3.6）。 */
const FAKE_PROFILE = "TEST-ONLY-PROFILE";
const FAKE_AK = "TEST-ONLY-AK-7777";
const FAKE_SK = "TEST-ONLY-SK-7777";
const FAKE_BUCKET = "test-only-bucket-do-not-leak";
const REPORT_HTML = "<!DOCTYPE html><html><body>TEST-ONLY-REPORT</body></html>";
/** 只出现在包内容里的哨兵串：断言 HTTP 响应/错误信息绝不回显包内容。 */
const SENTINEL = "TEST-ONLY-SENTINEL-DO-NOT-ECHO";

const FIXED_NOW = new Date("2026-11-17T05:06:07.000Z");

const tmpDirs: string[] = [];
let prevCwd = "";
let root = "";
let incoming = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "govio-t37-import-"));
  tmpDirs.push(root);
  mkdirSync(join(root, ".govio"), { recursive: true });
  incoming = join(root, "incoming");
  mkdirSync(incoming, { recursive: true });
  prevCwd = process.cwd();
  process.chdir(root);
  agentStub.sessionFile = null;
});

afterEach(() => {
  agentStub.sessionFile = null;
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ── 夹具 ──────────────────────────────────────────────────────────────────

function sessionsDir(): string {
  return join(process.cwd(), ".govio", "sessions");
}

/** sessions 目录快照（原子性断言用：拒绝路径前后必须完全一致）。 */
function snapshotSessions(): string[] {
  const dir = sessionsDir();
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dfNode(id: string, dfName: string): Node {
  return {
    id,
    type: "dataFrame",
    position: { x: 0, y: 0 },
    data: {
      type: "dataFrame",
      title: dfName,
      dfName,
      columns: [{ name: "amount", dtype: "float64", nonNull: 3 }],
      previewData: [],
      totalRows: 3,
      manifest: {
        schemaVersion: 1,
        origin: "sql-editor",
        sql: `SELECT 1 -- ${SENTINEL}`,
        datasource: "duck",
        dfName,
        executedAt: "2026-11-17T00:00:00.000Z",
        rowCount: 3,
        columnCount: 1,
        sessionId: "s-src",
      },
    },
  } as unknown as Node;
}

/** 造一个源会话（transcript + 画布 + 两类留痕），返回其文件路径。 */
function makeSourceSession(name = "2026-11-17T04-00-00-000Z_sess-src"): string {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: "01a1bbbb-0000-4000-8000-000000000000",
    timestamp: "2026-11-17T04:00:00.000Z",
    cwd: "D:\\some\\other\\machine\\project",
    parentSession: "D:\\some\\other\\machine\\parent.jsonl",
  };
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: "session_info", id: "n1", parentId: null, timestamp: "2026-11-17T04:00:01.000Z", name: "源会话显示名" }),
    JSON.stringify({ type: "message", id: "n2", parentId: "n1", timestamp: "2026-11-17T04:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "第一句" }] } }),
    JSON.stringify({ type: "message", id: "n3", parentId: "n2", timestamp: "2026-11-17T04:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "第二句" }] } }),
  ];
  writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
}

/** 用 T3.6 的真实链路产出一个包，写到 sessions 目录**之外**，返回路径与清单。 */
async function buildRealBundle(opts: { withCanvas?: boolean; withSidecars?: boolean; forkFrom?: unknown } = {}): Promise<{
  path: string;
  manifest: BundleManifest;
  sourceFile: string;
  zip: Uint8Array;
}> {
  const withCanvas = opts.withCanvas ?? true;
  const withSidecars = opts.withSidecars ?? true;
  const sourceFile = makeSourceSession();
  if (withCanvas) {
    saveCanvas(
      sourceFile,
      [dfNode("gov-1", "df_sales"), dfNode("gov-2", "df_orders")],
      [{ id: "e1", source: "gov-1", target: "gov-2" }],
      opts.forkFrom ? { forkFrom: opts.forkFrom } : undefined,
    );
  }
  if (withSidecars) {
    writeFileSync(auditPathFor(sourceFile), `{"type":"permission_decision","decisionId":"pd-1","note":"${SENTINEL}"}\n`);
    writeFileSync(injectionTracePathFor(sourceFile), '{"type":"injection","entities":[]}\n');
  }

  const payload = collectSessionBundle(sourceFile, { now: () => FIXED_NOW });
  const downloads: Array<{ fileName: string; bytes: Uint8Array }> = [];
  await exportSessionBundle({
    pageOrigin: "http://localhost:5173",
    appVersion: "0.7.2",
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch,
    hashBytes: async (bytes) => sha256Hex(bytes),
    download: (fileName, bytes) => downloads.push({ fileName, bytes }),
    buildReport: async () => REPORT_HTML,
  });
  const zip = downloads[0].bytes;
  const out = join(incoming, downloads[0].fileName);
  writeFileSync(out, zip);
  const manifest = JSON.parse(strFromU8(unzipSync(zip)[BUNDLE_MANIFEST_PATH])) as BundleManifest;
  return { path: out, manifest, sourceFile, zip };
}

/** 把包内条目重打成一个 zip（篡改用例用）。 */
function repack(entries: Record<string, string | Uint8Array>, name = "tampered.govio-bundle.zip"): string {
  const zipped: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) zipped[k] = typeof v === "string" ? strToU8(v) : v;
  const out = join(incoming, name);
  writeFileSync(out, zipSync(zipped));
  return out;
}

/** 去掉一个包内条目后重打（篡改用例用）。 */
function withoutEntry(entries: Record<string, Uint8Array>, name: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) if (k !== name) out[k] = v;
  return out;
}

function entriesOf(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip) as Record<string, Uint8Array>;
}

/** 断言「零文件写入」：拒绝前后 sessions 目录内容完全一致。 */
function expectZeroWrite(before: string[], fn: () => unknown, code: ImportErrorCode): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `应以 ${code} 拒绝`).toBeInstanceOf(BundleImportError);
  expect((caught as BundleImportError).code).toBe(code);
  expect(snapshotSessions(), "拒绝路径必须零文件写入").toEqual(before);
}

// ── 1. 往返一致性 ─────────────────────────────────────────────────────────

describe("往返一致性（T3.6 真产物 → T3.7 导入）", () => {
  it("画布 nodes/edges/Manifest 与源逐项一致，审计与注入留痕字节一致", async () => {
    const { path, sourceFile } = await buildRealBundle();
    const before = snapshotSessions();

    const result = importSessionBundle(path, { now: () => FIXED_NOW });

    const importedCanvas = loadCanvas(result.sessionFile)!;
    const sourceCanvas = loadCanvas(sourceFile)!;
    expect(importedCanvas.nodes).toEqual(sourceCanvas.nodes);
    expect(importedCanvas.edges).toEqual(sourceCanvas.edges);
    expect(result.nodeCount).toBe(2);
    expect(result.edgeCount).toBe(1);
    expect(result.manifestCount).toBe(2);
    // Manifest 是固化在节点 data 上的（T1.1），随 canvas.json 原样过来
    const imported = importedCanvas.nodes[0] as unknown as { data: { manifest: { sql: string; dfName: string } } };
    expect(imported.data.manifest.dfName).toBe("df_sales");
    expect(imported.data.manifest.sql).toContain(SENTINEL);

    expect(readFileSync(auditPathFor(result.sessionFile), "utf-8")).toBe(readFileSync(auditPathFor(sourceFile), "utf-8"));
    expect(readFileSync(injectionTracePathFor(result.sessionFile), "utf-8")).toBe(
      readFileSync(injectionTracePathFor(sourceFile), "utf-8"),
    );
    // 源会话本身没被动过（导入是只读消费 + 另写新文件）
    expect(snapshotSessions()).toEqual([...before, ...newFilesOf(result.sessionFile)].sort());
  });

  it("transcript 除 header 一行外逐字节不变；header 只改 id/cwd/parentSession", async () => {
    const { path, sourceFile } = await buildRealBundle();
    const result = importSessionBundle(path, { now: () => FIXED_NOW, newSessionId: () => "01a1cccc-1111-4111-8111-111111111111" });

    const srcLines = readFileSync(sourceFile, "utf-8").split("\n");
    const outLines = readFileSync(result.sessionFile, "utf-8").split("\n");
    expect(outLines.length).toBe(srcLines.length);
    expect(outLines.slice(1)).toEqual(srcLines.slice(1)); // 其余每行逐字节相同

    const srcHeader = JSON.parse(srcLines[0]) as Record<string, unknown>;
    const outHeader = JSON.parse(outLines[0]) as Record<string, unknown>;
    expect(outHeader.id).toBe("01a1cccc-1111-4111-8111-111111111111");
    expect(outHeader.id).not.toBe(srcHeader.id);
    expect(outHeader.cwd).toBe(process.cwd()); // 否则 SessionManager.list 的 cwd 过滤会把它挡掉
    expect(outHeader.parentSession).toBeNull(); // 源机器的父会话路径在本机不可解析
    expect(outHeader.version).toBe(srcHeader.version); // 其余键保留
    expect(outHeader.timestamp).toBe(srcHeader.timestamp);
    expect(outHeader.type).toBe("session");
    expect(result.sessionId).toBe("01a1cccc-1111-4111-8111-111111111111");
  });

  it("导入后出现在 listSessions()（可被识别、可打开），并带来源标注", async () => {
    const { path } = await buildRealBundle();
    const result = importSessionBundle(path, { now: () => FIXED_NOW });

    const sessions = await listSessions();
    const hit = sessions.find((s) => s.path === result.sessionFile);
    expect(hit, "导入会话必须出现在会话列表里").toBeDefined();
    expect(hit!.id).toBe(result.sessionId);
    expect(hit!.name).toBe("源会话显示名");
    expect(hit!.messageCount).toBe(2);
    expect(result.messageCount).toBe(2);
    expect(result.sessionName).toBe("源会话显示名");

    // 来源标注：sidecar 是权威记录，画布顶层是血缘邻近信息
    const meta = readImportMeta(result.sessionFile)!;
    expect(meta.version).toBe(1);
    expect(meta.importedFrom.originalSessionId).toBe(result.importedFrom.originalSessionId);
    expect(meta.importedFrom.originSessionName).toBe("源会话显示名");
    expect(meta.importedFrom.token).toMatch(/^[a-f0-9]{32}$/);
    expect(meta.importedFrom.exportedAt).toBe(FIXED_NOW.toISOString());
    expect(meta.importedFrom.importedAt).toBe(FIXED_NOW.toISOString());
    expect(meta.importedFrom.bundleFileName).toMatch(/\.govio-bundle\.zip$/);
    expect(meta.importedFrom.bundleFileName).not.toContain("incoming"); // 只记文件名，不记源路径
    const canvasRaw = JSON.parse(readFileSync(canvasPathFor(result.sessionFile), "utf-8")) as Record<string, unknown>;
    expect(canvasRaw.importedFrom).toEqual(result.importedFrom);

    // 原生会话没有导入标注
    expect(readImportMeta(makeSourceSession("2026-11-17T04-30-00-000Z_native"))).toBeNull();
  });

  it("包名与 token 一致：同一 token 的包导入后 token 被如实保留在来源标注里", async () => {
    const { path, manifest, sourceFile } = await buildRealBundle();
    const result = importSessionBundle(path, { now: () => FIXED_NOW });
    expect(path.endsWith(bundleFileName(manifest.token))).toBe(true);
    expect(result.importedFrom.token).toBe(manifest.token);
    // 源会话 id（= 文件名主干）被保留，而本机新 id 与它不同
    expect(result.importedFrom.originalSessionId).toBe(sourceFile.replace(/\.jsonl$/, "").split(/[\\/]/).pop());
    expect(result.sessionId).not.toBe(result.importedFrom.originalSessionId);
  });

  it("源画布的 forkFrom 血缘被保留，importedFrom 追加在其旁", async () => {
    const forkFrom = { shareId: "a".repeat(32), forkedAt: FIXED_NOW.toISOString() };
    const { path } = await buildRealBundle({ forkFrom });
    const result = importSessionBundle(path, { now: () => FIXED_NOW });
    const raw = JSON.parse(readFileSync(canvasPathFor(result.sessionFile), "utf-8")) as Record<string, unknown>;
    expect(raw.forkFrom).toEqual(forkFrom);
    expect(raw.importedFrom).toBeDefined();
    expect(Array.isArray(raw.nodes)).toBe(true);
  });

  it("同一个包导入两次 → 两个独立会话，互不覆盖", async () => {
    const { path } = await buildRealBundle();
    const a = importSessionBundle(path, { now: () => FIXED_NOW });
    const b = importSessionBundle(path, { now: () => new Date(FIXED_NOW.getTime() + 1000) });
    expect(a.sessionFile).not.toBe(b.sessionFile);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(existsSync(a.sessionFile)).toBe(true);
    expect(existsSync(b.sessionFile)).toBe(true);
    expect(a.importedFrom.originalSessionId).toBe(b.importedFrom.originalSessionId);
  });

  it("report.html 与 manifests.json 只校验不落地；sessions 目录只多出一个会话的文件", async () => {
    const { path } = await buildRealBundle();
    const before = snapshotSessions();
    const result = importSessionBundle(path, { now: () => FIXED_NOW });
    const added = snapshotSessions().filter((f) => !before.includes(f));
    expect(added.sort()).toEqual(newFilesOf(result.sessionFile).sort());
    expect(added.some((f) => f.includes(BUNDLE_REPORT_PATH))).toBe(false);
    expect(added.some((f) => f.includes(BUNDLE_MANIFESTS_PATH))).toBe(false);
    expect(result.filesWritten).toEqual([BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_AUDIT_PATH, BUNDLE_INJECTION_PATH]);
  });

  it("无画布的包也能导入（nodeCount=0，不写 canvas sidecar，missing 如实记账）", async () => {
    const { path, manifest } = await buildRealBundle({ withCanvas: false, withSidecars: false });
    expect(manifest.missing).toContain(BUNDLE_CANVAS_PATH);
    const result = importSessionBundle(path, { now: () => FIXED_NOW });
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.manifestCount).toBe(0);
    expect(existsSync(canvasPathFor(result.sessionFile))).toBe(false);
    expect(result.missing).toEqual(manifest.missing);
    expect(result.filesWritten).toEqual([BUNDLE_SESSION_PATH]);
  });

  it("storageProfile 只透传引用名，凭据值与桶名一个字节都不落地", async () => {
    const sourceFile = makeSourceSession("2026-11-17T04-10-00-000Z_sess-s3");
    saveCanvas(sourceFile, [dfNode("gov-1", "df_a")], []);
    writeFileSync(
      storageBindingPathFor(sourceFile),
      JSON.stringify({ version: 1, backend: "s3", profile: FAKE_PROFILE, canvasId: "c-1", updatedAt: FIXED_NOW.toISOString() }),
    );
    process.env.GOVIO_T37_AK = FAKE_AK;
    process.env.GOVIO_T37_SK = FAKE_SK;
    writeFileSync(
      join(process.cwd(), ".govio", "storage-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: { [FAKE_PROFILE]: { region: "us-east-1", bucket: FAKE_BUCKET, prefix: "p", accessKeyIdEnv: "GOVIO_T37_AK", secretAccessKeyEnv: "GOVIO_T37_SK" } },
      }),
    );
    const payload = collectSessionBundle(sourceFile, { now: () => FIXED_NOW });
    const downloads: Array<{ fileName: string; bytes: Uint8Array }> = [];
    await exportSessionBundle({
      pageOrigin: "http://localhost:5173",
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch,
      hashBytes: async (b) => sha256Hex(b),
      download: (fileName, bytes) => downloads.push({ fileName, bytes }),
      buildReport: async () => REPORT_HTML,
    });
    const bundlePath = join(incoming, downloads[0].fileName);
    writeFileSync(bundlePath, downloads[0].bytes);

    const result = importSessionBundle(bundlePath, { now: () => FIXED_NOW });
    expect(result.storageProfile).toBe(FAKE_PROFILE);
    expect(readImportMeta(result.sessionFile)!.storageProfile).toBe(FAKE_PROFILE);
    for (const file of [result.sessionFile, canvasPathFor(result.sessionFile), importMetaPathFor(result.sessionFile)]) {
      const text = readFileSync(file, "utf-8");
      expect(text).not.toContain(FAKE_AK);
      expect(text).not.toContain(FAKE_SK);
      expect(text).not.toContain(FAKE_BUCKET);
      expect(text).not.toContain("storage-profiles.json");
    }
    // 导入不会自动建 S3 绑定（decisions ③：本期只落本地）
    expect(existsSync(storageBindingPathFor(result.sessionFile))).toBe(false);
    delete process.env.GOVIO_T37_AK;
    delete process.env.GOVIO_T37_SK;
  });

  it("删除导入会话时，来源 sidecar 同生命周期删除", async () => {
    const { path } = await buildRealBundle();
    const result = importSessionBundle(path, { now: () => FIXED_NOW });
    expect(existsSync(importMetaPathFor(result.sessionFile))).toBe(true);
    deleteSession(result.sessionFile);
    expect(existsSync(result.sessionFile)).toBe(false);
    expect(existsSync(canvasPathFor(result.sessionFile))).toBe(false);
    expect(existsSync(importMetaPathFor(result.sessionFile))).toBe(false);
  });
});

/** 抛出的 BundleImportError（没抛则 null），便于断言错误码。 */
function catchBundleError(fn: () => unknown): BundleImportError | null {
  try {
    fn();
  } catch (err) {
    return err instanceof BundleImportError ? err : null;
  }
  return null;
}

/** 一个导入会话在 sessions 目录里应新增的文件名（相对名）。 */
function newFilesOf(sessionFile: string): string[] {
  const base = sessionFile.split(/[\\/]/).pop()!;
  const names = [base, `${base}.import.json`];
  if (existsSync(canvasPathFor(sessionFile))) names.push(`${base}.canvas.json`);
  if (existsSync(auditPathFor(sessionFile))) names.push(`${base}.audit.jsonl`);
  if (existsSync(injectionTracePathFor(sessionFile))) names.push(`${base}.injection.jsonl`);
  return names;
}

// ── 2. 校验失败 → 拒绝且零写入 ────────────────────────────────────────────

describe("校验先行与原子性（每条拒绝路径都断言零文件写入）", () => {
  it("逐文件 sha256 不符 → checksum-mismatch", async () => {
    const { path, manifest } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const target = manifest.files.find((f) => f.path === BUNDLE_CANVAS_PATH)!;
    const bad = JSON.parse(strFromU8(entries[BUNDLE_MANIFEST_PATH])) as BundleManifest;
    for (const f of bad.files) if (f.path === target.path) f.sha256 = "0".repeat(64);
    const tampered = repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "bad-sha.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "checksum-mismatch");
  });

  it("字节数不符 → checksum-mismatch", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const bad = JSON.parse(strFromU8(entries[BUNDLE_MANIFEST_PATH])) as BundleManifest;
    bad.files[0].bytes += 1;
    const tampered = repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "bad-bytes.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "checksum-mismatch");
  });

  it("包内文件内容被改（清单未同步）→ checksum-mismatch", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const tampered = repack({ ...entries, [BUNDLE_SESSION_PATH]: `${strFromU8(entries[BUNDLE_SESSION_PATH])}{"type":"message"}\n` }, "bad-content.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "checksum-mismatch");
  });

  it("清单登记的文件在包里不存在 → entry-missing", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const tampered = repack(withoutEntry(entries, BUNDLE_AUDIT_PATH), "missing-entry.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "entry-missing");
  });

  it("包内出现清单未登记的条目 → entry-unexpected（口径 ⑥：整包拒绝）", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const tampered = repack({ ...entries, "extra.txt": "夹带内容" }, "extra-entry.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "entry-unexpected");
  });

  it("缺 session.jsonl → entry-missing（没有 transcript 就不成其为会话）", async () => {
    const { path, manifest } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const rest = withoutEntry(entries, BUNDLE_SESSION_PATH);
    const bad = { ...manifest, files: manifest.files.filter((f) => f.path !== BUNDLE_SESSION_PATH) };
    const tampered = repack({ ...rest, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "no-transcript.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "entry-missing");
  });

  it("包格式版本不支持 → version-unsupported", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const bad = JSON.parse(strFromU8(entries[BUNDLE_MANIFEST_PATH])) as BundleManifest;
    bad.version = BUNDLE_VERSION + 1;
    const tampered = repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "bad-version.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "version-unsupported");
  });

  it("format 不符 → format-mismatch", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const bad = JSON.parse(strFromU8(entries[BUNDLE_MANIFEST_PATH])) as BundleManifest;
    bad.format = "some-other-format";
    const tampered = repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "bad-format.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "format-mismatch");
  });

  it("没有 bundle.json → manifest-missing", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const tampered = repack(withoutEntry(entries, BUNDLE_MANIFEST_PATH), "no-manifest.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "manifest-missing");
  });

  it("bundle.json 不是合法 JSON / 缺字段 / 自列 / sha256 形状不符 → manifest-invalid", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const before = snapshotSessions();
    const good = JSON.parse(strFromU8(entries[BUNDLE_MANIFEST_PATH])) as BundleManifest;

    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFEST_PATH]: "{ not json" }, "m1.zip")), "manifest-invalid");
    const noFiles = { ...good } as unknown as Record<string, unknown>;
    delete noFiles.files;
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(noFiles) }, "m2.zip")), "manifest-invalid");
    const noToken = { ...good } as unknown as Record<string, unknown>;
    delete noToken.token;
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(noToken) }, "m3.zip")), "manifest-invalid");
    const selfListed = { ...good, files: [...good.files, { path: BUNDLE_MANIFEST_PATH, bytes: 1, sha256: "a".repeat(64) }] };
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(selfListed) }, "m4.zip")), "manifest-invalid");
    const badShaShape = { ...good, files: good.files.map((f, i) => (i === 0 ? { ...f, sha256: "xyz" } : f)) };
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFEST_PATH]: JSON.stringify(badShaShape) }, "m5.zip")), "manifest-invalid");
  });

  it("transcript 首行不是 session header → transcript-invalid（否则 pi 列表里根本不出现）", async () => {
    const { path, manifest } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const junk = '{"type":"message","id":"x"}\n';
    const bytes = strToU8(junk);
    const bad = { ...manifest, files: manifest.files.map((f) => (f.path === BUNDLE_SESSION_PATH ? { ...f, bytes: bytes.byteLength, sha256: sha256Hex(bytes) } : f)) };
    const tampered = repack({ ...entries, [BUNDLE_SESSION_PATH]: junk, [BUNDLE_MANIFEST_PATH]: JSON.stringify(bad) }, "bad-transcript.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(tampered), "transcript-invalid");
  });

  it("canvas.json 不是合法画布 / manifests.json 不是数组 → payload-invalid", async () => {
    const { path, manifest } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const before = snapshotSessions();

    const badCanvas = '{"nodes":"不是数组"}';
    const cb = strToU8(badCanvas);
    const m1 = { ...manifest, files: manifest.files.map((f) => (f.path === BUNDLE_CANVAS_PATH ? { ...f, bytes: cb.byteLength, sha256: sha256Hex(cb) } : f)) };
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_CANVAS_PATH]: badCanvas, [BUNDLE_MANIFEST_PATH]: JSON.stringify(m1) }, "p1.zip")), "payload-invalid");

    const badManifests = '{"not":"array"}';
    const mb = strToU8(badManifests);
    const m2 = { ...manifest, files: manifest.files.map((f) => (f.path === BUNDLE_MANIFESTS_PATH ? { ...f, bytes: mb.byteLength, sha256: sha256Hex(mb) } : f)) };
    expectZeroWrite(before, () => importSessionBundle(repack({ ...entries, [BUNDLE_MANIFESTS_PATH]: badManifests, [BUNDLE_MANIFEST_PATH]: JSON.stringify(m2) }, "p2.zip")), "payload-invalid");
  });

  it("目标会话文件已存在 → target-conflict，且不覆盖既有会话（decisions ②）", async () => {
    const { path } = await buildRealBundle();
    const before = snapshotSessions();
    const existing = join(sessionsDir(), newSessionFileName(FIXED_NOW, "01a1dddd-2222-4222-8222-222222222222"));
    writeFileSync(existing, '{"type":"session","id":"01a1dddd-2222-4222-8222-222222222222"}\n');
    const beforeWithExisting = snapshotSessions();
    const original = readFileSync(existing, "utf-8");

    expectZeroWrite(beforeWithExisting, () => importSessionBundle(path, { now: () => FIXED_NOW, newSessionId: () => "01a1dddd-2222-4222-8222-222222222222" }), "target-conflict");
    expect(readFileSync(existing, "utf-8")).toBe(original); // 既有会话字节未变
    expect(before.length).toBeLessThan(beforeWithExisting.length);
  });

  it("写盘中途失败 → 回滚，零残留", async () => {
    const { path } = await buildRealBundle();
    const before = snapshotSessions();
    let calls = 0;
    const realWrite = writeFileSync;

    let caught: unknown = null;
    try {
      importSessionBundle(path, {
        now: () => FIXED_NOW,
        // 第二个目标（canvas sidecar）写失败：第一个文件已落盘，必须被回滚掉
        writeFileImpl: (target, bytes) => {
          calls += 1;
          if (calls === 2) throw new Error("TEST-ONLY 磁盘写满");
          realWrite(target, bytes);
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(calls).toBe(2);
    expect(caught).toBeInstanceOf(BundleImportError);
    expect((caught as BundleImportError).code).toBe("write-failed");
    expect(snapshotSessions(), "回滚后必须零残留").toEqual(before);
  });
});

// ── 3. 安全：读侧路径、zip 闸门、穿越样本 ─────────────────────────────────

describe("安全：读侧路径校验（decisions ⑤）", () => {
  it("空路径 / 非字符串 / NUL / 非 .zip 扩展名 → invalid-path", () => {
    for (const bad of ["", "   ", "D:/x/bundle.tar.gz", "D:/x/bundle", "D:/x/bundle.zip.txt"]) {
      expect(() => resolveBundlePath(bad), `应拒绝 ${JSON.stringify(bad)}`).toThrowError(BundleImportError);
      try {
        resolveBundlePath(bad);
      } catch (err) {
        expect((err as BundleImportError).code).toBe("invalid-path");
      }
    }
    expect(() => resolveBundlePath(undefined as unknown as string)).toThrowError(BundleImportError);
    expect(() => resolveBundlePath("D:/x/a\0.zip")).toThrowError(/NUL/);
  });

  it("UNC 与设备路径被拒（resolve 前后各挡一道）", () => {
    for (const bad of ["\\\\host\\share\\x.zip", "//host/share/x.zip", "\\\\.\\C:\\x.zip", "\\\\?\\C:\\x.zip"]) {
      let code = "";
      try {
        resolveBundlePath(bad);
      } catch (err) {
        code = (err as BundleImportError).code;
      }
      expect(code, `应拒绝 ${bad}`).toBe("invalid-path");
    }
  });

  it("相对路径按 cwd 解析；大小写扩展名 .ZIP 也接受", () => {
    const f = join(incoming, "upper.ZIP");
    writeFileSync(f, zipSync({ "bundle.json": strToU8("{}") }));
    expect(resolveBundlePath(f)).toBe(f);
    const rel = join("incoming", "upper.ZIP");
    expect(resolveBundlePath(rel)).toBe(f);
  });

  it("不存在 → bundle-not-found；目录与 symlink → not-a-file", async () => {
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(join(incoming, "nope.zip")), "bundle-not-found");

    const dir = join(incoming, "adir.zip");
    mkdirSync(dir, { recursive: true });
    expectZeroWrite(before, () => importSessionBundle(dir), "not-a-file");

    // symlink：Windows 无管理员权限/未开发者模式时建 symlink 会 EPERM，此时跳过这一样本
    //（lstat 拒 symlink 的分支在类 Unix 与开启权限的 Windows 上由同一行代码覆盖）。
    const { path } = await buildRealBundle();
    const link = join(incoming, "link.zip");
    let linked: boolean;
    try {
      symlinkSync(path, link);
      linked = true;
    } catch {
      linked = false;
    }
    if (linked) {
      // ⚠️ 必须**重新取快照**：上面的 buildRealBundle() 会在 sessions 目录里建出源会话
      // （.jsonl + canvas/audit/injection 三个 sidecar），沿用测试开头的 `before` 会把「测试自己的夹具」
      // 误判成「导入写入」。Windows 上 symlinkSync 常因缺权限失败 ⇒ 本样本被跳过，该缺陷因此只在
      // 类 Unix 暂露（PR #48 的 ubuntu CI 抓到，2026-11-17 主会话修正）。断言意图不变：
      // 被拒的导入（lstat 识别 symlink → not-a-file）在抛错前不得写任何会话文件。
      const beforeLink = snapshotSessions();
      expectZeroWrite(beforeLink, () => importSessionBundle(link), "not-a-file");
    } else {
      expect(existsSync(link)).toBe(false);
    }
  });

  it("zip 文件体积超上限 → bundle-too-large（读文件之前就拒）", async () => {
    const { path } = await buildRealBundle();
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(path, { maxZipBytes: 16 }), "bundle-too-large");
  });

  it("不是合法 zip → bundle-unreadable", () => {
    const f = join(incoming, "text.zip");
    writeFileSync(f, "这根本不是一个 zip 文件\n");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(f), "bundle-unreadable");
  });
});

describe("安全：zip 元数据闸门与 zip-slip（口径 ⑥ + scope 5）", () => {
  it("元数据遍历不解压任何条目（zip 炸弹防线：先判后解压）", async () => {
    const { path } = await buildRealBundle();
    const infos = inspectBundleEntries(readFileSync(path));
    expect(infos.length).toBeGreaterThan(0);
    expect(infos.every((i) => typeof i.originalSize === "number" && typeof i.name === "string")).toBe(true);
    expect(infos.map((i) => i.name)).toContain(BUNDLE_MANIFEST_PATH);
    // filter 返回 false ⇒ 根本没解压，元数据里拿不到任何内容字节
    expect(infos[0] as unknown as Record<string, unknown>).not.toHaveProperty("contentBase64");
  });

  it("条目数超上限 → too-many-files", async () => {
    const entries: Record<string, string> = { [BUNDLE_MANIFEST_PATH]: "{}" };
    for (let i = 0; i < 6; i++) entries[`f${i}.txt`] = "x";
    const f = repack(entries, "many.zip");
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(f, { maxFileCount: 3 }), "too-many-files");
  });

  it("解压后总体积超上限 → uncompressed-too-large", async () => {
    const { path } = await buildRealBundle();
    const before = snapshotSessions();
    expectZeroWrite(before, () => importSessionBundle(path, { maxUncompressedBytes: 64 }), "uncompressed-too-large");
  });

  it("穿越样本全部被拒（.. / 绝对路径 / 反斜杠 / 子目录 / 空段）", () => {
    const samples = ["../evil.jsonl", "../../evil.jsonl", "/etc/passwd", "C:/evil.jsonl", "..\\evil.jsonl", "sub/a.jsonl", "./a.jsonl", "a/"];
    const before = snapshotSessions();
    for (const [i, name] of samples.entries()) {
      const f = repack({ [name]: "x", [BUNDLE_MANIFEST_PATH]: "{}" }, `slip-${i}.zip`);
      expectZeroWrite(before, () => importSessionBundle(f), "unsafe-entry");
    }
    // 白名单函数本身：合法单层名通过
    for (const ok of [BUNDLE_MANIFEST_PATH, BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_REPORT_PATH]) {
      expect(isSafeBundlePath(ok)).toBe(true);
    }
    for (const bad of samples) {
      expect(isSafeBundlePath(bad), bad).toBe(false);
    }
  });

  it("清单里的路径也过白名单（清单本身可能来自别人）", () => {
    const manifest = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      token: "a".repeat(32),
      sessionId: "s",
      exportedAt: FIXED_NOW.toISOString(),
      files: [{ path: "../evil.jsonl", bytes: 1, sha256: "a".repeat(64) }],
      missing: [],
      excluded: { parquet: { count: 0, bytes: 0, names: [], absent: [] } },
    };
    expect(() => parseBundleManifest(JSON.stringify(manifest))).toThrowError(BundleImportError);
    try {
      parseBundleManifest(JSON.stringify(manifest));
    } catch (err) {
      expect((err as BundleImportError).code).toBe("unsafe-entry");
    }
  });

  it("重名条目 → duplicate-entry；不支持的压缩方式 → bundle-unreadable", () => {
    const limits = { maxFileCount: 32, maxUncompressedBytes: 1024 };
    const entry = (name: string, extra: { originalSize?: number; compression?: number } = {}) => ({
      name,
      size: 1,
      originalSize: 1,
      compression: 8,
      ...extra,
    });
    // fflate 的 zipSync 以对象为输入（同名键天然去重），造不出真重名条目的 zip，
    // 所以直接对闸门纯函数做单元断言（它也是真包导入时的同一条代码路径）。
    const dupErr = catchBundleError(() => assertBundleEntryLimits([entry("a.txt"), entry("a.txt")], limits));
    expect(dupErr?.code).toBe("duplicate-entry");
    // 14 = LZMA，fflate 不支持；提前给明确原因而不是解压时抛裸错
    expect(catchBundleError(() => assertBundleEntryLimits([entry("a.txt", { compression: 14 })], limits))?.code).toBe(
      "bundle-unreadable",
    );
    // 体积闸门按解压后 originalSize 累加（压缩后很小也能拦住）
    expect(
      catchBundleError(() => assertBundleEntryLimits([entry("a.txt", { originalSize: 4096 })], limits))?.code,
    ).toBe("uncompressed-too-large");
    // store(0) 与 deflate(8) 两种正常压缩方式都放行
    expect(() => assertBundleEntryLimits([entry("a.txt", { compression: 0 }), entry("b.txt")], limits)).not.toThrow();
  });
});

describe("rewriteTranscriptHeader / newSessionFileName 纯函数", () => {
  it("保留行尾风格与末尾换行；坏 header 抛 transcript-invalid", () => {
    const crlf = '{"type":"session","id":"a","cwd":"X"}\r\n{"type":"message","id":"m1"}\r\n';
    const out = rewriteTranscriptHeader(strToU8(crlf), { newSessionId: "new-id", cwd: "/here" });
    const text = out.bytes.toString("utf-8");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(JSON.parse(text.split("\r\n")[0]).id).toBe("new-id");
    expect(out.messageCount).toBe(1);

    const lfNoTrailing = '{"type":"session","id":"a","cwd":"X"}';
    const out2 = rewriteTranscriptHeader(strToU8(lfNoTrailing), { newSessionId: "n2", cwd: "/here" });
    expect(out2.bytes.toString("utf-8")).not.toContain("\n");
    expect(JSON.parse(out2.bytes.toString("utf-8")).cwd).toBe("/here");

    for (const bad of ["不是 json\n", '{"type":"message"}\n', "\n"]) {
      expect(() => rewriteTranscriptHeader(strToU8(bad), { newSessionId: "x", cwd: "/y" })).toThrowError(BundleImportError);
    }
  });

  it("session_info 名字取最新一条（与 pi buildSessionInfo 同口径：空名等于清除）", () => {
    const lines = [
      '{"type":"session","id":"a","cwd":"X"}',
      '{"type":"session_info","id":"i1","parentId":null,"name":"旧名"}',
      '{"type":"session_info","id":"i2","parentId":"i1","name":"新名"}',
      '{"type":"message","id":"m1"}',
    ].join("\n");
    const out = rewriteTranscriptHeader(strToU8(`${lines}\n`), { newSessionId: "n", cwd: "/c" });
    expect(out.name).toBe("新名");
    expect(out.messageCount).toBe(1);

    // pi 的语义：最后一条 session_info 名字为空白 ⇒ 名字被清除（不得拿旧名充数）
    const cleared = rewriteTranscriptHeader(
      strToU8(`${lines}\n{"type":"session_info","id":"i3","parentId":"m1","name":"   "}\n`),
      { newSessionId: "n", cwd: "/c" },
    );
    expect(cleared.name).toBeNull();
    // 坏行不拖垮导入（pi 自己也会跳过不可解析的行）
    const withJunk = rewriteTranscriptHeader(
      strToU8(`{"type":"session","id":"a","cwd":"X"}\n不是 json\n{"type":"message","id":"m1"}\n`),
      { newSessionId: "n", cwd: "/c" },
    );
    expect(withJunk.messageCount).toBe(1);
  });

  it("文件名沿用 <ISO(冒号点换横杠)>_<uuid>.jsonl 约定，且与 pi 既有会话文件同形", () => {
    const name = newSessionFileName(FIXED_NOW, "01a1eeee-3333-4333-8333-333333333333");
    expect(name).toBe("2026-11-17T05-06-07-000Z_01a1eeee-3333-4333-8333-333333333333.jsonl");
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/);
  });
});

// ── 4. HTTP 面 ────────────────────────────────────────────────────────────

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

async function callApi(method: string, url: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    destroy: () => void;
  };
  req.method = method;
  req.url = url;
  req.headers = opts.headers ?? {};
  // 体积闸门超限时 readJsonBody 会调 req.destroy()（真实 IncomingMessage 有该方法）
  req.destroy = () => {};
  const res = fakeRes();
  const promise = handleBundleApi(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  if (opts.body !== undefined) {
    // readJsonBody 订阅 data/end：分块投喂，顺便验证体积闸门是流式的
    for (let i = 0; i < opts.body.length; i += 64) req.emit("data", Buffer.from(opts.body.slice(i, i + 64)));
    req.emit("end");
  }
  const handled = await promise;
  return {
    handled,
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
    json: () => (res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null),
  };
}

describe("HTTP：POST /api/session-import", () => {
  it("正常导入 → 200 + ok:true + 会话名与节点数（前端反馈的依据）", async () => {
    const { path } = await buildRealBundle();
    const res = await callApi("POST", "/api/session-import", {
      body: JSON.stringify({ path }),
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    const body = res.json()!;
    expect(body.ok).toBe(true);
    expect(body.nodeCount).toBe(2);
    expect(body.sessionName).toBe("源会话显示名");
    expect(typeof body.sessionFile).toBe("string");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(existsSync(body.sessionFile as string)).toBe(true);
    // 响应不回显包内容（会话内容是敏感数据）
    expect(res.body).not.toContain(SENTINEL);
  });

  it("跨源预检 OPTIONS → 204，且 POST + Content-Type 已在 CORS 白名单内", async () => {
    const res = await callApi("OPTIONS", "/api/session-import", { headers: { origin: "http://localhost:5173" } });
    expect(res.handled).toBe(true);
    expect(res.status).toBe(204);
    expect(String(res.headers["Access-Control-Allow-Methods"])).toContain("POST");
    expect(String(res.headers["Access-Control-Allow-Headers"])).toContain("Content-Type");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  it("非白名单 Origin 不回显（CORS 面未扩大）", async () => {
    const res = await callApi("OPTIONS", "/api/session-import", { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("缺 path / 空 path / 非法 JSON body → 400", async () => {
    expect((await callApi("POST", "/api/session-import", { body: "{}" })).status).toBe(400);
    expect((await callApi("POST", "/api/session-import", { body: JSON.stringify({ path: "   " }) })).status).toBe(400);
    const bad = await callApi("POST", "/api/session-import", { body: "{ 不是 json" });
    expect(bad.status).toBe(400);
    expect(bad.json()!.error).toBe("invalid-json-body");
  });

  it("body 超过 8KB → 413，且不缓冲大包体", async () => {
    const huge = JSON.stringify({ path: "x".repeat(9 * 1024) });
    const res = await callApi("POST", "/api/session-import", { body: huge });
    expect(res.status).toBe(413);
    expect(res.json()!.error).toBe("request-too-large");
  });

  it("GET /api/session-import → 405；未知路径不接管", async () => {
    expect((await callApi("GET", "/api/session-import")).status).toBe(405);
    expect((await callApi("POST", "/api/nope")).handled).toBe(false);
    // T3.6 的导出路由行为未受影响
    expect((await callApi("POST", "/api/session-bundle")).status).toBe(405);
  });

  it("错误码 → 状态码映射覆盖全部码，且响应体带人话 message", async () => {
    const expected: Partial<Record<ImportErrorCode, number>> = {
      "invalid-path": 400,
      "not-a-file": 400,
      "bundle-not-found": 404,
      "target-conflict": 409,
      "bundle-too-large": 413,
      "too-many-files": 413,
      "uncompressed-too-large": 413,
      "write-failed": 500,
    };
    for (const code of IMPORT_ERROR_CODES) {
      const status = importStatusFor(code);
      expect(status, `${code} 应有确定状态码`).toBe(expected[code] ?? 422);
      expect([400, 404, 409, 413, 422, 500]).toContain(status);
    }
    const res = await callApi("POST", "/api/session-import", { body: JSON.stringify({ path: join(incoming, "ghost.zip") }) });
    expect(res.status).toBe(404);
    expect(res.json()!.error).toBe("bundle-not-found");
    expect(String(res.json()!.message).length).toBeGreaterThan(4);
  });

  it("校验失败的响应里不泄漏包内容", async () => {
    const { path } = await buildRealBundle();
    const entries = entriesOf(readFileSync(path));
    const tampered = repack({ ...entries, [BUNDLE_SESSION_PATH]: `${strFromU8(entries[BUNDLE_SESSION_PATH])}{"x":1}\n` }, "leak.zip");
    const res = await callApi("POST", "/api/session-import", { body: JSON.stringify({ path: tampered }) });
    expect(res.status).toBe(422);
    expect(res.json()!.error).toBe("checksum-mismatch");
    expect(res.body).not.toContain(SENTINEL);
    expect(res.body).not.toContain("第一句");
  });
});

// ── 5. 前端命令模块（HTTP 客户端层）───────────────────────────────

describe("前端 importSessionBundle（src/commands/import-session.ts）", () => {
  const OK_PAYLOAD = {
    ok: true,
    sessionId: "01a1ffff-4444-4444-8444-444444444444",
    sessionFile: "/tmp/x/.govio/sessions/2026-11-17T05-06-07-000Z_01a1ffff.jsonl",
    sessionName: "导入的会话",
    messageCount: 4,
    nodeCount: 3,
    edgeCount: 2,
    manifestCount: 3,
    importedFrom: { token: "b".repeat(32), exportedAt: FIXED_NOW.toISOString(), originalSessionId: "s", originSessionName: "导入的会话", bundleFileName: "b.govio-bundle.zip", importedAt: FIXED_NOW.toISOString() },
    filesWritten: [BUNDLE_SESSION_PATH],
    missing: [],
    excludedParquet: { count: 0, bytes: 0, names: [], absent: [] },
  };

  function stubFetch(response: { ok: boolean; status: number; json: () => unknown } | Error) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return { ok: response.ok, status: response.status, json: response.json } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("POST 到 /api/session-import，带上路径；基址由页面 origin 推导（X25 纪律）", async () => {
    const { impl, calls } = stubFetch({ ok: true, status: 200, json: async () => OK_PAYLOAD });
    const result = await importSessionBundleFront({
      pageOrigin: "http://localhost:5173",
      bundlePath: "D:/downloads/x.govio-bundle.zip",
      fetchImpl: impl,
    });
    expect(result.sessionId).toBe(OK_PAYLOAD.sessionId);
    expect(calls[0].url).toBe("http://localhost:5174/api/session-import"); // 绝不由 API 基址拼分享链接，也不硬编码端口
    expect(calls[0].init!.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ path: "D:/downloads/x.govio-bundle.zip" });
    expect((calls[0].init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("无端口的页面 origin（生产同源）退回相对路径", async () => {
    const { impl, calls } = stubFetch({ ok: true, status: 200, json: async () => OK_PAYLOAD });
    await importSessionBundleFront({ pageOrigin: "https://govio.example.com", bundlePath: "/a/b.zip", fetchImpl: impl });
    expect(calls[0].url).toBe("/api/session-import");
  });

  it("空路径直接给用法提示，不发请求", async () => {
    const { impl, calls } = stubFetch({ ok: true, status: 200, json: async () => OK_PAYLOAD });
    await expect(importSessionBundleFront({ pageOrigin: "http://localhost:5173", bundlePath: "   ", fetchImpl: impl })).rejects.toThrow(/\u7528法\uff1a\/import/);
    expect(calls.length).toBe(0);
  });

  it("错误码翻成人话：校验和不符 / 找不到包 / 版本不支持", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [422, "checksum-mismatch", /\u6821\u9a8c\u548c\u4e0d\u7b26/],
      [404, "bundle-not-found", /\u627e\u4e0d\u5230\u8fd9\u4e2a\u6253\u5305\u6587\u4ef6/],
      [422, "version-unsupported", /\u5305\u683c\u5f0f\u7248\u672c\u672c\u7aef\u4e0d\u652f\u6301/],
      [413, "uncompressed-too-large", /zip \u70b8\u5f39/],
      [422, "entry-unexpected", /\u6e05\u5355\u672a\u767b\u8bb0/],
      [409, "target-conflict", /\u62d2\u7edd\u8986\u76d6/],
    ];
    for (const [status, code, text] of cases) {
      const { impl } = stubFetch({ ok: false, status, json: async () => ({ error: code }) });
      const err = await importSessionBundleFront({ pageOrigin: "http://localhost:5173", bundlePath: "/a/b.zip", fetchImpl: impl }).catch((e) => e);
      expect(err, `${code} \u5e94\u62a5\u9519`).toBeInstanceOf(SessionImportError);
      expect((err as SessionImportError).code).toBe(code);
      expect((err as SessionImportError).message).toMatch(text);
    }
  });

  it("后端已有 message 时优先用它；网络不通与回执形状不符也给人话", async () => {
    const withMessage = stubFetch({ ok: false, status: 422, json: async () => ({ error: "checksum-mismatch", message: "canvas.json \u6821\u9a8c\u548c\u4e0d\u7b26" }) });
    const err1 = await importSessionBundleFront({ pageOrigin: "http://localhost:5173", bundlePath: "/a/b.zip", fetchImpl: withMessage.impl }).catch((e) => e);
    expect((err1 as SessionImportError).message).toBe("canvas.json \u6821\u9a8c\u548c\u4e0d\u7b26");

    const offline = stubFetch(new Error("ECONNREFUSED"));
    const err2 = await importSessionBundleFront({ pageOrigin: "http://localhost:5173", bundlePath: "/a/b.zip", fetchImpl: offline.impl }).catch((e) => e);
    expect((err2 as SessionImportError).code).toBe("network");
    expect((err2 as SessionImportError).message).toMatch(/\u65e0\u6cd5\u8fde\u63a5\u540e\u7aef\u5bfc\u5165\u901a\u9053/);

    const badReceipt = stubFetch({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const err3 = await importSessionBundleFront({ pageOrigin: "http://localhost:5173", bundlePath: "/a/b.zip", fetchImpl: badReceipt.impl }).catch((e) => e);
    expect((err3 as SessionImportError).message).toMatch(/\u56de\u6267\u5f62\u72b6\u4e0d\u7b26/);
  });

  it("结果文案：会话名 + 节点数（scope 1），并如实说出缺什么", () => {
    const base = { ...OK_PAYLOAD };
    expect(describeImportResult(base)).toContain("\u5df2\u5bfc\u5165\u4e3a\u5386\u53f2\u4f1a\u8bdd\u300c\u5bfc\u5165\u7684\u4f1a\u8bdd\u300d");
    expect(describeImportResult(base)).toContain("3 \u8282\u70b9");
    expect(describeImportResult(base)).toContain("4 \u6761\u5bf9\u8bdd");

    const noName = { ...base, sessionName: null };
    expect(describeImportResult(noName)).toContain("未命名");
    expect(describeImportResult(noName)).not.toContain(base.sessionId); // 不拿新 uuid 充会话名
    expect(describeImportResult({ ...base, sessionName: "   " })).toContain("未命名");

    const missingData = { ...base, excludedParquet: { count: 2, bytes: 10, names: ["a.parquet", "b.parquet"], absent: ["c"] } };
    expect(describeImportResult(missingData)).toMatch(/\u6570\u636e\u6587\u4ef6\u672a\u968f\u5305.*3 \u4e2a DataFrame/);

    const withProfile = { ...base, storageProfile: FAKE_PROFILE };
    expect(describeImportResult(withProfile)).toContain(FAKE_PROFILE);
    expect(describeImportResult(withProfile)).toMatch(/\u672c\u673a\u672a\u7ed1\u5b9a/);
  });
});
