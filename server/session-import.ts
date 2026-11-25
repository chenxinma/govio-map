/**
 * T3.7 session 打包**导入**：把 T3.6 `/export` 产出的 `<token>.govio-bundle.zip` 落地为
 * 本机 `.govio/sessions/` 里的一个**历史会话**（transcript + 画布 + 审计/注入留痕 + 来源标注）。
 *
 * 三条硬纪律（用户裁决，见 `docs/task-plan.json → T3.7.decisions`）：
 *
 * 1. **原子性（④）**：`bundle.json` 的格式版本、文件清单、逐文件 sha256 全部校验通过之前
 *    **一个字节都不落盘**。实现上不靠「先解到临时目录」，而是**全程在内存里校验**——
 *    校验通过后一次性写盘；写盘中途失败则回滚已写文件（{@link rollback}）。
 *    这比临时目录更强：失败路径下 sessions 目录连隐藏残留都不会有。
 * 2. **读宽写严（⑤）**：包文件可以从任意路径读（`D:/Downloads/xxx.zip` 也行），但读侧要过
 *    {@link resolveBundlePath} 的六道校验（非空/无 NUL/非 UNC 与设备路径/`.zip` 扩展名/
 *    常规文件而非 symlink 或目录/体积上限）；**写侧一律只落 `getSessionDir()` 内**，
 *    且目标文件名由本机生成（{@link newSessionFileName}），包内路径永不参与拼接落盘路径。
 * 3. **清单即白名单（⑥）**：包内出现 `bundle.json` 未列的任何条目 → 整包拒绝
 *    （`entry-unexpected`）；清单列了但包里没有 → `entry-missing`；sha256/字节数不符 →
 *    `checksum-mismatch`。本期不做外层签名（`bundle.json` 无法自列校验和），剩余风险见
 *    `docs/tasks/T3.7-import-session-bundle/design.md`「遗留问题」。
 *
 * 为什么必须改写 transcript header：`SessionManager.list(cwd, sessionDir)` 在 sessionDir 不是
 * pi 默认目录时会按 **header 里的 `cwd`** 过滤（`sessionCwdMatches`），且 `SessionInfo.id` 直接取
 * **header 的 `id`**。所以照抄源 header 的包，导进来要么因为 cwd 是源机器路径而**在列表里根本不出现**，
 * 要么与源会话 id 撞车。故落地时把 header 的 `id` 换成本机新 uuid、`cwd` 换成本机 cwd、
 * `parentSession` 置 null（源机器的父会话路径在本机不可解析）；**其余每一行保持字节原样**
 * （append-only 留痕的不可变性，测试逐字节断言）。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { unzipSync, type Unzipped, type UnzipFileInfo } from "fflate";
import { getSessionDir } from "./session-history.js";
import { auditPathFor } from "./permission-audit.js";
import { injectionTracePathFor } from "./prompt-injection.js";
import { canvasPathFor, importMetaPathFor } from "./storage/paths.js";
import {
  BUNDLE_AUDIT_PATH,
  BUNDLE_CANVAS_PATH,
  BUNDLE_FORMAT,
  BUNDLE_INJECTION_PATH,
  BUNDLE_MANIFEST_PATH,
  BUNDLE_MANIFESTS_PATH,
  BUNDLE_SESSION_PATH,
  BUNDLE_VERSION,
  IMPORT_META_VERSION,
  MAX_IMPORT_FILE_COUNT,
  MAX_IMPORT_UNCOMPRESSED_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  isSafeBundlePath,
  normalizeBundleChecksum,
  type BundleExcludedParquet,
  type BundleManifest,
  type ImportErrorCode,
  type ImportedFrom,
  type SessionImportMeta,
  type SessionImportResult,
} from "../src/types/bundle.js";

/** 导入失败：带稳定错误码（HTTP 层按码映射状态与文案，测试按码逐条断言）。 */
export class BundleImportError extends Error {
  readonly code: ImportErrorCode;
  /** 补充信息（如不符的 sha256、fs 错误码）。**绝不含包内文件内容**。 */
  readonly detail?: string;
  constructor(code: ImportErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "BundleImportError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ImportSessionBundleOptions {
  /** 时钟注入（测试固定 `importedAt` 与文件名时间戳）。 */
  now?: () => Date;
  /** 会话 id 注入（测试用确定值；缺省 `randomUUID()`）。 */
  newSessionId?: () => string;
  /** 上限覆盖（测试用小值触发闸门，不必真造 64MB 包）。 */
  maxZipBytes?: number;
  maxUncompressedBytes?: number;
  maxFileCount?: number;
  /**
   * 写进 transcript header 的 cwd（缺省 `process.cwd()`）。
   *
   * 必须是**与 `listSessions()` 比较时用的同一个值**：pi 的 `SessionManager.list(cwd, dir)`
   * 在 dir 不是 pi 默认目录时按 header.cwd 做**大小写敏感**的 `resolvePath` 比较，
   * 而 `server/session-history.ts` 传的就是 `process.cwd()`。X7 已在启动链路
   * （`applyCanonicalCwd()`）把 `process.cwd()` 规范成磁盘大小写，所以这里直接取它；
   * 反而**不能**再做一次 `realpathSync.native`（符号链接场景下会与比较基准不一致）。
   */
  cwd?: string;
  /**
   * 会话目录覆盖（缺省 `getSessionDir()`）。仅供测试用 tmp 目录隔离；写侧仍然只能
   * 是这一个目录（包内路径不参与拼接），所以它**不削弱** decisions ⑤ 的写侧约束。
   */
  sessionDir?: string;
  /**
   * 期望的**整包** sha256（X27 旁文件值，64 位 hex）。给了就必须相符。
   *
   * 发生在读包之后、解包之前，与 decisions ④ 一致（不符则不碰任何文件）；
   * 与清单内的逐文件校验和互补：这一层保护的是「zip 字节本身未被改动」，
   * 也就是 `bundle.json` 无法自列校验和所造成的剩余风险。
   */
  expectedBundleSha256?: string;
  /**
   * 写盘实现注入点（与 `now` / `newSessionId` 同款测试缝）。
   *
   * 存在理由：decisions ④ 要求「任何失败路径都断言零文件写入」，而回滚分支只在
   * **写盘中途失败**时才走得到；ESM 下 `vi.spyOn(fs, "writeFileSync")` 会被
   * 「module namespace is not configurable」拦住，没法从测试侧造这个失败。
   */
  writeFileImpl?: (target: string, bytes: string | Buffer) => void;
}

const EMPTY_PARQUET: BundleExcludedParquet = { count: 0, bytes: 0, names: [], absent: [] };

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 读侧路径校验（decisions ⑤）：把用户给的任意路径收敛成一个「确定是本地 `.zip` 常规文件」的绝对路径。
 *
 * 顺序有讲究：先做**纯字符串**拒绝（NUL / UNC / 设备路径 / 扩展名），再碰文件系统——
 * 这样连 `stat` 都不会对 `\\.\` 设备路径或 `CON` 之类的名字发起，避免奇怪的阻塞或副作用。
 */
export function resolveBundlePath(raw: string, maxZipBytes = MAX_IMPORT_ZIP_BYTES): string {
  if (typeof raw !== "string") {
    throw new BundleImportError("invalid-path", "导入路径必须是字符串");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new BundleImportError("invalid-path", "导入路径为空：用法 /import <bundle 路径>");
  }
  if (trimmed.includes("\0")) {
    throw new BundleImportError("invalid-path", "导入路径含非法字符（NUL），已拒绝");
  }
  // UNC（\\host\share、//host/share）与 Windows 设备路径（\\.\C:、\\?\C:）一律拒绝：
  // 它们可能指向网络共享或设备命名空间，不属「本机一个 zip 文件」的语义。
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new BundleImportError("invalid-path", "拒绝 UNC / 设备路径，请给本机文件路径", trimmed);
  }
  if (!trimmed.toLowerCase().endsWith(".zip")) {
    throw new BundleImportError("invalid-path", "只接受 .zip 打包文件（T3.6 /export 的产物）", trimmed);
  }
  const resolved = resolvePath(process.cwd(), trimmed);
  if (/^[\\/]{2}/.test(resolved)) {
    throw new BundleImportError("invalid-path", "解析后仍是 UNC / 设备路径，已拒绝", resolved);
  }

  let stat;
  try {
    // lstat 而非 stat：symlink 要**拒**（decisions ⑤），stat 会跟着链接走过去看不出来。
    stat = lstatSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new BundleImportError("bundle-not-found", `找不到打包文件：${resolved}`, code);
    }
    throw new BundleImportError("not-a-file", `无法读取打包文件：${resolved}`, code);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BundleImportError(
      "not-a-file",
      `导入目标必须是常规文件（不能是目录或符号链接）：${resolved}`,
    );
  }
  if (stat.size > maxZipBytes) {
    throw new BundleImportError(
      "bundle-too-large",
      `打包文件过大（${stat.size} 字节 > 上限 ${maxZipBytes} 字节）：${resolved}`,
      `${stat.size}>${maxZipBytes}`,
    );
  }
  return resolved;
}

/**
 * **第一遍：只读 zip 元数据，一个字节都不解压。**
 *
 * fflate 的 `unzipSync(data, { filter })` 会对每个条目回调 `UnzipFileInfo`
 * （`name` / `size` 压缩后 / `originalSize` 解压后 / `compression`），`filter` 返回 `false`
 * 即「不解压这个条目」。于是可以在**解压发生之前**就把条目数、解压后总体积、条目名安全性
 * 全部判完——这是 zip 炸弹的正经防线（先解压再检查的话，内存已经炸了）。
 */
export function inspectBundleEntries(zipBytes: Uint8Array): UnzipFileInfo[] {
  const seen: UnzipFileInfo[] = [];
  try {
    unzipSync(zipBytes, {
      filter: (info) => {
        seen.push({
          name: info.name,
          size: info.size,
          originalSize: info.originalSize,
          compression: info.compression,
        });
        return false; // 元数据遍历：不解压任何条目
      },
    });
  } catch (err) {
    throw new BundleImportError(
      "bundle-unreadable",
      `不是合法的 zip 打包文件（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  return seen;
}

