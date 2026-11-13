/**
 * X13 表间关系的**展示模型**（纯函数、无 React 依赖，可在 node 环境单测）。
 *
 * 两条纪律：
 * 1. **「不打扰」取舍沿袭 T2.3 `src/utils/caliber.ts`**——`tableRelationsHint` 只在
 *    来源为字段级降级（`tableRelationsSource === 'fields'`）或存在图谱降级原因
 *    （`tableRelationsError`）时亮灯；`source === 'graph'` 的正常态与「没有关系」的
 *    空态一律静默。轻提示满天飞会训练用户忽略它。
 * 2. **色值不在组件里写死**——警示色由本模块唯一给出（green-deck semantic warning
 *    token），节点组件与导出报告只消费返回值（与 `lineage.ts` 之于边样式同一纪律）。
 *
 * 关系数据的**清洗**复用 `table-relations.ts` 的 `nodeTableRelations`（同一形状口径），
 * 本模块只做「怎么展示」，不重复实现校验，也不改匹配语义。
 */
import type { TableRelation, TableRelationsSource } from '../types';

/** 警示黄（green-deck semantic warning token，与 `caliber.ts` 的 CALIBER_WARNING_COLOR 同值） */
export const TABLE_RELATIONS_HINT_COLOR = '#F59B23';

/** 节点内「表间关系」小节默认可见条数（超出折叠，与字段区同一交互范式） */
export const MAX_VISIBLE_TABLE_RELATIONS = 3;

/** 降级原因在画布上的最大展示长度（超出截断，全文交给 title） */
export const MAX_HINT_REASON_LENGTH = 60;

/** 关系来源徽标文案（展示名唯一来源，组件与导出共用） */
export const TABLE_RELATIONS_SOURCE_LABELS: Record<TableRelationsSource, string> = {
  graph: '图谱 RELATES_TO',
  fields: '字段级外键',
};

export interface TableRelationsHintInput {
  tableRelationsSource?: TableRelationsSource;
  tableRelationsError?: string;
  /** 仅用于文案区分「图谱挂了但仍拿到降级关系」与「图谱挂了且一条关系都没有」 */
  tableRelations?: TableRelation[];
}

export interface TableRelationsHintAppearance {
  /** 是否需要提示：正常态（graph）与无关系态为 false */
  showHint: boolean;
  hintColor: string;
  badgeLabel: string | null;
  /** 单行展示文案（过长已截断） */
  detail: string | null;
  /** 完整文案（title / 导出报告用，不截断） */
  detailFull: string | null;
}

