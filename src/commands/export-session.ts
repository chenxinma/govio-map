/**
 * `/export`：把**当前会话**打成一个自包含 zip（T3.6 重做）。
 *
 * 语义变更（用户裁决 2026-11-15 第 4 条）：只读分享（T3.5）是**活视图**，内容随源画布变；
 * 不可变留痕的职责转移到本命令 —— 同一个 session token 对应同一份可离线归档、可校验、
 * 可被 T3.7 导入的产物。**取代**旧实现（前端把 `{exportedAt, messages[], canvas{}}` 直接
 * Blob 下载的简陋 JSON 快照：无 Manifest、无 sidecar、无 token、不经服务端）。
 *
 * 分工（为什么 zip 在前端组装，见 design.md §3）：
 *  - 服务端 `GET /api/session-bundle` 给「只有它读得到」的会话文件集（transcript +
 *    各 sidecar + 派生 Manifest 清单），并附**服务端算好的 sha256**（校验和权威值）；
 *  - 前端补两个只有它能生成的文件：`report.html`（T1.4 交付报告，图表要借页面里的
 *    Plotly 静态渲染成内联图片）与包根 `bundle.json`（清单 + 逐文件校验和）；
 *  - fflate 打 zip → `a[download]` 下载（用户裁决 ④：只走浏览器下载，不写工作目录）。
 *
 * 基址纪律（X25）：API 一律 `apiBaseFrom(window.location.origin) ?? ''`。刻意**不复用**
 * `export-report.ts` 的 `fetchAuditAppendix()`——它内部那份 `apiBase()` 还是「页面端口 +1」
 * 硬编码（X25 遗留 2，归口 T3.4），这里自己拉审计通道并用 `parseAuditEntries()` 收敛。
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { Edge, Node } from "@xyflow/react";
import { apiBaseFrom } from "../utils/share-link";
import {
  buildDeliveryReportHtml,
  collectPermissionDecisionIds,
  parseAuditEntries,
  renderChartImages,
  type AuditAppendix,
} from "../utils/export-report";
import {
  BUNDLE_CANVAS_PATH,
  BUNDLE_FORMAT,
  BUNDLE_MANIFEST_PATH,
  BUNDLE_REPORT_PATH,
  BUNDLE_VERSION,
  bundleChecksumFileName,
  bundleFileName,
  formatBundleChecksum,
  isSafeBundlePath,
  type BundleManifest,
  type SessionBundlePayload,
} from "../types/bundle";

/** 打包结果（ChatInput 用来给用户一句话反馈）。 */
export interface ExportBundleOutcome {
  fileName: string;
  /** zip 字节数 */
  bytes: number;
  /** 包内文件数（含 bundle.json） */
  fileCount: number;
  token: string;
  sessionId: string;
  /** 是否生成了 report.html（空画布时不生成，原因写进 bundle.json 的 reportOmitted） */
  reportIncluded: boolean;
  excludedParquet: { count: number; bytes: number };
  /**
   * 整包 sha256（X27）：对下载的 zip 字节本身求的哈希。
   * 旁文件 `<包名>.sha256` 的内容就是它，接收方导入时可用 `/import <包> <sha256>` 强制比对。
   */
  bundleSha256: string;
  /** 旁文件名（`<包名>.sha256`） */
  checksumFileName: string;
}

