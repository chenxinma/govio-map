/**
 * T3.6 `/export` 打包（前端组装）集成测试 —— node 环境，全部外部依赖注入（HTTP / 哈希 /
 * 下载 / 报告生成），产物用 fflate 反解后逐条核对。
 *
 * 关键契约（T3.7 导入直接照这份实现）：
 *  - 包名 `<token>.govio-bundle.zip`，包根 `bundle.json` 列出**除自己以外**的全部文件与 sha256
 *  - `bundle.json.files[].sha256` 与包内实际字节逐条对得上（可独立复核）
 *  - `report.html` 由**包内 canvas.json** 生成（不是画布 store 的实时状态）⇒ 包内自洽
 *  - 空画布 / 无画布 sidecar 时不生成报告，但原因如实写进 `reportOmitted`
 *  - API 基址一律由页面 origin 推导（X25 纪律），生产同源退回相对路径
 *  - 后端载荷形状不符 / 非法包内路径 / HTTP 错误 → 明确报错，**绝不产出坏包**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import type { Edge, Node } from "@xyflow/react";

const agentStub = vi.hoisted(() => ({ sessionFile: null as string | null }));
vi.mock("../../server/agent.js", () => ({
  getSession: () => (agentStub.sessionFile ? { sessionManager: { getSessionFile: () => agentStub.sessionFile } } : null),
}));

import { saveCanvas } from "../../server/session-history.js";
import { auditPathFor } from "../../server/permission-audit.js";
import { injectionTracePathFor } from "../../server/prompt-injection.js";
import { storageBindingPathFor } from "../../server/storage/paths.js";
import { deriveShareToken } from "../../server/share.js";
import { collectSessionBundle } from "../../server/session-bundle.js";
import {
  BundlePayloadError,
  exportSessionBundle,
  fetchAuditForBundle,
} from "../../src/commands/export-session";
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
  bundleFileName,
  type BundleManifest,
  type SessionBundlePayload,
} from "../../src/types/bundle";

/** 夹具假凭据：不带任何真实凭据前缀形态（GitGuardian 误报教训，见 T3.5）。 */
const FAKE_PROFILE = "TEST-ONLY-PROFILE";
const FAKE_AK = "TEST-ONLY-AK-8888";
const FAKE_SK = "TEST-ONLY-SK-8888";
const FAKE_BUCKET = "test-only-bucket-do-not-leak";

const REPORT_HTML = "<!DOCTYPE html><html><body>TEST-ONLY-REPORT</body></html>";

const tmpDirs: string[] = [];
let prevCwd = "";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "govio-t36-export-"));
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

function sessionFile(name: string, transcript = '{"type":"message","id":"u0"}\n'): string {
  const dir = join(process.cwd(), ".govio", "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.jsonl`);
  writeFileSync(f, transcript);
  return f;
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
      manifest: {
        schemaVersion: 1,
        origin: "sql-editor",
        sql: "SELECT 1",
        datasource: "duck",
        dfName,
        executedAt: "2026-11-17T00:00:00.000Z",
        rowCount: 1,
        columnCount: 1,
        sessionId: "s1",
      },
    },
  } as unknown as Node;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 用真实服务端收集器产出载荷，保证前后端契约是**同一份**（不各写一套夹具）。 */
function payloadFor(file: string): SessionBundlePayload {
  return collectSessionBundle(file, { now: () => new Date("2026-11-17T02:03:04.000Z") });
}

interface ExportRunResult {
  fileName: string;
  bytes: number;
  fileCount: number;
  token: string;
  sessionId: string;
  reportIncluded: boolean;
  excludedParquet: { count: number; bytes: number };
}

interface Harness {
  outcome: ExportRunResult;
  downloads: Array<{ fileName: string; bytes: Uint8Array }>;
  /** X27 旁文件（`.sha256` 文本）下载 */
  textDownloads: Array<{ fileName: string; text: string }>;
  requestedUrls: string[];
  reportInputs: Array<{ nodes: Node[]; edges: Edge[]; exportedAt: string; appVersion?: string; apiBase: string }>;
  entries: Record<string, Uint8Array>;
  manifest: BundleManifest;
}

