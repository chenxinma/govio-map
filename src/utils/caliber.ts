/**
 * T2.3 口径冲突检测 UI 状态映射（唯一取值来源，T2.2 src/utils/lineage.ts 同款模式）。
 *
 * 展示取舍（design.md §UI）：
 * - `conflict`：黄色警示（green-deck semantic warning `#F59B23`）——描边 + 徽标 +
 *   可展开差异说明；
 * - `consistent`：不打扰（无任何视觉变化）；
 * - `unknown`：不显示——比对不确定是常态（宁可 unknown 不误报），轻提示会训练用户
 *   忽略警示；数据仍在 node.data.caliberCheck 里，后续需要可追溯。
 */
import type { CaliberCheck } from "../types/semantic.js";

/** 警示黄（green-deck semantic warning token） */
export const CALIBER_WARNING_COLOR = "#F59B23";

/** 差异维度 → 展示名（CLI aspect 原值兜底） */
export const CALIBER_ASPECT_LABELS: Record<string, string> = {
  aggregation: "聚合口径",
  filter: "过滤/统计范围",
  time_scope: "时间窗",
  column: "引用列",
  metric: "指标",
  sql: "SQL",
};

export interface CaliberNodeAppearance {
  /** conflict 时 true：节点描边 + 警示徽标 + 可展开差异说明 */
  showWarning: boolean;
  warningColor: string;
  badgeLabel: string | null;
}

export function caliberNodeAppearance(check: CaliberCheck | undefined): CaliberNodeAppearance {
  if (check?.status === "conflict") {
    return { showWarning: true, warningColor: CALIBER_WARNING_COLOR, badgeLabel: "口径冲突" };
  }
  return { showWarning: false, warningColor: CALIBER_WARNING_COLOR, badgeLabel: null };
}
