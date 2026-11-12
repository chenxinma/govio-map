/**
 * X10 表间语义关系：画布侧的**限定名变体匹配**与**语义边候选**纯函数。
 *
 * 为什么需要变体匹配：图谱 `RELATES_TO` 给出的 `targetTable` 是 `full_table_name`
 * 原值（duckdb 三段式 `chocolate.chocolate.dim_product`），而画布 sourceTable 节点的
 * `tableName` 通常是裸表名（`dim_product`），`qualifiedName` 才是三段式（T2.0，可选、
 * 可能缺失）。段数不一致会让匹配恒空（BUGFIX-injection-graph-key 同款教训），故两侧都
 * 展开为「点号后缀变体集合」再求交：`a.b.c` → {`a.b.c`, `b.c`, `c`}。
 *
 * 取舍：变体匹配是**尽力而为**——同名表出现在多个 catalog/schema 时可能误配。优先命中
 * 更长的变体（qualifiedName 在场时三段式先匹配上），且只在 sourceTable ↔ sourceTable
 * 之间建边，误配面有限。已知局限记录在 docs/tasks/X10-table-semantic-edges/design.md。
 *
 * 纯函数、无副作用：canvas-store 负责把候选转成 ReactFlow Edge（样式/去重/id 规则），
 * 本模块不依赖 @xyflow/react，便于 node 环境单测。
 */
import type { TableRelation } from '../types';
import { lineageKindOf } from './lineage';

/** 参与匹配的最小节点形状（避免绑定 ReactFlow 类型，测试可直接传字面量） */
export interface TableNodeLike {
  id: string;
  data?: unknown;
}

/** 参与去重判定的最小边形状 */
export interface TableEdgeLike {
  id?: string;
  source: string;
  target: string;
  data?: unknown;
}

/**
 * 表间语义边候选：source → target 的节点 ID 对（已去重、已排除自环与既有语义边）。
 *
 * `relations`（X13 加法扩展）：命中该节点对的关系原文，方向与候选一致（即 `sourceId`
 * 节点上的 `tableRelations`）。同一对节点被多条关系命中时并入同一条边（无向去重规则
 * 不变），供边侧 UI（label / `edge.data`）与导出报告说明「这条边基于哪几列」。
 * 无关系可挂的候选省略该键——消费方必须容忍缺失（旧数据、sqlQuery 口径沿袭边）。
 */
export interface TableSemanticEdgeCandidate {
  sourceId: string;
  targetId: string;
  relations?: TableRelation[];
}

/** 键归一：去空白 + 小写（DuckDB/Postgres 表名大小写不敏感的场景不因大小写漏配） */
export function normalizeTableKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 表名的点号后缀变体（含原值），归一后去重、去空。
 * `chocolate.chocolate.fact_sales` → ['chocolate.chocolate.fact_sales', 'chocolate.fact_sales', 'fact_sales']
 */
export function tableKeyVariants(name?: string | null): string[] {
  if (typeof name !== 'string') return [];
  const trimmed = name.trim();
  if (!trimmed) return [];
  const parts = trimmed.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const variant = normalizeTableKey(parts.slice(i).join('.'));
    // 中间段为空（如 `a..b`）会产生空串/畸形键，一律丢弃
    if (variant && !variant.startsWith('.') && !variant.endsWith('.') && !out.includes(variant)) {
      out.push(variant);
    }
  }
  return out;
}