/** 关系目标的展示名：三段式取裸表名，全限定名交给 title */
export function relationTargetLabel(targetTable: string): string {
  const trimmed = (targetTable ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split('.');
  return parts[parts.length - 1] || trimmed;
}

export interface RelationColumnView {
  /** 源表列（逗号连接），缺失/空为 null */
  source: string | null;
  /** 目标表列（逗号连接），缺失/空为 null */
  target: string | null;
  /** 单行文案：`a, b → c` / 只有一侧时只渲染那一侧 / 两侧都缺为 '' */
  text: string;
}

function joinColumns(cols?: string[]): string | null {
  if (!Array.isArray(cols)) return null;
  const list = cols.filter((c) => typeof c === 'string' && c.trim().length > 0);
  return list.length > 0 ? list.join(', ') : null;
}

/** 列映射视图：任一侧缺失就只渲染存在的一侧，两侧都缺时 text 为空（调用方省略该行） */
export function relationColumnView(rel: TableRelation): RelationColumnView {
  const source = joinColumns(rel?.sourceColumns);
  const target = joinColumns(rel?.targetColumns);
  const text = source && target ? `${source} → ${target}` : (source ?? target ?? '');
  return { source, target, text };
}

/**
 * 关系行的 hover 全文（节点内「表间关系」小节的 title 唯一取值来源）。
 *
 * X15.1（用户裁决 2026-11-13：「hover 显示 description，先保留」）：图谱 `description`
 * **只在 hover 出现**，不再单独占一行——画布上关系行只留「目标表裸名 + 字段关联」，
 * 说明与全限定名按需查看（数据仍原样留在 `node.data.tableRelations` 里，不删不改）。
 * 关系类型（`relationshipType`）按 X15 口径**不进 hover**：用户明确不要看到它。
 *
 * 多行 title（浏览器原生按 `\n` 换行）：目标表全限定名 / 字段关联 / 图谱说明，缺项自动省略。
 */
export function relationRowTitle(rel: TableRelation): string {
  const parts = [`关系目标表：${rel?.targetTable ?? ''}`];
  const columns = relationColumnView(rel).text;
  if (columns) parts.push(`字段关联：${columns}`);
  const description = typeof rel?.description === 'string' ? rel.description.trim() : '';
  if (description) parts.push(`说明：${description}`);
  return parts.join('\n');
}

/**
 * 语义边上的关系摘要（边 label 的唯一取值来源）：**只显示字段关联（列映射）**。
 *
 * X15（用户指令 2026-11-13）：不再显示 `many_to_one` / `one_to_many` / `foreign_key` 一类
 * 关系类型——对看画布的人是噪声。类型原值仍在 `node.data.tableRelations[].relationshipType`
 * 与 `edge.data.tableRelations` 里随 canvas sidecar 持久化，可追溯；将来若要恢复展示，
 * 只改展示层即可，不必动数据层与取数层。
 *
 * 一条关系时 `product_id → product_id`；同节点对多条时末尾附 `+N`（N = 其余关系条数）。
 * 全部关系都缺列信息时返回空串 → 调用方不写 `label` 键（不渲染空 label）。
 */
export function relationEdgeLabel(relations: TableRelation[] | undefined): string {
  if (!Array.isArray(relations) || relations.length === 0) return '';
  // 取第一条**有列映射**的关系做摘要：首条恰好缺列时不让 label 直接变空
  const first = relations.find((rel) => relationColumnView(rel).text !== '');
  if (!first) return '';
  const extra = relations.length > 1 ? ` +${relations.length - 1}` : '';
  return `${relationColumnView(first).text}${extra}`;
}

function truncateReason(text: string): string {
  if (text.length <= MAX_HINT_REASON_LENGTH) return text;
  return `${text.slice(0, MAX_HINT_REASON_LENGTH - 1)}…`;
}

/**
 * 降级留痕的唯一判定函数（caliberNodeAppearance 同构）。
 *
 * 判定表（对应 X10 design.md §3.1 的留痕形态）：
 * | source | error | 结果 |
 * |---|---|---|
 * | `graph` | 无 | 不提示（正常态） |
 * | 无 | 无 | 不提示（没有关系，也不打扰） |
 * | `fields` | 无 | 提示「字段级关系 · 图谱未记录该表关系」 |
 * | `fields` | 有 | 提示「字段级关系 · 图谱查询失败（原因）」 |
 * | 无/`graph` | 有 | 提示「图谱降级 · 原因」 |
 */
export function tableRelationsHint(input: TableRelationsHintInput): TableRelationsHintAppearance {
  const error =
    typeof input?.tableRelationsError === 'string' && input.tableRelationsError.trim().length > 0
      ? input.tableRelationsError.trim()
      : null;
  const source = input?.tableRelationsSource;
  const hasRelations = Array.isArray(input?.tableRelations) && input.tableRelations.length > 0;

  if (source !== 'fields' && !error) {
    return { showHint: false, hintColor: TABLE_RELATIONS_HINT_COLOR, badgeLabel: null, detail: null, detailFull: null };
  }

  const badgeLabel = source === 'fields' ? '字段级关系' : '图谱降级';
  const detailFull =
    source === 'fields'
      ? error
        ? `关系来源：字段级外键（图谱查询失败：${error}）`
        : '关系来源：字段级外键（图谱未记录该表关系）'
      : `图谱关系查询失败：${error}${hasRelations ? '' : '，本表无表间关系'}`;

  return {
    showHint: true,
    hintColor: TABLE_RELATIONS_HINT_COLOR,
    badgeLabel,
    detail: truncateReason(detailFull),
    detailFull,
  };
}