export interface ExportBundleDeps {
  /** 页面 origin（`window.location.origin`）；API 基址由它推导，绝不硬编码端口。 */
  pageOrigin: string;
  appVersion?: string;
  /** 测试注入点：HTTP / 哈希 / 下载 / 报告生成 / 时钟全部可替身。 */
  fetchImpl?: typeof fetch;
  hashBytes?: (bytes: Uint8Array) => Promise<string>;
  download?: (fileName: string, bytes: Uint8Array) => void;
  /** 下载旁文件（`.sha256` 文本）；测试可替身 */
  downloadText?: (fileName: string, text: string) => void;
  buildReport?: (input: { nodes: Node[]; edges: Edge[]; exportedAt: string; appVersion?: string; apiBase: string }) => Promise<string>;
  now?: () => Date;
}
/** 后端载荷形状不符（版本错配 / 字段缺失）——不静默产出坏包。 */
export class BundlePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundlePayloadError";
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 默认哈希：WebCrypto SHA-256（localhost / https 都是安全上下文，故可用）。 */
async function subtleSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new BundlePayloadError(
      "当前页面不是安全上下文（无 crypto.subtle），无法计算 report.html 的校验和；请用 localhost 或 https 打开后重试。",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 默认下载：Blob + a[download]（与 T1.4 `downloadHtml` 同一套机制）。 */
function downloadZip(fileName: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即 revoke 会在部分浏览器上取消下载，留一点余量（与 export-report.ts 同款取舍）。
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 默认下载文本（X27 旁文件）：text/plain，不走 zip 那个 `application/zip` 类型。 */
function downloadTextFile(fileName: string, text: string): void {
  // 非浏览器环境（node 集成测试 / SSR）没有 document，旁文件无从下载：跳过即可，
  // 包本身已经通过调用方注入的 `download` 落地，校验值仍在返回值里。
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 只读拉取权限确认记录（交付报告附录 B）。
 *
 * 与 `export-report.ts` 的 `fetchAuditAppendix()` 行为一致（任何失败都不阻断导出，
 * 只把「缺佐证」如实写进报告），区别只有基址来源：这里用调用方给的 `apiBase`
 * （X25 纪律），不吃那份端口 +1 硬编码。
 */
export async function fetchAuditForBundle(
  decisionIds: string[],
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<AuditAppendix> {
  const base: AuditAppendix = { available: false, requestedDecisionIds: decisionIds, entries: [] };
  if (!decisionIds.length) return { ...base, available: true, totalInSession: 0 };
  try {
    const url = `${apiBase}/api/permission-audit?decisionIds=${encodeURIComponent(decisionIds.join(","))}`;
    const res = await fetchImpl(url);
    const payload = (await res.json().catch(() => null)) as {
      sessionId?: string;
      sessionFile?: string;
      total?: number;
      requested?: number;
      truncated?: boolean;
      entries?: unknown;
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      return { ...base, reason: `审计通道返回 HTTP ${res.status}${payload?.error ? `：${payload.error}` : ""}` };
    }
    return {
      available: true,
      sessionId: payload.sessionId || undefined,
      sessionFile: payload.sessionFile || undefined,
      requestedDecisionIds: decisionIds,
      serverRequested: typeof payload.requested === "number" ? payload.requested : undefined,
      truncated: payload.truncated === true,
      totalInSession: typeof payload.total === "number" ? payload.total : undefined,
      entries: parseAuditEntries(payload.entries),
    };
  } catch (err) {
    return {
      ...base,
      reason: `无法连接后端审计通道（${err instanceof Error ? err.message : String(err)}）；请确认 Govio Map 后端已启动。`,
    };
  }
}

/** 默认报告生成：复用 T1.4 的纯函数（图表静态渲染 + 附录 B），不触发它自带的下载。 */
async function buildReportHtml(
  input: {
    nodes: Node[];
    edges: Edge[];
    exportedAt: string;
    appVersion?: string;
    apiBase: string;
  },
  fetchImpl: typeof fetch,
): Promise<string> {
  const [chartResults, audit] = await Promise.all([
    renderChartImages(input.nodes),
    fetchAuditForBundle(collectPermissionDecisionIds(input.nodes), input.apiBase, fetchImpl),
  ]);
  return buildDeliveryReportHtml({
    nodes: input.nodes,
    edges: input.edges,
    exportedAt: input.exportedAt,
    appVersion: input.appVersion,
    chartResults,
    audit,
  });
}

/** 把后端 HTTP 状态翻译成用户能懂的话（不静默失败、不抛裸状态码）。 */
async function describeBundleResponse(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string; bytes?: number; limitBytes?: number } | null;
  if (res.status === 409) throw new BundlePayloadError("当前没有活动会话，无法打包导出（先发一条消息或打开一个历史会话）。");
  if (res.status === 404) throw new BundlePayloadError("会话文件不存在（可能已被删除），无法打包导出。");
  if (res.status === 400) throw new BundlePayloadError("会话路径不合法，已拒绝导出。");
  if (res.status === 413) {
    const mb = (n?: number) => (typeof n === "number" ? `${(n / 1024 / 1024).toFixed(1)} MB` : "?");
    throw new BundlePayloadError(`会话文件过大（${mb(body?.bytes)} > 上限 ${mb(body?.limitBytes)}），无法打包导出。`);
  }
  throw new BundlePayloadError(`后端打包通道返回 HTTP ${res.status}${body?.error ? `：${body.error}` : ""}`);
}

function assertPayloadShape(payload: unknown): SessionBundlePayload {
  const p = payload as Partial<SessionBundlePayload> | null;
  if (!p || typeof p !== "object") throw new BundlePayloadError("后端打包载荷不是 JSON 对象。");
  if (p.format !== BUNDLE_FORMAT) throw new BundlePayloadError(`后端打包载荷 format 不符：期望 ${BUNDLE_FORMAT}，实际 ${String(p.format)}。`);
  if (p.version !== BUNDLE_VERSION) throw new BundlePayloadError(`后端打包载荷版本不符：本端支持 v${BUNDLE_VERSION}，实际 v${String(p.version)}（请升级前端或后端）。`);
  if (typeof p.token !== "string" || typeof p.sessionId !== "string" || typeof p.exportedAt !== "string") {
    throw new BundlePayloadError("后端打包载荷缺 token/sessionId/exportedAt。");
  }
  if (!Array.isArray(p.files)) throw new BundlePayloadError("后端打包载荷缺 files 清单。");
  for (const f of p.files) {
    if (typeof f?.path !== "string" || typeof f?.sha256 !== "string" || typeof f?.contentBase64 !== "string") {
      throw new BundlePayloadError("后端打包载荷的 files 条目形状不符（缺 path/sha256/contentBase64）。");
    }
    if (!isSafeBundlePath(f.path)) {
      throw new BundlePayloadError(`后端打包载荷含非法包内路径：${f.path}（已拒绝，防目录穿越）`);
    }
  }
  return p as SessionBundlePayload;
}

/**
 * 打包导出当前会话。
 *
 * @throws {BundlePayloadError} 无活动会话 / 载荷形状不符 / 超限 / 非法包内路径 / 无 crypto.subtle
 */
export async function exportSessionBundle(deps: ExportBundleDeps): Promise<ExportBundleOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hashBytes = deps.hashBytes ?? subtleSha256;
  const download = deps.download ?? downloadZip;
  const downloadText = deps.downloadText ?? downloadTextFile;
  const buildReport = deps.buildReport ?? ((input: Parameters<NonNullable<ExportBundleDeps["buildReport"]>>[0]) => buildReportHtml(input, fetchImpl));
  const apiBase = apiBaseFrom(deps.pageOrigin) ?? "";

  const res = await fetchImpl(`${apiBase}/api/session-bundle`);
  if (!res.ok) await describeBundleResponse(res);
  const payload = assertPayloadShape(await res.json());

  // zip 条目的时间戳统一取服务端导出时间 ⇒ 同一会话内容两次打包字节一致（可复现归档）。
  const mtime = new Date(payload.exportedAt);
  const entries: Zippable = {};
  const manifestFiles: BundleManifest["files"] = [];
  for (const f of payload.files) {
    entries[f.path] = [base64ToBytes(f.contentBase64), { mtime }];
    manifestFiles.push({ path: f.path, bytes: f.bytes, sha256: f.sha256 });
  }

  // report.html：从**包内的 canvas.json**（而不是画布 store 的实时状态）生成，保证包内自洽 ——
  // T3.7 导入后看到的画布与这份报告说的是同一个东西。空画布不生成报告，原因如实记账。
  let reportIncluded = false;
  let reportOmitted: string | undefined;
  const canvasEntry = payload.files.find((f) => f.path === BUNDLE_CANVAS_PATH);
  const canvas = canvasEntry
    ? (JSON.parse(new TextDecoder().decode(base64ToBytes(canvasEntry.contentBase64))) as { nodes?: Node[]; edges?: Edge[] })
    : null;
  const nodes = Array.isArray(canvas?.nodes) ? (canvas!.nodes as Node[]) : [];
  const edges = Array.isArray(canvas?.edges) ? (canvas!.edges as Edge[]) : [];
  if (!canvasEntry) {
    reportOmitted = "会话没有画布 sidecar（canvas.json），未生成交付报告";
  } else if (nodes.length === 0) {
    reportOmitted = "画布为空，未生成交付报告";
  } else {
    const html = await buildReport({ nodes, edges, exportedAt: payload.exportedAt, appVersion: deps.appVersion, apiBase });
    const bytes = strToU8(html);
    entries[BUNDLE_REPORT_PATH] = [bytes, { mtime }];
    manifestFiles.push({ path: BUNDLE_REPORT_PATH, bytes: bytes.byteLength, sha256: await hashBytes(bytes) });
    reportIncluded = true;
  }

  // bundle.json 最后组装（它要列出除自己以外的全部文件；自引用无法计算校验和）。
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    token: payload.token,
    sessionId: payload.sessionId,
    exportedAt: payload.exportedAt,
    files: manifestFiles,
    missing: payload.missing,
    excluded: payload.excluded,
  };
  if (deps.appVersion) manifest.appVersion = deps.appVersion;
  if (payload.storageProfile) manifest.storageProfile = payload.storageProfile;
  if (reportOmitted) manifest.reportOmitted = reportOmitted;
  const manifestText = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  entries[BUNDLE_MANIFEST_PATH] = [manifestText, { mtime }];

  const zipped = zipSync(entries, { level: 6 });
  const fileName = bundleFileName(payload.token);
  download(fileName, zipped);

  // X27：整包校验和（对**最终 zip 字节**求哈希，不是对清单内容），并落一个 sha256sum 兼容的旁文件。
  // 为什么另发旁文件而不塞进包内：包内任何文件都改变 zip 字节 ⇒ 校验和无法自洽（自引用不可算）。
  const bundleSha256 = await hashBytes(zipped);
  const checksumFileName = bundleChecksumFileName(fileName);
  downloadText(checksumFileName, formatBundleChecksum(bundleSha256, fileName));

  return {
    fileName,
    bytes: zipped.byteLength,
    fileCount: manifestFiles.length + 1, // + bundle.json 自身
    token: payload.token,
    sessionId: payload.sessionId,
    reportIncluded,
    excludedParquet: { count: payload.excluded?.parquet?.count ?? 0, bytes: payload.excluded?.parquet?.bytes ?? 0 },
    bundleSha256,
    checksumFileName,
  };
}
