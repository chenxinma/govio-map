/**
 * T3.6 session 打包（`/export`）的**服务端文件集收集**。
 *
 * 职责边界：服务端只做「把属于这个会话的文件读出来 + 算校验和 + 给排除项记账」，
 * **不生成 zip、不生成 report.html**——图表静态渲染要借浏览器里的 Plotly（见
 * `src/utils/export-report.ts` 的 `renderChartImages`），所以打包在前端完成
 * （`src/commands/export-session.ts`）。取舍论证见 `docs/tasks/T3.6-export-session-bundle/design.md`。
 *
 * 只读纪律：本模块不写任何文件、不执行命令、不改画布；只 `readFileSync` 会话自己的
 * sidecar。凭据边界：`.storage.json` **本体不入包**，只把 profile 引用名放进载荷
 * （主会话裁定 C1）；`.env`、profiles 文件、S3 凭据一律不读不传。
 *
 * 包内路径一律用 `src/types/bundle.ts` 的常量（正斜杠、无目录层级），T3.7 按同一份
 * 常量解包 ⇒ 两边不会各写一套命名。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { assertValidSessionPath, loadCanvas } from "./session-history.js";
import { auditPathFor } from "./permission-audit.js";
import { injectionTracePathFor } from "./prompt-injection.js";
import { readStorageBinding } from "./storage/canvas-storage.js";
import { canvasPathFor, dataframeParquetPathFor } from "./storage/paths.js";
import { deriveShareToken, extractManifests, sessionIdFromFile } from "./share.js";
import {
  BUNDLE_AUDIT_PATH,
  BUNDLE_CANVAS_PATH,
  BUNDLE_FORMAT,
  BUNDLE_INJECTION_PATH,
  BUNDLE_MANIFESTS_PATH,
  BUNDLE_SESSION_PATH,
  BUNDLE_VERSION,
  type BundleExcludedParquet,
  type BundleFileEntry,
  type SessionBundlePayload,
} from "../src/types/bundle.js";

/**
 * 单次打包允许读取的会话文件总字节数上限。
 *
 * 64MB 的依据：产物要在浏览器里 base64 解码 + fflate 压缩（都在主线程），
 * 再大就不是「导出一个会话」而是「搬数据」了；parquet 这类大数据本来就排除在外
 * （用户裁决 ③），正常会话的 transcript + sidecar 远低于此值。超限走 HTTP 413，
 * 前端给出明确提示而不是静默截断。
 */
export const MAX_BUNDLE_TOTAL_BYTES = 64 * 1024 * 1024;

/** 会话文件不存在（路径合法但磁盘上没有）。 */
export class BundleSessionNotFoundError extends Error {
  readonly sessionPath: string;
  constructor(sessionPath: string) {
    super(`session file not found: ${sessionPath}`);
    this.name = "BundleSessionNotFoundError";
    this.sessionPath = sessionPath;
  }
}