/** 元数据层面的闸门：条目数、解压后总体积、条目名白名单、重名、压缩方式。 */
export function assertBundleEntryLimits(
  entries: UnzipFileInfo[],
  limits: { maxFileCount: number; maxUncompressedBytes: number },
): void {
  if (entries.length > limits.maxFileCount) {
    throw new BundleImportError(
      "too-many-files",
      `包内条目 ${entries.length} 个，超过上限 ${limits.maxFileCount} 个`,
      `${entries.length}>${limits.maxFileCount}`,
    );
  }
  const names = new Set<string>();
  let total = 0;
  for (const e of entries) {
    // zip-slip 防线：条目名必须是单层、正斜杠、相对路径（与打包侧同一个白名单函数）。
    if (!isSafeBundlePath(e.name)) {
      throw new BundleImportError("unsafe-entry", `包内含非法路径条目，已整包拒绝（防目录穿越）`, e.name);
    }
    if (names.has(e.name)) {
      throw new BundleImportError("duplicate-entry", `包内条目重名，清单无法唯一对应`, e.name);
    }
    names.add(e.name);
    // fflate 只支持 store(0) 与 deflate(8)；其它压缩方式解压必抛，提前给明确原因。
    if (e.compression !== 0 && e.compression !== 8) {
      throw new BundleImportError(
        "bundle-unreadable",
        `包内条目使用了不支持的压缩方式（${e.compression}）`,
        e.name,
      );
    }
    total += Math.max(0, e.originalSize || 0);
    if (total > limits.maxUncompressedBytes) {
      throw new BundleImportError(
        "uncompressed-too-large",
        `解压后体积超过上限 ${limits.maxUncompressedBytes} 字节（疑似 zip 炸弹），已拒绝`,
        `${total}>${limits.maxUncompressedBytes}`,
      );
    }
  }
}

