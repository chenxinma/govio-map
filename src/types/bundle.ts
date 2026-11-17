/**
 * T3.6 session 打包（`/export`）的**线上契约**：前后端共享类型与常量。
 *
 * 分工（与 T3.5 的 `src/types/share.ts` 同款约定）：
 * - 服务端 `server/session-bundle.ts` 读会话文件集，产出 {@link SessionBundlePayload}
 *   （含逐文件 sha256 与 base64 内容）；
 * - 前端 `src/commands/export-session.ts` 补 `report.html`（浏览器里静态渲染图表，保真度
 *   只有浏览器能给）与包根 `bundle.json`，用 fflate 打成 zip 后走 `a[download]` 下载；
 * - T3.7 导入只认 `bundle.json`（格式版本 / 文件清单 / 逐文件校验和），**不依赖文件名**。
 *
 * 不变性职责：只读分享（T3.5）是**活视图**，内容随源画布变化；本打包产物是**不可变留痕**
 * ——同一个 session token 对应同一份可归档、可离线校验的产物（用户裁决 2026-11-15 第 4 条）。
 */

/** 包格式标识；T3.7 导入时第一个要核对的字段。 */
export const BUNDLE_FORMAT = "govio-session-bundle";

/** 包格式版本；清单/布局不兼容变更时递增（T3.7 拒绝未知版本）。 */
export const BUNDLE_VERSION = 1;

/** 包根清单文件的固定路径（T3.7 的唯一校验入口）。 */
export const BUNDLE_MANIFEST_PATH = "bundle.json";

/** T1.4 交付报告在包内的固定路径（可读入口，用户裁决 ①）。 */
export const BUNDLE_REPORT_PATH = "report.html";

/** 包内固定路径：会话 transcript（pi `.jsonl`）。 */
export const BUNDLE_SESSION_PATH = "session.jsonl";

/** 包内固定路径：画布 sidecar（`.canvas.json` 的内容，含节点内固化的 Manifest）。 */
export const BUNDLE_CANVAS_PATH = "canvas.json";

/** 包内固定路径：从画布节点派生的 Manifest 清单（便利产物，真源仍是 canvas.json）。 */
export const BUNDLE_MANIFESTS_PATH = "manifests.json";

/** 包内固定路径：权限确认留痕（`.audit.jsonl`，T1.3）。 */
export const BUNDLE_AUDIT_PATH = "audit.jsonl";

/** 包内固定路径：图谱注入留痕（`.injection.jsonl`，T2.1）。 */
export const BUNDLE_INJECTION_PATH = "injection.jsonl";

/** 包文件后缀；完整包名 = `<token>.govio-bundle.zip`（见 {@link bundleFileName}）。 */
export const BUNDLE_SUFFIX = ".govio-bundle.zip";

/** 包名：与 T3.5 分享同一个 session 指纹 token ⇒「同一 token → 同一份可归档产物」。 */
export function bundleFileName(token: string): string {
  return `${token}${BUNDLE_SUFFIX}`;
}

/**
 * 包内路径是否安全（**两端共用**：打包时自查，T3.7 解包前再校一次）。
 *
 * 只允许单层、正斜杠、相对路径：拒绝对路径、`..` 穿越、盘符、反斜杠、空段与尾斜杠。
 * zip-slip 的正经防线在解包侧（包可能来自别人），但打包侧也不得把一个非法路径
 * 写进自己产出的包里——否则就是在制作攻击样本。
 */
