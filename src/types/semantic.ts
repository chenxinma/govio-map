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