/** `bundle.json` 形状与版本校验（导入的唯一信任入口）。 */
export function parseBundleManifest(text: string): BundleManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BundleImportError(
      "manifest-invalid",
      `包内 ${BUNDLE_MANIFEST_PATH} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  const m = raw as Partial<BundleManifest> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new BundleImportError("manifest-invalid", `包内 ${BUNDLE_MANIFEST_PATH} 不是 JSON 对象`);
  }
  if (m.format !== BUNDLE_FORMAT) {
    throw new BundleImportError(
      "format-mismatch",
      `不是 Govio 会话包：format 期望 ${BUNDLE_FORMAT}，实际 ${String(m.format)}`,
    );
  }
  if (m.version !== BUNDLE_VERSION) {
    throw new BundleImportError(
      "version-unsupported",
      `包格式版本不支持：本端支持 v${BUNDLE_VERSION}，包内是 v${String(m.version)}`,
    );
  }
  if (typeof m.token !== "string" || typeof m.sessionId !== "string" || typeof m.exportedAt !== "string") {
    throw new BundleImportError("manifest-invalid", `包内 ${BUNDLE_MANIFEST_PATH} 缺 token/sessionId/exportedAt`);
  }
  if (!Array.isArray(m.files)) {
    throw new BundleImportError("manifest-invalid", `包内 ${BUNDLE_MANIFEST_PATH} 缺 files 清单`);
  }
  for (const f of m.files) {
    if (typeof f?.path !== "string" || typeof f?.bytes !== "number" || typeof f?.sha256 !== "string") {
      throw new BundleImportError("manifest-invalid", `包内清单条目形状不符（缺 path/bytes/sha256）`);
    }
    if (!isSafeBundlePath(f.path)) {
      // 清单里的路径也要过白名单：清单本身可能来自别人。
      throw new BundleImportError("unsafe-entry", `包内清单含非法路径条目，已整包拒绝`, f.path);
    }
    if (f.path === BUNDLE_MANIFEST_PATH) {
      throw new BundleImportError("manifest-invalid", `${BUNDLE_MANIFEST_PATH} 不应把自己列进清单（无法自算校验和）`);
    }
    if (!/^[a-f0-9]{64}$/.test(f.sha256)) {
      throw new BundleImportError("manifest-invalid", `包内清单的 sha256 形状不符`, f.path);
    }
  }
  if (m.excluded?.parquet && typeof m.excluded.parquet !== "object") {
    throw new BundleImportError("manifest-invalid", `包内清单 excluded.parquet 形状不符`);
  }
  return m as BundleManifest;
}

interface TranscriptSummary {
  /** header 行（含行尾）替换后的**完整 transcript 字节**。 */
  bytes: Buffer;
  messageCount: number;
  /** 源会话显示名：取最新一条 `session_info.name`（与 pi `buildSessionInfo` 同口径）。 */
  name: string | null;
}

/**
 * 校验并改写 transcript：首条必须是 `type:"session"` 的 header（否则 pi 的 `buildSessionInfo`
 * 直接返回 null，会话**不会出现在列表里**，等于导了个打不开的东西）。
 *
 * 只改 header 一行的 `id` / `cwd` / `parentSession`，其余字节原样保留（含行尾风格与末尾换行）。
 */
export function rewriteTranscriptHeader(
  content: Uint8Array,
  opts: { newSessionId: string; cwd: string },
): TranscriptSummary {
  const buf = Buffer.from(content);
  const nl = buf.indexOf(0x0a);
  const firstLine = nl === -1 ? buf : buf.subarray(0, nl);
  const hasCRLF = firstLine.byteLength > 0 && firstLine[firstLine.byteLength - 1] === 0x0d;
  const headerText = (hasCRLF ? firstLine.subarray(0, firstLine.byteLength - 1) : firstLine).toString("utf-8");

  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(headerText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    header = parsed as Record<string, unknown>;
  } catch {
    throw new BundleImportError(
      "transcript-invalid",
      `包内 ${BUNDLE_SESSION_PATH} 首行不是合法的会话 header，无法作为 pi 会话落地`,
    );
  }
  if (header.type !== "session" || typeof header.id !== "string") {
    throw new BundleImportError(
      "transcript-invalid",
      `包内 ${BUNDLE_SESSION_PATH} 首条不是 session header（type=${String(header.type)}），已拒绝`,
    );
  }

  // 其余行只做统计，不改动。
  const rest = (nl === -1 ? "" : buf.subarray(nl + 1).toString("utf-8")).split("\n");
  let messageCount = 0;
  let name: string | null = null;
  for (const line of rest) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: { type?: string; name?: unknown };
    try {
      entry = JSON.parse(trimmed) as { type?: string; name?: unknown };
    } catch {
      continue; // 坏行由 pi 自己跳过（parseSessionEntryLine 同款宽容），导入不因它失败
    }
    if (entry?.type === "message") messageCount += 1;
    if (entry?.type === "session_info" && typeof entry.name === "string") {
      name = entry.name.trim() || null;
    }
  }

  const rewritten: Record<string, unknown> = { ...header, id: opts.newSessionId, cwd: opts.cwd };
  // 源机器的父会话路径在本机不可解析，留着只会让「父会话」链路指向空气。
  rewritten.parentSession = null;
  const line = JSON.stringify(rewritten) + (hasCRLF ? "\r" : "");
  const bytes = nl === -1 ? Buffer.from(line, "utf-8") : Buffer.concat([Buffer.from(line, "utf-8"), buf.subarray(nl)]);
  return { bytes, messageCount, name };
}

/** 新会话文件名：沿用本仓/pi 的既有约定 `<ISO时间(冒号点换横杠)>_<uuid>.jsonl`。 */
export function newSessionFileName(now: Date, sessionId: string): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

/** 落盘失败时的回滚：把本次已写的文件删掉，保持「要么全成，要么零残留」。 */
function rollback(written: string[]): void {
  for (const file of written) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* 回滚尽力而为：二次失败不掩盖原始错误 */
    }
  }
}

function parseJsonArtifact(text: string, bundlePath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BundleImportError(
      "payload-invalid",
      `包内 ${bundlePath} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
}