export function isSafeBundlePath(path: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  if (path.length > 255) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\")) return false; // 反斜杠：Windows 分隔符不得进包，也防 `..\` 形态
  if (/^[A-Za-z]:/.test(path)) return false; // 盘符（C:）
  const segments = path.split("/");
  // 单层布局：本格式没有子目录（保留能力但不开放，避开解包侧的递归路径风险）。
  if (segments.length !== 1) return false;
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

/** 服务端读到的单个包内文件（base64 传输，sha256 由服务端计算 ⇒ 校验和是权威值）。 */
export interface BundleFileEntry {
  /** 包内相对路径，**一律正斜杠**，不含绝对路径与 `..`（T3.7 解包前会再校验一次）。 */
  path: string;
  /** 原始字节数（不是 base64 长度）。 */
  bytes: number;
  /** 原始字节的 sha256（小写 hex）。 */
  sha256: string;
  /** 原始字节的 base64。 */
  contentBase64: string;
}

/** 被排除的大数据文件记账（用户裁决 ③：默认排除，但必须让接收方知道缺什么）。 */
export interface BundleExcludedParquet {
  /** 画布引用到的、磁盘上确实存在的 parquet 个数。 */
  count: number;
  /** 这些 parquet 的合计字节数。 */
  bytes: number;
  /** parquet 文件名（不含目录），排序后给出，便于接收方按需另行索取。 */
  names: string[];
  /** 画布引用到但磁盘上已不存在的 DataFrame 名（复跑/预览会失败，如实记账）。 */
  absent: string[];
}

/**
 * `GET /api/session-bundle` 的载荷：服务端读到的会话文件集。
 * **不含** `report.html`（浏览器生成）与 `bundle.json`（前端最后组装）。
 */
export interface SessionBundlePayload {
  format: string;
  version: number;
  /** T3.5 的 session 指纹 token（`deriveShareToken(sessionId)`），不要求该会话已开启分享。 */
  token: string;
  sessionId: string;
  /** 服务端时钟的导出时间（ISO 8601）；同一份产物内所有时间戳以它为准，保证可复现。 */
  exportedAt: string;
  files: BundleFileEntry[];
  /** 磁盘上不存在的可选包内文件（如没有审计留痕）；如实记账，不静默省略。 */
  missing: string[];
  excluded: { parquet: BundleExcludedParquet };
  /**
   * T3.1 S3 绑定的 **profile 引用名**（主会话裁定 C1：`.storage.json` 本体不入包）。
   * 无绑定时该键缺省。凭据值、endpoint、bucket 一律不出现在包里。
   */
  storageProfile?: string;
}

/** 包根 `bundle.json`：T3.7 导入前校验的唯一入口。 */
export interface BundleManifest {
  format: string;
  version: number;
  token: string;
  sessionId: string;
  exportedAt: string;
  /** 导出端应用版本（`__APP_VERSION__`）；拿不到时缺省。 */
  appVersion?: string;
  /**
   * 包内**全部**文件（含 `report.html`）；**不含 `bundle.json` 自身**——自引用无法计算校验和。
   * 路径与 zip 内条目一一对应，T3.7 逐条核对 sha256。
   */
  files: Array<{ path: string; bytes: number; sha256: string }>;
  /** 服务端就没读到的可选文件（与 {@link SessionBundlePayload.missing} 同值透传）。 */
  missing: string[];
  excluded: { parquet: BundleExcludedParquet };
  storageProfile?: string;
  /** `report.html` 未生成时的原因（空画布等）；生成了则缺省。 */
  reportOmitted?: string;
}

// ── T3.7 导入（`/import <bundle 路径>`）────────────────────────────────────
//
// 与导出共用上面那份包契约：导入侧只认 `bundle.json`（format/version/files/sha256），
// **不依赖文件名**，也不接受清单之外的任何条目（主会话裁定口径 ⑥）。

/** 导入 sidecar `<session>.jsonl.import.json` 的格式版本。 */
export const IMPORT_META_VERSION = 1;

/**
 * 导入失败原因码（服务端 `session-import.ts` 抛出，HTTP 层按码映射状态与人话文案）。
 *
 * 一律是**稳定字符串**而不是自由文本：前端据此给中文提示，测试据此逐条断言拒绝路径，
 * 文档（`docs/specs/06-backend.md`）据此列错误码表。
 */
export const IMPORT_ERROR_CODES = [
  /** 路径为空 / 含 NUL / UNC / 设备路径 / 非 `.zip` 扩展名（decisions ⑤ 读侧校验）。 */
  "invalid-path",
  /** 路径合法但磁盘上不存在。 */
  "bundle-not-found",
  /** 存在但不是常规文件（目录 / symlink / 设备）——decisions ⑤ 明确拒 symlink。 */
  "not-a-file",
  /** zip 文件本体超过 {@link MAX_IMPORT_ZIP_BYTES}。 */
  "bundle-too-large",
  /** 不是合法 zip（或压缩方式不受支持）。 */
  "bundle-unreadable",
  /** 包内条目数超过 {@link MAX_IMPORT_FILE_COUNT}。 */
  "too-many-files",
  /** 解压后总体积超过 {@link MAX_IMPORT_UNCOMPRESSED_BYTES}（zip 炸弹闸门）。 */
  "uncompressed-too-large",
  /** 包内条目名不安全（绝对路径 / `..` / 反斜杠 / 子目录），即 zip-slip 样本。 */
  "unsafe-entry",
  /** 包内出现重名条目（清单无法唯一对应）。 */
  "duplicate-entry",
  /** 包内没有 `bundle.json`。 */
  "manifest-missing",
  /** `bundle.json` 不是合法 JSON 或缺必需字段。 */
  "manifest-invalid",
  /** `format` 不是 {@link BUNDLE_FORMAT}。 */
  "format-mismatch",
  /** `version` 不被本端支持（高于 {@link BUNDLE_VERSION} 或非法）。 */
  "version-unsupported",
  /** 清单列了但包里没有的文件。 */
  "entry-missing",
  /** 包里有但清单没列的文件（口径 ⑥：整包拒绝）。 */
  "entry-unexpected",
  /** 逐文件 sha256 或字节数与清单不符。 */
  "checksum-mismatch",
  /** 包内某个 JSON 工件（`canvas.json` / `manifests.json`）解析失败或形状不符。 */
  "payload-invalid",
  /** `session.jsonl` 不是合法 pi transcript（首条不是 session header）。 */
  "transcript-invalid",
  /** 目标会话文件已存在——decisions ②：不提供覆盖。 */
  "target-conflict",
  /** 校验全绿后落盘失败（I/O 层）。 */
  "write-failed",
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

/** 上限常量（服务端 `session-import.ts` 为权威值，此处供前端提示与文档引用）。 */
export const MAX_IMPORT_ZIP_BYTES = 64 * 1024 * 1024;
/** 解压后总体积上限：zip 炸弹闸门，按 deflate 最大膨胀比留足余量后取 4× 导出上限。 */
export const MAX_IMPORT_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** 包内条目数上限：单层布局正常只有 ≤7 个文件，32 已是很宽的余量。 */
export const MAX_IMPORT_FILE_COUNT = 32;

/**
 * 导入来源标注（decisions ②：新 id + 保留来源，可区分原生与导入会话）。
 * 落点见 `docs/tasks/T3.7-import-session-bundle/design.md`：`.import.json` sidecar 为权威记录，
 * 画布 sidecar 顶层同名键为血缘邻近信息；两者都**不进** WS 契约（X2 零改动）。
 */
export interface ImportedFrom {
  /** 源会话指纹 token（= `bundle.json.token`，与 T3.5 分享同一派生口径）。 */
  token: string;
  /** 源实例的导出时间（`bundle.json.exportedAt`）。 */
  exportedAt: string;
  /** 源会话 id（`bundle.json.sessionId`，即源实例上的会话文件名主干）。 */
  originalSessionId: string;
  /** 源会话显示名（从包内 transcript 的 `session_info` 取最新一条；没有则 null）。 */
  originSessionName: string | null;
  /** 包文件名（不含目录）——只记名字，**不记源路径**（避免把源机器的目录布局写进留痕）。 */
  bundleFileName: string;
  /** 本机导入时间（ISO 8601）。 */
  importedAt: string;
}

/** `POST /api/session-import` 的成功载荷，也是 `.import.json` sidecar 的内容。 */
export interface SessionImportResult {
  /** 本机新生成的会话 id（transcript header 已改写为它）。 */
  sessionId: string;
  /** 新会话文件绝对路径（前端可直接交给既有 `session_open`）。 */
  sessionFile: string;
  /** 显示名（来自包内 transcript；无则 null）。 */
  sessionName: string | null;
  /** 包内 transcript 的消息条数（`type:"message"`）。 */
  messageCount: number;
  nodeCount: number;
  edgeCount: number;
  /** 画布节点内固化的 Analysis Manifest 条数（与包内 `manifests.json` 一致）。 */
  manifestCount: number;
  importedFrom: ImportedFrom;
  /**
   * 落地为会话文件的**包内路径**（正斜杠相对名）。
   * `report.html` 与 `manifests.json` 只参与校验、**不落地**（前者是给人看的导出产物，
   * 后者是 canvas.json 的派生便利产物，写进 sessions 目录只会制造孤儿文件）。
   * 另外恒定多写一个 `.import.json` 来源 sidecar（不属包内路径，见 {@link SessionImportMeta}）。
   */
  filesWritten: string[];
  /** 源包里就缺的可选文件（`bundle.json.missing` 透传）。 */
  missing: string[];
  /** 源包排除的大数据记账（透传）——导入后预览/复跑降级提示的依据。 */
  excludedParquet: BundleExcludedParquet;
  /** 源实例曾绑定的 S3 profile 名（decisions ③：本机不自动绑定，仅告知）。 */
  storageProfile?: string;
}

/** `.import.json` sidecar 的落盘形状。 */
export interface SessionImportMeta {
  version: typeof IMPORT_META_VERSION;
  importedFrom: ImportedFrom;
  filesWritten: string[];
  missing: string[];
  excludedParquet: BundleExcludedParquet;
  storageProfile?: string;
}
