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
