import { computeChecksum, type ManifestColumn } from "./analysis-manifest.js";
import { runGovioCliWithArgs } from "./govio-cli-exec.js";
import type { AnalysisManifest } from "../src/types/manifest.js";
import type { RerunDiff, RerunOutcome, RerunRecord, RerunSnapshot } from "../src/types/rerun.js";

/**
 * DataFrame 一键复跑与漂移判定（ROADMAP Phase 1 / KR2）。
 *
 * 复跑是**验证动作**，不是重新取数：
 *  1. 用 Manifest 里固化的 `sql` + `datasource` 执行 `observe load`，但写入一个
 *     临时 DataFrame 名（`rerun_tmp_*`），**不覆盖已交付的同名 DataFrame**——
 *     否则节点留痕（行数/校验和）会与 ObserveStore 里的实际数据不一致，
 *     漂移时还会销毁业务方已经拿到的那份结果。
 *  2. 用 T1.1 的同一套校验和（`computeChecksum`）对比原 Manifest：
 *     一致 → 前端刷新 `manifest.executedAt`；不一致 → 前端保留原 Manifest、
 *     追加漂移记录并显示警告。
 *  3. 无论成功失败都 `observe release` 临时 DataFrame，避免残留被
 *     `restoreCanvas`（`observe list`）补成画布节点。
 *
 * 本模块不读任何数据内容（只用 `observe load` 输出的 rows/columns/column_info），
 * 也不依赖 agent 会话，便于 `scripts/verify-rerun-drift.ts` 直接注入假 runner 验证。
 */

/** CLI 执行器（数组参数）；可注入，验证脚本用假 runner 断言复跑参数 */
export type GovioCliRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/** 临时 DataFrame 名前缀：与业务 DF 区分，释放失败时容易识别残留 */
export const RERUN_TMP_PREFIX = "rerun_tmp_";

/** 复跑 `observe load` 的超时：重查询比 SQL 编辑器的 30s 更宽 */
export const RERUN_LOAD_TIMEOUT_MS = 120_000;

/** `observe release` 是收尾动作，短超时即可 */
export const RERUN_RELEASE_TIMEOUT_MS = 15_000;

/** `observe load` / `observe info` 输出的结果结构（两种命令的列键名不同） */
interface ObserveLoadOutput {
  success?: boolean;
  rows?: number;
  columns?: number;
  column_info?: Array<Record<string, unknown>>;
  schema?: Array<Record<string, unknown>>;
  error?: string;
  message?: string;
}

export interface RerunLoadResult {
  rowCount: number;
  columnCount: number;
  columns: ManifestColumn[];
}

export interface RerunOptions {
  /** CLI 执行器，缺省用真实的 `runGovioCliWithArgs` */
  runCli?: GovioCliRunner;
  /** 触发复跑的 pi 会话 ID（写入记录，便于回链 transcript） */
  sessionId?: string;
  /** 时钟注入点（验证脚本用固定时间断言 `rerunAt`） */
  now?: () => Date;
}

/**
 * 复跑前置校验：Manifest 必须固化了「SQL + 数据源 + DataFrame 名」才可复跑。
 * 返回 null 表示可复跑，否则返回不可复跑的原因（直接给用户看）。
 *
 * Manifest 来自本机 canvas sidecar（客户端 canvas_save 写入，未做 schema 校验），
 * 执行前先做形状校验：字段必须是字符串且非空，避免畸形留痕把非字符串传进 CLI
 * 参数。dfName 不限字符集：它不进 CLI 参数（临时名经 tempDfNameFor 归一化，
 * execFile 数组参数不经 shell），拒绝合法存量名字只会造成无法操作的复跑失败。
 */
export function rerunBlockReason(manifest: AnalysisManifest | null | undefined): string | null {
  if (!manifest) return "该节点没有分析留痕（Manifest），无法复跑";
  if (typeof manifest.sql !== "string" || !manifest.sql.trim()) {
    return `该节点的留痕未固化 SQL（origin=${String(manifest.origin)}），无法复跑`;
  }
  if (typeof manifest.datasource !== "string" || !manifest.datasource.trim()) {
    return "该节点的留痕未固化数据源，无法复跑";
  }
  if (typeof manifest.dfName !== "string" || !manifest.dfName) {
    return "该节点的留痕缺少 DataFrame 名，无法复跑";
  }
  return null;
}

