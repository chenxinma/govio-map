import type { DataFrameNodeData, RerunOutcome, RerunRecord } from '../types';

/**
 * DataFrame 一键复跑的前端规则（ROADMAP Phase 1 / KR2）。
 *
 * 复跑记录由服务端产出（`server/dataframe-rerun.ts`），前端只负责：
 *  - 把记录**追加**到 `node.data.rerunHistory`（最新在前，条数封顶）
 *  - 结果一致时刷新 `manifest.executedAt`（原始时间保留在 `record.before.executedAt`）
 *  - 结果漂移时**原样保留** Manifest，只靠记录 + 节点警告标记表达差异
 *
 * 这些都是纯函数，便于 `scripts/verify-rerun-drift.ts` 直接断言。
 */

/** `rerunHistory` 条数上限：防止长期复跑把 canvas sidecar 撑大，最近 20 次足够审计 */
export const MAX_RERUN_HISTORY = 20;

/**
 * 复跑结论的展示措辞：节点状态条（`RerunStatus.tsx`）与交付报告
 * （`export-report.ts`）共用同一份，避免同一个结论两种叫法。
 */
export const RERUN_OUTCOME_LABELS: Record<RerunOutcome, string> = {
  identical: '复现一致',
  drift: '漂移',
  error: '复跑失败',
};

/** 最近一次复跑记录（`rerunHistory` 最新在前） */
export function latestRerun(data: DataFrameNodeData): RerunRecord | undefined {
  return data.rerunHistory?.[0];
}

/** 节点是否处于漂移警告态：以最近一次复跑结论为准（复跑一致后警告自动消除） */
export function hasDrift(data: DataFrameNodeData): boolean {
  return latestRerun(data)?.outcome === 'drift';
}

/**
 * 节点是否显示「复跑」按钮。
 * 只判断主导情况（留痕里没有 SQL 就无从复跑，例如 `show-dataframe` 来源的节点）；
 * 数据源/dfName 缺失等其余情况由服务端 `rerunBlockReason` 兜底并返回失败记录。
 */
export function canRerun(data: DataFrameNodeData): boolean {
  return Boolean(data.manifest?.sql.trim());
}

/**
 * 追加一条复跑记录，返回新的节点 data（不修改入参）。
 * 一致 → 刷新 `manifest.executedAt`；漂移/失败 → Manifest 原样保留。
 */
export function withRerunRecord(data: DataFrameNodeData, record: RerunRecord): DataFrameNodeData {
  const rerunHistory = [record, ...(data.rerunHistory ?? [])].slice(0, MAX_RERUN_HISTORY);
  const next: DataFrameNodeData = { ...data, rerunHistory };
  if (record.outcome === 'identical' && next.manifest) {
    next.manifest = { ...next.manifest, executedAt: record.rerunAt };
  }
  return next;
}

/** 复跑时间的紧凑展示（`2026-10-30 23:05`）；非法时间原样返回 */
export function formatRerunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
