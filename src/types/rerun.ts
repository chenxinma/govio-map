/**
 * 复跑记录（RerunRecord）—— DataFrame 一键复跑与漂移提示（ROADMAP Phase 1 / KR2）。
 *
 * 每次复跑都在 dataFrame 节点的 `data.rerunHistory` 上**追加**一条记录（最新在前），
 * 随 canvas sidecar（`<session-file>.canvas.json`）持久化。
 *
 * 与 Analysis Manifest 的关系：Manifest 是「原始留痕」，复跑**不覆盖**它——
 * - 结果一致：只刷新 `manifest.executedAt`（最近一次可复现确认时间），原始时间在记录的 `before.executedAt` 里
 * - 结果漂移：Manifest 原样保留，旧值/新值/时间写进记录，节点显示漂移警告
 *
 * 本文件只放类型（前后端共享，服务端以 `../src/types/rerun.js` 导入）；
 * 复跑执行与对比逻辑在 `server/dataframe-rerun.ts`，前端写入规则在 `src/utils/rerun.ts`。
 */
import type { ManifestChecksum } from './manifest';

/**
 * 复跑结论：
 * - `identical` 行数与校验和与原 Manifest 一致（可复现）
 * - `drift` 规模或结构发生变化，或原留痕缺少可比对的基线（无法确认可复现）
 * - `error` 复跑本身失败（SQL 报错、数据源不可达、CLI 超时等）
 */
export type RerunOutcome = 'identical' | 'drift' | 'error';

/** 一次复跑的对比快照。`before` 取自原 Manifest，`after` 取自本次执行结果。 */
export interface RerunSnapshot {
  /** 原 Manifest 的执行时间（仅 `before` 有；`after` 的时间就是 `rerunAt`） */
  executedAt?: string;
  /** 行数；未知时缺省 */
  rowCount?: number;
  /** 列数；未知时缺省 */
  columnCount?: number;
  /** 轻量校验和（算法见 `ManifestChecksum`）；无列信息时缺省 */
  checksum?: ManifestChecksum;
}

/** 漂移差异摘要（仅 `outcome === 'drift'` 时产出）。 */
export interface RerunDiff {
  /** 行数变化量：`after.rowCount - before.rowCount`；任一侧缺失时为 0 */
  rowCountDelta: number;
  /** 列数变化量：`after.columnCount - before.columnCount`；任一侧缺失时为 0 */
  columnCountDelta: number;
  /** 结构校验和是否变化；校验和不可比时（原留痕无 checksum）退化为行/列数对比结果 */
  schemaChanged: boolean;
  /**
   * 原留痕缺少可比对基线（既无校验和也无行数）时为 true。
   * 此时无法确认可复现，按漂移处理并在 `summary` 里说明。
   */
  baselineIncomplete?: boolean;
  /** 中文差异摘要，节点 UI 直接展示 */
  summary: string;
}

/** 单次复跑的完整留痕。 */
export interface RerunRecord {
  /** 本次复跑完成时间（ISO 8601，服务端时钟） */
  rerunAt: string;
  /** 结论，见 {@link RerunOutcome} */
  outcome: RerunOutcome;
  /** 复跑前的原 Manifest 快照（永久保留，不被后续复跑覆盖） */
  before: RerunSnapshot;
  /** 本次复跑的结果快照；`outcome === 'error'` 时缺省 */
  after?: RerunSnapshot;
  /** 差异摘要；`outcome === 'drift'` 时必有 */
  diff?: RerunDiff;
  /** 失败原因（CLI stderr / HTTP 错误 / 不可复跑原因）；仅 `outcome === 'error'` */
  error?: string;
  /** 复跑耗时（毫秒） */
  durationMs?: number;
  /**
   * 本次复跑使用的临时 DataFrame 名。
   * 复跑不覆盖已交付的同名 DataFrame：SQL 以临时名加载、比对后立即 `observe release`。
   * 记录此名是为了在释放失败时能手工清理残留。
   */
  tempDfName?: string;
  /** 触发复跑时的 pi 会话 ID；取不到时为空串 */
  sessionId: string;
}