function dataOf(node: TableNodeLike): Record<string, unknown> | null {
  const d = node?.data;
  return d !== null && typeof d === 'object' ? (d as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/**
 * sourceTable 节点的匹配键集合：`qualifiedName`（T2.0，最精确）→ `schema.tableName` →
 * `tableName`，逐个展开为后缀变体。非 sourceTable 节点返回空集（不参与表间匹配）。
 */
export function sourceTableMatchKeys(node: TableNodeLike): Set<string> {
  const d = dataOf(node);
  if (!d || d.type !== 'sourceTable') return new Set();
  const keys = new Set<string>();
  const tableName = str(d.tableName);
  const schema = str(d.schema);
  for (const name of [str(d.qualifiedName), schema && tableName ? `${schema}.${tableName}` : undefined, tableName]) {
    for (const variant of tableKeyVariants(name)) keys.add(variant);
  }
  return keys;
}

/** 读节点的表间关系（缺失/非数组/元素形状不合法一律过滤掉，不猜测补全） */
export function nodeTableRelations(node: TableNodeLike): TableRelation[] {
  const d = dataOf(node);
  const raw = d?.tableRelations;
  if (!Array.isArray(raw)) return [];
  const out: TableRelation[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rel = item as Record<string, unknown>;
    const targetTable = str(rel.targetTable);
    if (!targetTable) continue;
    out.push({
      targetTable,
      relationshipType: str(rel.relationshipType) ?? '',
      ...(str(rel.description) ? { description: str(rel.description) } : {}),
      ...(Array.isArray(rel.sourceColumns) ? { sourceColumns: rel.sourceColumns.filter((c): c is string => typeof c === 'string') } : {}),
      ...(Array.isArray(rel.targetColumns) ? { targetColumns: rel.targetColumns.filter((c): c is string => typeof c === 'string') } : {}),
    });
  }
  return out;
}

/** 关系目标表的匹配键集合（图谱三段式原值 / 字段级裸表名都能对上） */
export function relationTargetKeys(targetTable: string): Set<string> {
  return new Set(tableKeyVariants(targetTable));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const k of a) if (b.has(k)) return true;
  return false;
}

/** 无向节点对键：同一对节点无论方向只算一条（避免 a→b 与 b→a 画出两条重叠边） */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 计算新 sourceTable 节点与既有 sourceTable 节点之间的**表间语义边候选**（双向匹配）：
 * ① 新节点的 `tableRelations.targetTable` 指向既有节点 → 边 新 → 既有；
 * ② 既有节点的 `tableRelations.targetTable` 指向新节点 → 边 既有 → 新
 *    （星型模型里 dim 表可能后上画布，此时关系挂在先落地的 fact 节点上）。
 *
 * 去重规则：**同一对节点只保留一条**（无向去重——图谱里 a→b 与 b→a 同时存在时也只画一条，
 * 先产出的候选胜出，① 优先于 ②）；自环丢弃；`existingEdges` 中已存在的语义边（按
 * `lineageKindOf` 判定）覆盖的节点对不再产出候选——与数据血缘边可并存（数据边不参与该判定）。
 *
 * 关系目标不在画布上 → 不产出候选、不报错（图谱里的表未必都上了画布）。
 */
export function tableSemanticEdgeCandidates(
  existingNodes: TableNodeLike[],
  newNode: TableNodeLike,
  existingEdges: TableEdgeLike[] = [],
): TableSemanticEdgeCandidate[] {
  const out: TableSemanticEdgeCandidate[] = [];
  // 已存在的语义边不再重复建：id 规则见 canvas-store（`e-<src>-<tgt>-sem`），
  // 但历史边可能来自其它 id 规则，故按端点 + lineageKind 判定而非按 id。
  const blocked = new Set<string>();
  for (const e of existingEdges) {
    if (lineageKindOf(e) === 'semantic') blocked.add(pairKey(e.source, e.target));
  }
  // 本轮已产出的候选：节点对键 → 候选。X13 还用它把同方向后续命中的关系并入同一条边
  // （不能复用 blocked 提前 return，否则第二条关系会被吞掉）。
  const byPair = new Map<string, TableSemanticEdgeCandidate>();

  const push = (sourceId: string, targetId: string, relation?: TableRelation): void => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const key = pairKey(sourceId, targetId);
    if (blocked.has(key)) return;
    const existing = byPair.get(key);
    if (existing) {
      // 同一节点对、同一方向再多一条关系仍只画一条边（合并关系）；方向不同
      // （② 撞上 ① 已占用的节点对）沿用既有「先产出者胜出」去重，不并入。
      if (relation && existing.sourceId === sourceId && existing.targetId === targetId) {
        existing.relations = [...(existing.relations ?? []), relation];
      }
      return;
    }
    const candidate: TableSemanticEdgeCandidate = {
      sourceId,
      targetId,
      ...(relation ? { relations: [relation] } : {}),
    };
    byPair.set(key, candidate);
    out.push(candidate);
  };

  const newKeys = sourceTableMatchKeys(newNode);
  if (newKeys.size === 0) return out;

  const existingTables = (existingNodes ?? [])
    .filter((n) => n && n.id !== newNode.id)
    .map((n) => ({ node: n, keys: sourceTableMatchKeys(n) }))
    .filter((e) => e.keys.size > 0);

  // ① 新节点的关系指向既有节点（关系原文随候选一起带出，供边侧 UI 消费）
  for (const rel of nodeTableRelations(newNode)) {
    const targetKeys = relationTargetKeys(rel.targetTable);
    for (const { node, keys } of existingTables) {
      if (intersects(targetKeys, keys)) push(newNode.id, node.id, rel);
    }
  }

  // ② 既有节点的关系指向新节点
  for (const { node } of existingTables) {
    for (const rel of nodeTableRelations(node)) {
      if (intersects(relationTargetKeys(rel.targetTable), newKeys)) push(node.id, newNode.id, rel);
    }
  }

  return out;
}