/**
 * 导入一个 T3.6 打包产物。
 *
 * @param bundlePath 包文件路径（可任意位置；过 {@link resolveBundlePath} 六道校验）
 * @throws {BundleImportError} 任何校验失败；**失败时 sessions 目录零写入**
 */
export function importSessionBundle(
  bundlePath: string,
  opts: ImportSessionBundleOptions = {},
): SessionImportResult {
  const maxZipBytes = opts.maxZipBytes ?? MAX_IMPORT_ZIP_BYTES;
  const maxUncompressedBytes = opts.maxUncompressedBytes ?? MAX_IMPORT_UNCOMPRESSED_BYTES;
  const maxFileCount = opts.maxFileCount ?? MAX_IMPORT_FILE_COUNT;
  const writeFile = opts.writeFileImpl ?? ((target: string, bytes: string | Buffer) => writeFileSync(target, bytes));
  const now = (opts.now ?? ((): Date => new Date()))();

  // ── 阶段 1：读侧校验 + 元数据闸门（零解压、零写盘） ───────────────────────
  const resolvedPath = resolveBundlePath(bundlePath, maxZipBytes);
  let zipBytes: Buffer;
  try {
    zipBytes = readFileSync(resolvedPath);
  } catch (err) {
    throw new BundleImportError(
      "not-a-file",
      `读取打包文件失败：${resolvedPath}（${(err as NodeJS.ErrnoException).code ?? "unknown"}）`,
    );
  }
  const entries = inspectBundleEntries(zipBytes);
  assertBundleEntryLimits(entries, { maxFileCount, maxUncompressedBytes });

  // ── 阶段 1.5：外层整包校验和（X27；仍在解包前，失败零写入） ────────────────
  if (opts.expectedBundleSha256) {
    const expected = normalizeBundleChecksum(opts.expectedBundleSha256);
    if (!expected) {
      throw new BundleImportError(
        "outer-checksum-mismatch",
        "整包校验和格式不对（应为 64 位 hex，或 sha256sum 输出的一整行）",
      );
    }
    const actual = sha256Hex(zipBytes);
    if (actual !== expected) {
      throw new BundleImportError(
        "outer-checksum-mismatch",
        "整包校验和不符：手里的 zip 与导出方声称的不是同一份（传输损坏或被替换），已拒绝导入",
        `expected ${expected}, actual ${actual}`,
      );
    }
  }

  // ── 阶段 2：解压 + 清单/校验和逐项核对（仍全程在内存） ─────────────────────
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (err) {
    throw new BundleImportError(
      "bundle-unreadable",
      `解压失败（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  const manifestEntry = unzipped[BUNDLE_MANIFEST_PATH];
  if (!manifestEntry) {
    throw new BundleImportError(
      "manifest-missing",
      `包内缺少 ${BUNDLE_MANIFEST_PATH}，不是可导入的 Govio 会话包`,
    );
  }
  const manifest = parseBundleManifest(Buffer.from(manifestEntry).toString("utf-8"));

  // 清单即白名单（口径 ⑥）：两个方向都要对齐。
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const name of Object.keys(unzipped)) {
    if (name === BUNDLE_MANIFEST_PATH) continue;
    if (!listed.has(name)) {
      throw new BundleImportError(
        "entry-unexpected",
        `包内出现清单未登记的条目，已整包拒绝（防夹带）`,
        name,
      );
    }
  }
  for (const path of listed.keys()) {
    if (!unzipped[path]) {
      throw new BundleImportError("entry-missing", `清单登记的 ${path} 在包里不存在`, path);
    }
  }
  for (const [path, meta] of listed) {
    const bytes = unzipped[path];
    if (bytes.byteLength !== meta.bytes) {
      throw new BundleImportError(
        "checksum-mismatch",
        `${path} 字节数与清单不符（${bytes.byteLength} ≠ ${meta.bytes}）`,
        path,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== meta.sha256) {
      throw new BundleImportError("checksum-mismatch", `${path} 校验和不符，包可能已损坏或被改动`, path);
    }
  }

  const text = (p: string): string | null => (unzipped[p] ? Buffer.from(unzipped[p]).toString("utf-8") : null);

  // transcript 是必需的：没有它就不成其为「会话」。
  const sessionText = text(BUNDLE_SESSION_PATH);
  if (sessionText === null) {
    throw new BundleImportError(
      "entry-missing",
      `包内缺少 ${BUNDLE_SESSION_PATH}（会话 transcript），无法作为历史会话落地`,
    );
  }

  // ── 阶段 3：生成本机身份（新 id + 新文件名，绝不覆盖既有会话） ──────────────
  const dir = opts.sessionDir ?? getSessionDir();
  const newSessionId = (opts.newSessionId ?? ((): string => randomUUID()))();
  const fileName = newSessionFileName(now, newSessionId);
  const sessionFile = resolvePath(dir, fileName);

  // transcript 先处理：它给出源会话显示名，而这个名字要进 `importedFrom`——
  // 而 `importedFrom` 又会被序列化进画布 sidecar，所以必须**先定稿再序列化**
  // （否则画布里那份会留下 `originSessionName: null` 的半成品）。
  const transcript = rewriteTranscriptHeader(unzipped[BUNDLE_SESSION_PATH], {
    newSessionId,
    cwd: opts.cwd ?? process.cwd(),
  });
  const importedFrom: ImportedFrom = {
    token: manifest.token,
    exportedAt: manifest.exportedAt,
    originalSessionId: manifest.sessionId,
    originSessionName: transcript.name,
    bundleFileName: basename(resolvedPath),
    importedAt: now.toISOString(),
  };

  // 画布/留痕内容也在写盘前解析完：任何形状不符都在「零写入」阶段失败。
  const canvasText = text(BUNDLE_CANVAS_PATH);
  let canvasOut: string | null = null;
  let nodeCount = 0;
  let edgeCount = 0;
  if (canvasText !== null) {
    const parsed = parseJsonArtifact(canvasText, BUNDLE_CANVAS_PATH) as { nodes?: unknown; edges?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new BundleImportError(
        "payload-invalid",
        `包内 ${BUNDLE_CANVAS_PATH} 不是合法画布（缺 nodes/edges 数组）`,
      );
    }
    nodeCount = parsed.nodes.length;
    edgeCount = parsed.edges.length;
    // 顶层保留源包的其它键（如 T3.2 的 forkFrom 血缘），只追加 importedFrom。
    canvasOut = JSON.stringify({ ...parsed, importedFrom });
  }
  const manifestsText = text(BUNDLE_MANIFESTS_PATH);
  let manifestCount = 0;
  if (manifestsText !== null) {
    const parsed = parseJsonArtifact(manifestsText, BUNDLE_MANIFESTS_PATH);
    if (!Array.isArray(parsed)) {
      throw new BundleImportError("payload-invalid", `包内 ${BUNDLE_MANIFESTS_PATH} 不是数组`);
    }
    manifestCount = parsed.length;
  }

  // ── 阶段 4：落盘（校验已全绿；目标全部在 sessions 目录内，且一律不覆盖） ─────
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new BundleImportError("write-failed", `无法创建会话目录 ${dir}`, (err as Error).message);
  }
  const plan: Array<{ bundlePath: string | null; target: string; bytes: string | Buffer }> = [
    { bundlePath: BUNDLE_SESSION_PATH, target: sessionFile, bytes: transcript.bytes },
  ];
  if (canvasOut !== null) plan.push({ bundlePath: BUNDLE_CANVAS_PATH, target: canvasPathFor(sessionFile), bytes: canvasOut });
  const auditText = text(BUNDLE_AUDIT_PATH);
  if (auditText !== null) plan.push({ bundlePath: BUNDLE_AUDIT_PATH, target: auditPathFor(sessionFile), bytes: auditText });
  const injectionText = text(BUNDLE_INJECTION_PATH);
  if (injectionText !== null) {
    plan.push({ bundlePath: BUNDLE_INJECTION_PATH, target: injectionTracePathFor(sessionFile), bytes: injectionText });
  }
  // report.html / manifests.json 只校验不落地：前者是给人看的导出产物，后者是 canvas.json 的
  // 派生便利产物，写进 sessions 目录只会制造 pi 不认的孤儿文件（design.md 有论证）。

  const meta: SessionImportMeta = {
    version: IMPORT_META_VERSION,
    importedFrom,
    filesWritten: plan.map((p) => p.bundlePath as string),
    missing: Array.isArray(manifest.missing) ? manifest.missing : [],
    excludedParquet: manifest.excluded?.parquet ?? EMPTY_PARQUET,
  };
  if (manifest.storageProfile) meta.storageProfile = manifest.storageProfile;
  plan.push({ bundlePath: null, target: importMetaPathFor(sessionFile), bytes: `${JSON.stringify(meta, null, 2)}\n` });

  // 先全部探一遍再写：decisions ②「不提供覆盖」——任何目标已存在就整单拒绝，不动磁盘。
  for (const item of plan) {
    if (existsSync(item.target)) {
      throw new BundleImportError(
        "target-conflict",
        `目标会话文件已存在，拒绝覆盖（导入一律生成新会话 id）：${basename(item.target)}`,
      );
    }
  }

  const written: string[] = [];
  try {
    for (const item of plan) {
      writeFile(item.target, item.bytes);
      written.push(item.target);
    }
  } catch (err) {
    rollback(written);
    throw new BundleImportError(
      "write-failed",
      `写入会话文件失败，已回滚（零残留）：${(err as Error).message}`,
    );
  }

  const result: SessionImportResult = {
    sessionId: newSessionId,
    sessionFile,
    sessionName: transcript.name,
    messageCount: transcript.messageCount,
    nodeCount,
    edgeCount,
    manifestCount,
    importedFrom,
    filesWritten: meta.filesWritten,
    missing: meta.missing,
    excludedParquet: meta.excludedParquet,
  };
  if (meta.storageProfile) result.storageProfile = meta.storageProfile;
  return result;
}

/** 读一个会话的导入来源标注；非导入会话（无 sidecar / 坏 JSON）返回 null。 */
export function readImportMeta(sessionFile: string): SessionImportMeta | null {
  const p = importMetaPathFor(sessionFile);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<SessionImportMeta>;
    if (raw?.version !== IMPORT_META_VERSION || !raw.importedFrom) return null;
    return raw as SessionImportMeta;
  } catch {
    return null;
  }
}