/** 会话文件总量超过 {@link MAX_BUNDLE_TOTAL_BYTES}。 */
export class BundleTooLargeError extends Error {
  readonly bytes: number;
  readonly limitBytes: number;
  readonly path: string;
  constructor(bytes: number, limitBytes: number, path: string) {
    super(`session bundle too large: ${bytes} bytes > ${limitBytes} bytes (at ${path})`);
    this.name = "BundleTooLargeError";
    this.bytes = bytes;
    this.limitBytes = limitBytes;
    this.path = path;
  }
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** stat 失败按 0 计：文件名仍然如实记账，不因统计失败丢掉「缺什么」的信息。 */
function fileSizeOrZero(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 画布引用到的 parquet 记账（**不入包**，但要让接收方知道缺什么 —— 用户裁决 ③）。
 *
 * dfName 取自节点 Manifest（`manifest.dfName`），退回节点 data 上的同名字段；
 * 名字不是安全标识符或文件已不在磁盘上 → 记进 `absent`（T3.7 导入后复跑/预览
 * 会失败，届时按这份记账给降级提示，而不是静默失败）。
 */
export function excludedParquetOf(nodes: unknown[]): BundleExcludedParquet {
  const wanted = new Set<string>();
  for (const raw of nodes) {
    const node = raw as { data?: { dfName?: unknown; manifest?: { dfName?: unknown } } };
    const dfName = node?.data?.manifest?.dfName ?? node?.data?.dfName;
    if (typeof dfName === "string" && dfName !== "") wanted.add(dfName);
  }
  const names: string[] = [];
  const absent: string[] = [];
  let bytes = 0;
  for (const dfName of [...wanted].sort()) {
    const file = dataframeParquetPathFor(dfName);
    if (!file || !existsSync(file)) {
      absent.push(dfName);
      continue;
    }
    names.push(`${dfName}.parquet`);
    bytes += fileSizeOrZero(file);
  }
  return { count: names.length, bytes, names, absent };
}

export interface CollectSessionBundleOptions {
  /** 导出时间来源（测试注入固定时钟，保证同一输入产出同一份载荷）。 */
  now?: () => Date;
  /** 总量上限覆盖（测试用）；缺省 {@link MAX_BUNDLE_TOTAL_BYTES}。 */
  maxTotalBytes?: number;
}

/**
 * 收集一个会话的可归档文件集。
 *
 * @param sessionPath 客户端传入或服务端会话单例给出的路径；一律过
 *   {@link assertValidSessionPath}（必须是 sessions 目录内的 `.jsonl`），防目录穿越。
 * @throws {BundleSessionNotFoundError} 路径合法但文件不存在
 * @throws {BundleTooLargeError} 文件总量超过 {@link MAX_BUNDLE_TOTAL_BYTES}
 */
export function collectSessionBundle(
  sessionPath: string,
  opts: CollectSessionBundleOptions = {},
): SessionBundlePayload {
  const sessionFile = assertValidSessionPath(sessionPath);
  if (!existsSync(sessionFile)) throw new BundleSessionNotFoundError(sessionPath);

  const sessionId = sessionIdFromFile(sessionFile);
  const exportedAt = (opts.now ?? ((): Date => new Date()))().toISOString();
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_BUNDLE_TOTAL_BYTES;

  const files: BundleFileEntry[] = [];
  const missing: string[] = [];
  let totalBytes = 0;

  /** 读一个磁盘文件进包；`optional` 为真且文件不存在时记进 missing（如实记账，不静默省略）。 */
  const addFile = (bundlePath: string, absPath: string, optional: boolean): void => {
    if (!existsSync(absPath)) {
      if (!optional) throw new BundleSessionNotFoundError(absPath);
      missing.push(bundlePath);
      return;
    }
    const content = readFileSync(absPath);
    totalBytes += content.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new BundleTooLargeError(totalBytes, maxTotalBytes, bundlePath);
    }
    files.push({
      path: bundlePath,
      bytes: content.byteLength,
      sha256: sha256Hex(content),
      contentBase64: content.toString("base64"),
    });
  };

  /** 派生内容入包（不来自磁盘，字节由本次序列化决定）。 */
  const addDerived = (bundlePath: string, text: string): void => {
    const content = Buffer.from(text, "utf-8");
    totalBytes += content.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new BundleTooLargeError(totalBytes, maxTotalBytes, bundlePath);
    }
    files.push({
      path: bundlePath,
      bytes: content.byteLength,
      sha256: sha256Hex(content),
      contentBase64: content.toString("base64"),
    });
  };

  // 会话 transcript（对话）：打包的核心内容，缺了就没有「会话」可归档。
  addFile(BUNDLE_SESSION_PATH, sessionFile, false);
  // 画布 sidecar：节点/边 + 节点内固化的 Analysis Manifest（T1.1 的落点就在节点 data 上）。
  addFile(BUNDLE_CANVAS_PATH, canvasPathFor(sessionFile), true);

  // Manifest 清单：**派生**便利产物（真源仍是 canvas.json 的 node.data.manifest），
  // 让接收方不解画布也能核对留痕；空画布时是 `[]`，同样是事实，照入包。
  const canvas = loadCanvas(sessionFile);
  addDerived(BUNDLE_MANIFESTS_PATH, JSON.stringify(canvas ? extractManifests(canvas.nodes) : []));

  // 权限确认留痕（T1.3）与图谱注入留痕（T2.1）：都是会话级 sidecar，随包归档。
  addFile(BUNDLE_AUDIT_PATH, auditPathFor(sessionFile), true);
  addFile(BUNDLE_INJECTION_PATH, injectionTracePathFor(sessionFile), true);

  // 明确不入包（design.md 清单逐项取舍）：
  //  - `.storage.json`：只取 profile 引用名（凭据/endpoint/bucket 一律不出现在包里）
  //  - `.share.json`：分享开关是本机运行态，不是归档内容（撤销状态跟着源实例走）
  //  - `.injection.zip`：旧格式孤儿残留
  //  - parquet 等大数据：只记账（下面 excluded）
  const binding = readStorageBinding(sessionFile);
  const payload: SessionBundlePayload = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    token: deriveShareToken(sessionId),
    sessionId,
    exportedAt,
    files,
    missing,
    excluded: { parquet: excludedParquetOf(canvas?.nodes ?? []) },
  };
  if (binding?.profile) payload.storageProfile = binding.profile;
  return payload;
}
