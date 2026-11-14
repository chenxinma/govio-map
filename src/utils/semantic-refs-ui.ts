/**
 * X18 「口径」徽标区的**展示模型**（纯函数、无 React 依赖，可在 node 环境单测）。
 *
 * PD-1 方案 1（用户裁决 2026-11-14）：T2.2 已让 sqlQuery 节点携带 `semanticRefs`，但指标
 * 只存在于节点属性里、画布上不可见。本模块是「refs 怎么变成徽标」的唯一取值来源，
 * 沿袭两条既有纪律：
 *
 * 1. **不猜测补全**（`caliber.ts` / `table-relations-ui.ts` 同款）：`code` 与 `name` 都缺
 *    的引用**整条跳过**——图谱 `Col`（字段标准）的注入行只带 `column_name` / `data_type`，
 *    经 `toSemanticRefs` 后既无 code 也无 name，天然不产徽标，画布不会被列级实体淹没。
 * 2. **色值不在这里、也不在组件里写死**：本模块只给文本与顺序，配色由节点组件用
 *    green-deck token class 表达（紫 = 语义层，与语义血缘边同色系）。
 *
 * 排序：**Metric 优先**（PD-1 的诉求就是「指标在画布可见」），其后 Dimension、Col，
 * 同类型内保持注入原序（`Array.prototype.sort` 稳定）；去重口径与 `canvas-store` 建语义边
 * 一致（`entityType:id`）。
 */
import type { SemanticEntityType, SemanticRef } from '../types/semantic.js';

/** 徽标区默认可见条数（超出折叠，与字段区 / 表间关系小节同一交互范式） */
export const MAX_VISIBLE_SEMANTIC_REFS = 3;

/** 图谱实体类型 → 展示名（画布与导出共用的唯一来源；未知取值回落原值） */
export const SEMANTIC_ENTITY_TYPE_LABELS: Record<SemanticEntityType, string> = {
  Metric: '指标',
  Dimension: '维度',
  Col: '字段标准',
};

/** 排序权重：未知类型排最后（枚举演进时不丢徽标，也不抢在指标前面） */
const ENTITY_TYPE_ORDER: Record<string, number> = { Metric: 0, Dimension: 1, Col: 2 };

export interface SemanticRefBadge {
  /** React key / 去重键（与 canvas-store 建语义边的 `${entityType}:${id}` 同口径） */
  key: string;
  entityType: SemanticEntityType;
  /** 类型展示名（`SEMANTIC_ENTITY_TYPE_LABELS`；未知取值回落原值，缺失为 ''） */
  typeLabel: string;
  /** 徽标短名：`code ?? name`（两者都缺的引用不会出现在结果里） */
  label: string;
  /** 徽标可见文本：指标只给短名，非指标前缀类型名（如 `维度·渠道`），避免把维度读成指标 */
  text: string;
  /** hover 全文（X15.1「画布轻、详情按需」取舍）：类型 / 编码 / 名称 / 图谱 ID，缺项省略 */
  title: string;
  code: string | null;
  name: string | null;
  id: string | null;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 类型展示名：枚举内取中文名，未知取值回落原值（与 `CALIBER_ASPECT_LABELS` 兜底同款） */
export function semanticRefTypeLabel(entityType: unknown): string {
  const raw = clean(entityType);
  if (!raw) return '';
  const labels = SEMANTIC_ENTITY_TYPE_LABELS as Record<string, string>;
  return labels[raw] ?? raw;
}

/** 徽标短名：`code` 优先、`name` 回退；两者都缺（含纯空白）返回 null → 调用方跳过该条 */
export function semanticRefLabel(ref: SemanticRef | undefined | null): string | null {
  if (!ref || typeof ref !== 'object') return null;
  return clean(ref.code) ?? clean(ref.name);
}

/**
 * 徽标 hover 全文（多行，浏览器原生 title 按 `\n` 换行）：类型 / 编码 / 名称 / 图谱 ID。
 * 只拼存在的项，绝不出现 `undefined` 或空行。
 */
export function semanticRefTitle(ref: SemanticRef | undefined | null): string {
  if (!ref || typeof ref !== 'object') return '';
  const parts: string[] = [];
  const typeLabel = semanticRefTypeLabel(ref.entityType);
  if (typeLabel) parts.push(`类型：${typeLabel}`);
  const code = clean(ref.code);
  if (code) parts.push(`编码：${code}`);
  const name = clean(ref.name);
  if (name) parts.push(`名称：${name}`);
  const id = clean(ref.id);
  if (id) parts.push(`图谱 ID：${id}`);
  return parts.join('\n');
}

/**
 * `semanticRefs` → 徽标列表（画布与导出共用同一份过滤与排序）。
 *
 * 脏元素过滤 → 按 `entityType:id` 去重 → 丢掉无短名的引用 → Metric 优先排序。
 * 入参为 undefined / 非数组 / 全部无短名时返回 `[]`，调用方**整节不渲染**
 * （旧节点、手动建的 SQL 节点、图谱降级都走这条路，画布上不留空壳行）。
 */
export function semanticRefBadges(refs: SemanticRef[] | undefined | null): SemanticRefBadge[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  const badges: SemanticRefBadge[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!ref || typeof ref !== 'object') continue;
    const label = semanticRefLabel(ref);
    if (!label) continue;
    const entityType = ref.entityType;
    const typeLabel = semanticRefTypeLabel(entityType);
    const id = clean(ref.id);
    // 有图谱 ID 才参与去重（同一实体被多轮注入只留一条）；无 ID 时用序号兜底保证 key 唯一
    const dedupeKey = id ? `${entityType ?? ''}:${id}` : null;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    badges.push({
      key: dedupeKey ?? `${entityType ?? ''}:${label}#${index}`,
      entityType,
      typeLabel,
      label,
      text: entityType === 'Metric' || !typeLabel ? label : `${typeLabel}·${label}`,
      title: semanticRefTitle(ref),
      code: clean(ref.code),
      name: clean(ref.name),
      id,
    });
  }
  return badges.sort(
    (a, b) => (ENTITY_TYPE_ORDER[a.entityType] ?? 99) - (ENTITY_TYPE_ORDER[b.entityType] ?? 99),
  );
}