/** 原 Manifest 的对比基线快照（写进记录的 `before`，永久保留） */
export function manifestSnapshot(manifest: AnalysisManifest): RerunSnapshot {
  const snapshot: RerunSnapshot = { executedAt: manifest.executedAt };
  if (typeof manifest.rowCount === "number") snapshot.rowCount = manifest.rowCount;
  if (typeof manifest.columnCount === "number") snapshot.columnCount = manifest.columnCount;
  if (manifest.checksum) snapshot.checksum = manifest.checksum;
  return snapshot;
}

/**
 * 复跑用的临时 DataFrame 名。
 * CLI 只接受小写字母/数字/下划线，故先归一化；截断到 32 字符保证总长不超过
 * CLI 侧的名称长度习惯；时间戳 + 随机尾巴避免同一节点并发复跑撞名。
 */
export function tempDfNameFor(dfName: string, now: Date = new Date()): string {
  const safe = dfName.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
  const stamp = now.getTime().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${RERUN_TMP_PREFIX}${safe}_${stamp}${rand}`;
}

/**
 * 复跑的 `observe load` 参数（数组形式，SQL 全文作为一个参数原样传入）。
 * `datasource === 'memory'` 走 `--memory`（在已加载 DataFrame 上跑 SQL），
 * 与 `parquet-api.ts` 的 `/api/execute-sql`、agent 的 `observe load` 用法一致。
 */
export function buildRerunLoadArgs(manifest: AnalysisManifest, tempName: string): string[] {
  const source = manifest.datasource === "memory"
    ? ["--memory"]
    : ["--datasource", manifest.datasource];
  return ["observe", "load", "--name", tempName, ...source, "--sql", manifest.sql];
}

/**
 * 解析 `observe load` 输出。
 * 列键名兼容 `name`（load 输出）/ `column`（info 输出）/ `col`，与
 * `extensions/govio-canvas.ts` 的 `mapColumnInfo` 保持同一套容错。
 * 输出不是合法 JSON（例如被 shell 管道截断）或 `success: false` 时返回 null。
 */
export function parseLoadOutput(stdout: string): RerunLoadResult | null {
  let parsed: ObserveLoadOutput;
  try {
    parsed = JSON.parse(stdout) as ObserveLoadOutput;
  } catch {
    return null;
  }
  if (!parsed || parsed.success === false) return null;
  const raw = parsed.column_info ?? parsed.schema ?? [];
  const columns: ManifestColumn[] = raw.map((c) => ({
    name: String(c.name ?? c.column ?? c.col ?? "unknown"),
    dtype: String(c.dtype ?? ""),
  }));
  const rowCount = typeof parsed.rows === "number" ? parsed.rows : 0;
  const columnCount = typeof parsed.columns === "number" ? parsed.columns : columns.length;
  return { rowCount, columnCount, columns };
}

export interface RerunComparison {
  outcome: Extract<RerunOutcome, "identical" | "drift">;
  after: RerunSnapshot;
  diff?: RerunDiff;
}

/**
 * 复跑结果与原 Manifest 对比。
 *
 * 判定优先级：
 *  1. 双方都有校验和 → 比 `schemaHash`（覆盖行数、列数、列名、dtype、列顺序）
 *  2. 原留痕没有校验和但有行数 → 退化到行数/列数对比（T1.1 在拿不到列信息时
 *     不产出校验和，此时不能因为「哈希缺失」就报漂移）
 *  3. 原留痕连行数都没有 → 无基线，按漂移处理并在摘要里说明「无法确认可复现」
 *     （宁可告警，也不给一个假的「复现一致」绿灯）
 *
 * `sqlHash` 不参与判定：复跑用的就是 Manifest 里那份 SQL，重算必然相同。
 */
export function compareRerunResult(manifest: AnalysisManifest, result: RerunLoadResult): RerunComparison {
  const afterChecksum = result.columns.length > 0
    ? computeChecksum(manifest.sql, result.columns, result.rowCount, result.columnCount)
    : undefined;
  const after: RerunSnapshot = { rowCount: result.rowCount, columnCount: result.columnCount };
  if (afterChecksum) after.checksum = afterChecksum;

  const beforeChecksum = manifest.checksum;
  const beforeRows = manifest.rowCount;
  const beforeCols = manifest.columnCount;
  const rowCountDelta = typeof beforeRows === "number" ? result.rowCount - beforeRows : 0;
  const columnCountDelta = typeof beforeCols === "number" ? result.columnCount - beforeCols : 0;

  const checksumComparable = Boolean(beforeChecksum && afterChecksum);
  const baselineIncomplete = !checksumComparable && typeof beforeRows !== "number";
  const schemaChanged = checksumComparable
    ? beforeChecksum!.schemaHash !== afterChecksum!.schemaHash
    : !baselineIncomplete && (rowCountDelta !== 0 || columnCountDelta !== 0);
  const identical = !baselineIncomplete && !schemaChanged;

  if (identical) return { outcome: "identical", after };
  return {
    outcome: "drift",
    after,
    diff: {
      rowCountDelta,
      columnCountDelta,
      schemaChanged,
      ...(baselineIncomplete ? { baselineIncomplete: true } : {}),
      summary: describeDrift({ beforeRows, beforeCols, beforeChecksum, after, baselineIncomplete, checksumComparable }),
    },
  };
}

/** 生成中文差异摘要（节点 UI 直接展示，不再二次加工） */
function describeDrift(input: {
  beforeRows: number | undefined;
  beforeCols: number | undefined;
  beforeChecksum: AnalysisManifest["checksum"];
  after: RerunSnapshot;
  baselineIncomplete: boolean;
  checksumComparable: boolean;
}): string {
  const { beforeRows, beforeCols, beforeChecksum, after, baselineIncomplete, checksumComparable } = input;
  if (baselineIncomplete) {
    return `原留痕没有行数/校验和基线，无法确认复现一致（本次 ${after.rowCount} 行 × ${after.columnCount} 列）`;
  }
  const parts: string[] = [];
  const rowCountDelta = typeof beforeRows === "number" ? (after.rowCount ?? 0) - beforeRows : 0;
  const columnCountDelta = typeof beforeCols === "number" ? (after.columnCount ?? 0) - beforeCols : 0;
  if (rowCountDelta !== 0) {
    parts.push(`行数 ${beforeRows} → ${after.rowCount}（${rowCountDelta > 0 ? "+" : ""}${rowCountDelta}）`);
  }
  if (columnCountDelta !== 0) {
    parts.push(`列数 ${beforeCols} → ${after.columnCount}（${columnCountDelta > 0 ? "+" : ""}${columnCountDelta}）`);
  }
  if (checksumComparable && beforeChecksum!.schemaHash !== after.checksum!.schemaHash) {
    parts.push(
      parts.length === 0
        ? `列结构变化（校验和 ${beforeChecksum!.schemaHash} → ${after.checksum!.schemaHash}）`
        : `校验和 ${beforeChecksum!.schemaHash} → ${after.checksum!.schemaHash}`,
    );
  }
  return parts.length > 0 ? parts.join("；") : "结果与原留痕不一致";
}

function errorRecord(
  rerunAt: string,
  before: RerunSnapshot,
  error: string,
  sessionId: string,
  durationMs: number,
  tempDfName?: string,
): RerunRecord {
  return {
    rerunAt,
    outcome: "error",
    before,
    error,
    durationMs,
    ...(tempDfName ? { tempDfName } : {}),
    sessionId,
  };
}

/**
 * 执行一次复跑并产出记录。
 *
 * 永不抛错：CLI 失败 / 输出不可解析 / 不可复跑都转成 `outcome: 'error'` 的记录，
 * 让「复跑失败」也留痕，而不是在前端静默消失。
 * 临时 DataFrame 在 finally 里释放；释放失败只告警（记录里带 `tempDfName`，可手工清理）。
 */
export async function rerunDataFrame(
  manifest: AnalysisManifest,
  options: RerunOptions = {},
): Promise<RerunRecord> {
  const runCli = options.runCli ?? runGovioCliWithArgs;
  const now = options.now ?? ((): Date => new Date());
  const sessionId = options.sessionId ?? "";
  const before = manifestSnapshot(manifest);
  const startedAt = Date.now();

  const blocked = rerunBlockReason(manifest);
  if (blocked) {
    return errorRecord(now().toISOString(), before, blocked, sessionId, Date.now() - startedAt);
  }

  const tempName = tempDfNameFor(manifest.dfName!, now());
  try {
    const stdout = await runCli(buildRerunLoadArgs(manifest, tempName), RERUN_LOAD_TIMEOUT_MS);
    const result = parseLoadOutput(stdout);
    if (!result) {
      return errorRecord(
        now().toISOString(),
        before,
        "observe load 输出无法解析（命令失败或输出被截断）",
        sessionId,
        Date.now() - startedAt,
        tempName,
      );
    }
    const { outcome, after, diff } = compareRerunResult(manifest, result);
    const record: RerunRecord = {
      rerunAt: now().toISOString(),
      outcome,
      before,
      after,
      durationMs: Date.now() - startedAt,
      tempDfName: tempName,
      sessionId,
    };
    if (diff) record.diff = diff;
    return record;
  } catch (err) {
    return errorRecord(
      now().toISOString(),
      before,
      err instanceof Error ? err.message : String(err),
      sessionId,
      Date.now() - startedAt,
      tempName,
    );
  } finally {
    // 复跑是验证动作：临时 DataFrame 用完即释放，不在 ObserveStore 里留残留。
    try {
      await runCli(["observe", "release", "--name", tempName], RERUN_RELEASE_TIMEOUT_MS);
    } catch (err) {
      console.warn(
        `[rerun] 释放临时 DataFrame '${tempName}' 失败，可手工执行 govio-cli observe release --name ${tempName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

if (process.env.NODE_ENV !== "production") {
  // 自检：复跑参数只来自 Manifest（SQL 作为单个数组参数）、判定三态、临时名合法。
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const base: AnalysisManifest = {
    schemaVersion: 1,
    origin: "observe-load",
    sql: "SELECT a, b FROM t WHERE x = 'y z'",
    datasource: "sales",
    dfName: "df_demo",
    executedAt: "2026-10-30T22:30:00.000Z",
    rowCount: 10,
    columnCount: 2,
    sessionId: "sess-self-check",
    checksum: computeChecksum("SELECT a, b FROM t WHERE x = 'y z'", [{ name: "a", dtype: "int32" }, { name: "b", dtype: "str" }], 10, 2),
  };
  const args = buildRerunLoadArgs(base, "rerun_tmp_df_demo_x");
  assert(args[0] === "observe" && args[1] === "load", "load subcommand");
  assert(args[args.length - 1] === base.sql, "SQL is passed as one array argument, verbatim from the manifest");
  assert(args.includes("--datasource") && args.includes("sales"), "datasource from manifest");
  assert(buildRerunLoadArgs({ ...base, datasource: "memory" }, "t").includes("--memory"), "memory datasource uses --memory");
  assert(/^rerun_tmp_[a-z0-9_]+$/.test(tempDfNameFor("DF-Demo 表", new Date(0))), "temp name is CLI-safe");
  assert(rerunBlockReason({ ...base, sql: "" }) !== null, "manifest without SQL is not rerunnable");
  assert(rerunBlockReason(base) === null, "complete manifest is rerunnable");
  const same = compareRerunResult(base, { rowCount: 10, columnCount: 2, columns: [{ name: "a", dtype: "int32" }, { name: "b", dtype: "str" }] });
  assert(same.outcome === "identical" && same.diff === undefined, "same rows/schema -> identical");
  const more = compareRerunResult(base, { rowCount: 11, columnCount: 2, columns: [{ name: "a", dtype: "int32" }, { name: "b", dtype: "str" }] });
  assert(more.outcome === "drift" && more.diff?.rowCountDelta === 1, "row count change -> drift");
  const renamed = compareRerunResult(base, { rowCount: 10, columnCount: 2, columns: [{ name: "a", dtype: "int32" }, { name: "c", dtype: "str" }] });
  assert(renamed.outcome === "drift" && renamed.diff?.schemaChanged === true, "column rename -> drift");
  const noBaseline = compareRerunResult({ ...base, checksum: undefined, rowCount: undefined, columnCount: undefined }, { rowCount: 10, columnCount: 2, columns: [{ name: "a", dtype: "int32" }] });
  assert(noBaseline.outcome === "drift" && noBaseline.diff?.baselineIncomplete === true, "missing baseline -> drift (never a false green)");
}