/** 跑一次导出并反解产物；`response` 可覆盖默认 HTTP 行为（错误分支用）。 */
async function runExport(
  payload: SessionBundlePayload | null,
  opts: {
    pageOrigin?: string;
    response?: { ok: boolean; status: number; json: () => unknown };
    appVersion?: string;
  } = {},
): Promise<Harness> {
  const downloads: Array<{ fileName: string; bytes: Uint8Array }> = [];
  const textDownloads: Array<{ fileName: string; text: string }> = [];
  const requestedUrls: string[] = [];
  const reportInputs: Harness["reportInputs"] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    requestedUrls.push(url);
    if (opts.response) {
      return { ok: opts.response.ok, status: opts.response.status, json: opts.response.json } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;

  const outcome = await exportSessionBundle({
    pageOrigin: opts.pageOrigin ?? "http://localhost:5173",
    appVersion: opts.appVersion,
    fetchImpl,
    hashBytes: async (bytes) => sha256Hex(bytes),
    download: (fileName, bytes) => downloads.push({ fileName, bytes }),
    downloadText: (fileName, text) => textDownloads.push({ fileName, text }),
    buildReport: async (input) => {
      reportInputs.push(input);
      return REPORT_HTML;
    },
  });

  const downloaded = downloads[0];
  expect(downloaded, "应产出一份下载").toBeDefined();
  const entries = unzipSync(downloaded.bytes);
  const manifestRaw = entries[BUNDLE_MANIFEST_PATH];
  expect(manifestRaw, "包根必须有 bundle.json").toBeDefined();
  return {
    outcome,
    downloads,
    textDownloads,
    requestedUrls,
    reportInputs,
    entries,
    manifest: JSON.parse(strFromU8(manifestRaw)) as BundleManifest,
  };
}

describe("X27 外层整包校验和（旁文件）", () => {
  it("bundleSha256 = 对下载 zip 字节的 sha256；旁文件按 sha256sum 格式命名与成文", async () => {
    const f = sessionFile("2026-11-17T02-10-00-000Z_sess-x27");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const h = await runExport(payloadFor(f));

    expect(h.downloads).toHaveLength(1);
    expect(h.outcome.bundleSha256).toBe(sha256Hex(h.downloads[0].bytes));
    expect(h.outcome.checksumFileName).toBe(`${h.outcome.fileName}.sha256`);
    expect(h.textDownloads).toEqual([
      { fileName: `${h.outcome.fileName}.sha256`, text: `${h.outcome.bundleSha256}  ${h.outcome.fileName}\n` },
    ]);
    // 旁文件内容可直接喂给 sha256sum -c
    expect(h.textDownloads[0].text.trimEnd().split(/\s+/)).toEqual([h.outcome.bundleSha256, h.outcome.fileName]);
  });

  it("同一会话两次导出：整包 sha256 一致（可复现归档）", async () => {
    const f = sessionFile("2026-11-17T02-10-01-000Z_sess-x27-2");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const payload = payloadFor(f);
    const a = await runExport(payload);
    const b = await runExport(payload);
    expect(a.outcome.bundleSha256).toBe(b.outcome.bundleSha256);
    expect(Buffer.from(a.downloads[0].bytes).equals(Buffer.from(b.downloads[0].bytes))).toBe(true);
  });

  it("包内任何文件都改变整包校验和（旁文件保护的是 zip 字节，不是清单内容）", async () => {
    const f = sessionFile("2026-11-17T02-10-02-000Z_sess-x27-3");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const base = payloadFor(f);
    const changed: SessionBundlePayload = {
      ...base,
      files: base.files.map((file) =>
        file.path === BUNDLE_CANVAS_PATH
          ? { ...file, contentBase64: Buffer.from(JSON.stringify({ nodes: [], edges: [] })).toString("base64") }
          : file,
      ),
    };
    const a = await runExport(base);
    const b = await runExport(changed);
    expect(a.outcome.bundleSha256).not.toBe(b.outcome.bundleSha256);
  });
});

describe("包结构与 bundle.json 契约", () => {
  it("五类会话文件 + report.html + bundle.json 全在包里，包名 = <token>.govio-bundle.zip", async () => {
    const f = sessionFile("2026-11-17T02-00-00-000Z_sess-full");
    saveCanvas(f, [dfNode("gov-1", "df_a")], [{ id: "e1", source: "gov-1", target: "gov-1" }]);
    writeFileSync(auditPathFor(f), '{"type":"permission_decision","decisionId":"pd-1"}\n');
    writeFileSync(injectionTracePathFor(f), '{"type":"injection"}\n');
    const payload = payloadFor(f);

    const h = await runExport(payload);
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0].fileName).toBe(bundleFileName(payload.token));
    expect(h.downloads[0].fileName).toBe(`${deriveShareToken("2026-11-17T02-00-00-000Z_sess-full")}.govio-bundle.zip`);
    expect(Object.keys(h.entries).sort()).toEqual(
      [BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_MANIFESTS_PATH, BUNDLE_AUDIT_PATH, BUNDLE_INJECTION_PATH, BUNDLE_REPORT_PATH, BUNDLE_MANIFEST_PATH].sort(),
    );
    expect(h.outcome.reportIncluded).toBe(true);
    // fileCount = 清单文件数 + bundle.json 自身
    expect(h.outcome.fileCount).toBe(h.manifest.files.length + 1);
    expect(h.outcome.bytes).toBe(h.downloads[0].bytes.byteLength);
    expect(strFromU8(h.entries[BUNDLE_REPORT_PATH])).toBe(REPORT_HTML);
  });

  it("bundle.json 字段齐全，且逐文件 sha256/bytes 与包内实际字节对得上（T3.7 的校验依据）", async () => {
    const f = sessionFile("2026-11-17T02-00-01-000Z_sess-checksum");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    writeFileSync(auditPathFor(f), '{"type":"permission_decision","decisionId":"pd-9"}\n');
    const payload = payloadFor(f);

    const h = await runExport(payload, { appVersion: "0.7.2" });
    expect(h.manifest.format).toBe(BUNDLE_FORMAT);
    expect(h.manifest.version).toBe(BUNDLE_VERSION);
    expect(h.manifest.token).toBe(payload.token);
    expect(h.manifest.sessionId).toBe(payload.sessionId);
    expect(h.manifest.exportedAt).toBe("2026-11-17T02:03:04.000Z");
    expect(h.manifest.appVersion).toBe("0.7.2");
    expect(h.manifest.missing).toEqual(payload.missing);
    expect(h.manifest.excluded).toEqual(payload.excluded);
    expect(h.manifest.reportOmitted).toBeUndefined();

    // bundle.json 不列自己（自引用无法计算校验和），其余包内文件必须逐条列出并可复核
    expect(h.manifest.files.some((e) => e.path === BUNDLE_MANIFEST_PATH)).toBe(false);
    expect(h.manifest.files.map((e) => e.path).sort()).toEqual(
      Object.keys(h.entries).filter((p) => p !== BUNDLE_MANIFEST_PATH).sort(),
    );
    for (const entry of h.manifest.files) {
      const actual = h.entries[entry.path];
      expect(actual, `${entry.path} 应在包内`).toBeDefined();
      expect(entry.bytes, `${entry.path} bytes 应等于实际字节数`).toBe(actual.byteLength);
      expect(entry.sha256, `${entry.path} sha256 应可独立复核`).toBe(sha256Hex(actual));
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("服务端算好的 sha256 原样透传（前端不重算会话文件），report.html 的 sha256 由前端补", async () => {
    const f = sessionFile("2026-11-17T02-00-02-000Z_sess-provenance");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const payload = payloadFor(f);
    const h = await runExport(payload);
    for (const serverEntry of payload.files) {
      const listed = h.manifest.files.find((e) => e.path === serverEntry.path);
      expect(listed?.sha256).toBe(serverEntry.sha256);
      expect(listed?.bytes).toBe(serverEntry.bytes);
    }
    const report = h.manifest.files.find((e) => e.path === BUNDLE_REPORT_PATH);
    expect(report?.sha256).toBe(sha256Hex(new TextEncoder().encode(REPORT_HTML)));
    expect(report?.bytes).toBe(new TextEncoder().encode(REPORT_HTML).byteLength);
  });

  it("report.html 由**包内 canvas.json** 生成（不是画布实时状态），且沿用服务端 exportedAt 与推导基址", async () => {
    const f = sessionFile("2026-11-17T02-00-03-000Z_sess-report-source");
    const nodes = [dfNode("gov-sidecar", "df_from_sidecar")];
    saveCanvas(f, nodes, [{ id: "e1", source: "gov-sidecar", target: "gov-sidecar" }]);
    const payload = payloadFor(f);
    const h = await runExport(payload, { pageOrigin: "http://localhost:5173", appVersion: "9.9.9" });

    expect(h.reportInputs).toHaveLength(1);
    const input = h.reportInputs[0];
    expect(input.nodes.map((n) => n.id)).toEqual(["gov-sidecar"]);
    expect(input.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(input.exportedAt).toBe(payload.exportedAt);
    expect(input.appVersion).toBe("9.9.9");
    expect(input.apiBase).toBe("http://localhost:5174");
  });

  it("同一会话内容两次打包字节一致（mtime 固定为 exportedAt ⇒ 可复现归档）", async () => {
    const f = sessionFile("2026-11-17T02-00-04-000Z_sess-deterministic");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const payload = payloadFor(f);
    const a = await runExport(payload);
    const b = await runExport(payload);
    expect(Buffer.from(a.downloads[0].bytes).equals(Buffer.from(b.downloads[0].bytes))).toBe(true);
  });

  it("空画布：不生成 report.html，原因写进 reportOmitted；其余文件照常入包", async () => {
    const f = sessionFile("2026-11-17T02-00-05-000Z_sess-empty-canvas");
    saveCanvas(f, [], []);
    const payload = payloadFor(f);
    const h = await runExport(payload);
    expect(h.entries[BUNDLE_REPORT_PATH]).toBeUndefined();
    expect(h.manifest.reportOmitted).toBe("画布为空，未生成交付报告");
    expect(h.manifest.files.map((e) => e.path)).not.toContain(BUNDLE_REPORT_PATH);
    expect(h.reportInputs).toHaveLength(0);
    expect(Object.keys(h.entries).sort()).toEqual([BUNDLE_SESSION_PATH, BUNDLE_CANVAS_PATH, BUNDLE_MANIFESTS_PATH, BUNDLE_MANIFEST_PATH].sort());
  });

  it("无画布 sidecar：canvas.json 进 missing，reportOmitted 说明原因，仍然产出可用的包", async () => {
    const f = sessionFile("2026-11-17T02-00-06-000Z_sess-no-canvas");
    const payload = payloadFor(f);
    expect(payload.missing).toContain(BUNDLE_CANVAS_PATH);
    const h = await runExport(payload);
    expect(h.entries[BUNDLE_CANVAS_PATH]).toBeUndefined();
    expect(h.manifest.missing).toContain(BUNDLE_CANVAS_PATH);
    expect(h.manifest.reportOmitted).toBe("会话没有画布 sidecar（canvas.json），未生成交付报告");
    expect(h.entries[BUNDLE_SESSION_PATH]).toBeDefined();
    expect(h.entries[BUNDLE_MANIFEST_PATH]).toBeDefined();
  });

  it("parquet 排除记账随包透传（接收方知道缺什么）", async () => {
    const f = sessionFile("2026-11-17T02-00-07-000Z_sess-parquet");
    saveCanvas(f, [dfNode("gov-1", "df_in_bundle"), dfNode("gov-2", "df_gone")], []);
    mkdirSync(join(process.cwd(), ".govio", "observe", "dataframes"), { recursive: true });
    writeFileSync(join(process.cwd(), ".govio", "observe", "dataframes", "df_in_bundle.parquet"), Buffer.alloc(1024, 3));
    const payload = payloadFor(f);
    const h = await runExport(payload);
    expect(h.manifest.excluded.parquet).toEqual({ count: 1, bytes: 1024, names: ["df_in_bundle.parquet"], absent: ["df_gone"] });
    expect(Object.keys(h.entries).some((p) => p.endsWith(".parquet"))).toBe(false);
  });

  it("S3 绑定：只带 profile 引用名，凭据值/桶名/区域在整包任何字节里都不出现", async () => {
    const f = sessionFile("2026-11-17T02-00-08-000Z_sess-creds");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    writeFileSync(
      storageBindingPathFor(f),
      JSON.stringify({ version: 1, backend: "s3", profile: FAKE_PROFILE, canvasId: "c-1", updatedAt: "2026-11-17T00:00:00.000Z" }),
    );
    writeFileSync(
      join(process.cwd(), ".govio", "storage-profiles.json"),
      JSON.stringify({ version: 1, profiles: { [FAKE_PROFILE]: { region: "us-east-1", bucket: FAKE_BUCKET, accessKeyIdEnv: "GOVIO_T36_AK", secretAccessKeyEnv: "GOVIO_T36_SK" } } }),
    );
    process.env.GOVIO_T36_AK = FAKE_AK;
    process.env.GOVIO_T36_SK = FAKE_SK;
    try {
      const payload = payloadFor(f);
      const h = await runExport(payload);
      expect(h.manifest.storageProfile).toBe(FAKE_PROFILE);
      const everything = Object.values(h.entries).map((b) => strFromU8(b)).join("\n");
      expect(everything).not.toContain(FAKE_AK);
      expect(everything).not.toContain(FAKE_SK);
      expect(everything).not.toContain(FAKE_BUCKET);
      expect(everything).not.toContain("us-east-1");
      expect(everything).not.toContain("storage-profiles.json");
      expect(everything).toContain(FAKE_PROFILE);
    } finally {
      delete process.env.GOVIO_T36_AK;
      delete process.env.GOVIO_T36_SK;
    }
  });
});

describe("基址纪律（X25）与 HTTP 错误映射", () => {
  it("dev（页面带端口）→ API 走端口 +1；生产同源（无端口）→ 退回相对路径", async () => {
    const f = sessionFile("2026-11-17T02-00-09-000Z_sess-base");
    saveCanvas(f, [], []);
    const payload = payloadFor(f);

    const dev = await runExport(payload, { pageOrigin: "http://localhost:5173" });
    expect(dev.requestedUrls[0]).toBe("http://localhost:5174/api/session-bundle");

    const prod = await runExport(payload, { pageOrigin: "http://govio.internal" });
    expect(prod.requestedUrls[0]).toBe("/api/session-bundle");
    // 反向断言：绝不自己拼端口，也不把 API 基址当成页面地址
    for (const url of [...dev.requestedUrls, ...prod.requestedUrls]) {
      expect(url).not.toMatch(/:5174\/share\//);
      expect(url.includes("parseInt")).toBe(false);
    }
  });

  it("409 / 404 / 400 / 413 / 500 各自给明确中文提示，且不产出任何下载", async () => {
    const cases: Array<[number, unknown, RegExp]> = [
      [409, { error: "session bundle requires an active session" }, /没有活动会话/],
      [404, { error: "session-not-found" }, /会话文件不存在/],
      [400, { error: "invalid-session-path" }, /路径不合法/],
      [413, { error: "bundle-too-large", bytes: 128 * 1024 * 1024, limitBytes: 64 * 1024 * 1024 }, /过大.*128\.0 MB.*64\.0 MB/],
      [500, { error: "boom" }, /HTTP 500：boom/],
    ];
    for (const [status, body, pattern] of cases) {
      const downloads: Array<{ fileName: string }> = [];
      await expect(
        exportSessionBundle({
          pageOrigin: "http://localhost:5173",
          fetchImpl: (async () => ({ ok: false, status, json: async () => body })) as unknown as typeof fetch,
          hashBytes: async (b) => sha256Hex(b),
          download: (fileName) => downloads.push({ fileName }),
          buildReport: async () => REPORT_HTML,
        }),
      ).rejects.toThrowError(pattern);
      expect(downloads, `HTTP ${status} 不应产出下载`).toEqual([]);
    }
  });

  it("载荷形状不符（format/version/files/条目字段）→ BundlePayloadError，绝不产坏包", async () => {
    const f = sessionFile("2026-11-17T02-00-10-000Z_sess-shape");
    saveCanvas(f, [], []);
    const good = payloadFor(f);
    const bad: Array<[string, unknown, RegExp]> = [
      ["format 不符", { ...good, format: "something-else" }, /format 不符/],
      ["version 不符", { ...good, version: 99 }, /版本不符/],
      ["缺 files", { ...good, files: undefined }, /缺 files/],
      ["非对象", null, /不是 JSON 对象/],
      ["缺 token", { ...good, token: undefined }, /缺 token\/sessionId\/exportedAt/],
      [
        "条目缺 sha256",
        { ...good, files: [{ path: "session.jsonl", bytes: 1, contentBase64: "eA==" }] },
        /形状不符/,
      ],
      [
        "非法包内路径（穿越）",
        { ...good, files: [{ path: "../evil.jsonl", bytes: 1, sha256: "a".repeat(64), contentBase64: "eA==" }] },
        /非法包内路径/,
      ],
      [
        "绝对路径入包",
        { ...good, files: [{ path: "/etc/passwd", bytes: 1, sha256: "a".repeat(64), contentBase64: "eA==" }] },
        /非法包内路径/,
      ],
    ];
    for (const [label, payload, pattern] of bad) {
      const downloads: unknown[] = [];
      await expect(
        exportSessionBundle({
          pageOrigin: "http://localhost:5173",
          fetchImpl: (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch,
          hashBytes: async (b) => sha256Hex(b),
          download: (fileName, bytes) => downloads.push({ fileName, bytes }),
          buildReport: async () => REPORT_HTML,
        }),
        label,
      ).rejects.toThrowError(pattern);
      expect(downloads, `${label} 不应产出下载`).toEqual([]);
    }
    await expect(
      exportSessionBundle({
        pageOrigin: "http://localhost:5173",
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ ...good, version: 99 }) })) as unknown as typeof fetch,
        hashBytes: async (b) => sha256Hex(b),
        download: () => {},
        buildReport: async () => REPORT_HTML,
      }),
    ).rejects.toThrowError(BundlePayloadError);
  });

  it("无 crypto.subtle 且未注入 hashBytes → 明确报「不是安全上下文」，不产出无校验和的坏包", async () => {
    const f = sessionFile("2026-11-17T02-00-11-000Z_sess-nosubtle");
    saveCanvas(f, [dfNode("gov-1", "df_a")], []);
    const payload = payloadFor(f);
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      await expect(
        exportSessionBundle({
          pageOrigin: "http://localhost:5173",
          fetchImpl: (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch,
          download: () => {},
          buildReport: async () => REPORT_HTML,
        }),
      ).rejects.toThrowError(/安全上下文/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("审计通道（附录 B）基址与降级", () => {
  it("用调用方给的基址请求 /api/permission-audit（不吃 export-report 的端口 +1 硬编码）", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessionId: "s-1",
          total: 1,
          requested: 1,
          entries: [{ type: "permission_decision", decisionId: "pd-1", at: "2026-11-17T00:00:00.000Z", decision: "allow" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const audit = await fetchAuditForBundle(["pd-1"], "http://localhost:5174", fetchImpl);
    expect(urls).toEqual(["http://localhost:5174/api/permission-audit?decisionIds=pd-1"]);
    expect(audit.available).toBe(true);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].decisionId).toBe("pd-1");

    // 生产同源：空基址 ⇒ 相对路径
    await fetchAuditForBundle(["pd-2"], "", fetchImpl);
    expect(urls[1]).toBe("/api/permission-audit?decisionIds=pd-2");
  });

  it("没有 decisionId 时不打审计通道，且算「可用但无记录」而不是「通道不可用」", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const audit = await fetchAuditForBundle([], "http://localhost:5174", fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(audit).toEqual({ available: true, requestedDecisionIds: [], entries: [], totalInSession: 0 });
  });

  it("审计通道失败不阻断打包：available=false + 原因（报告里如实说明缺佐证）", async () => {
    const httpError = await fetchAuditForBundle(
      ["pd-1"],
      "",
      (async () => ({ ok: false, status: 503, json: async () => ({ error: "unavailable" }) })) as unknown as typeof fetch,
    );
    expect(httpError.available).toBe(false);
    expect(httpError.reason).toContain("HTTP 503");

    const netError = await fetchAuditForBundle(
      ["pd-1"],
      "",
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    expect(netError.available).toBe(false);
    expect(netError.reason).toContain("ECONNREFUSED");

    const badJson = await fetchAuditForBundle(
      ["pd-1"],
      "",
      (async () => ({ ok: true, status: 200, json: async () => null })) as unknown as typeof fetch,
    );
    expect(badJson.available).toBe(false);
  });
});
