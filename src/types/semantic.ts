/**
 * T2.2 口径溯源与语义血缘类型（前后端共享定义，与 ./manifest.ts 同款模式）。
 *
 * 服务端 `server/prompt-injection.ts` 的 `GraphEntityType` 与此同源（server 依赖
 * src/types，方向单向），保证注入的图谱实体与节点上的语义引用枚举逐字一致。
 */

/** 图谱实体类型（与 .agents/skills/govio/assets/schema.md 对齐） */
export type SemanticEntityType = "Metric" | "Dimension" | "Col";

/**
 * 语义引用：SQL 节点记录「本次口径引用了哪些图谱实体」（口径溯源，ROADMAP Phase 2 KR2）。
 * 来源是 T2.1 注入留痕中的 graphEntities；code/name 缺失即省略，禁止猜测补全。
 */
export interface SemanticRef {
  entityType: SemanticEntityType;
  /** 图谱节点主键 */
  id: string;
  code?: string;
  name?: string;
}

/**
 * 血缘边分类（Edge.data.lineageKind）：
 * - `data`：数据血缘（表 → SQL → DataFrame → 报告的数据流，含手动连线）
 * - `semantic`：语义血缘（口径沿袭：两个 SQL 节点引用了同一图谱实体）
 *
 * 旧边没有 data 字段，按 `"data"` 处理（兼容回退）。
 */
export type LineageKind = "data" | "semantic";

// ── T2.3 口径冲突检测 ──────────────────────────────────────────────

/**
 * 口径比对判定：
 * - `consistent`：与图谱指标定义一致
 * - `conflict`：确定冲突（比对逻辑只在 govio-cli，见 govio 仓 `metadata/caliber.py`）
 * - `unknown`：无法判定（CLI 侧判定纪律：宁可 unknown 不误报 conflict）
 */
export type CaliberStatus = "consistent" | "conflict" | "unknown";

/** 单项口径差异（与 govio CLI `sql caliber` 输出的 differences 条目同形） */
export interface CaliberDifference {
  /** 所属指标（多指标比对时区分；CLI results[].metric.code/name 透传，缺失省略键） */
  metricCode?: string;
  metricName?: string;
  /** 差异维度：aggregation | filter | time_scope | column | metric | sql */
  aspect: string;
  /** 图谱口径期望 */
  expected: string;
  /** SQL 实际 */
  found: string;
  detail?: string;
}

/**
 * 口径冲突检测结果（SQL 节点 `caliberCheck` 字段，T2.3）。
 * 来源：服务端 message_end 经 `govio-cli sql caliber` 比对后写入事件；
 * CLI 缺失/超时/报错/非 JSON 一律省略键（缺失不写键，旧节点形状不变）。
 */
export interface CaliberCheck {
  /** 汇总状态：任一 conflict → conflict；否则任一 unknown → unknown；否则 consistent */
  status: CaliberStatus;
  /** 扁平差异列表（含指标归属）；consistent 时为空 */
  differences: CaliberDifference[];
}
