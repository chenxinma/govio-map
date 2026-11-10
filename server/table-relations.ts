/**
 * X10 表间语义关系获取（server 侧）：为 sourceTable 节点补齐 `tableRelations`。
 *
 * 取数分层（**禁止猜测**，与 T2.0/T2.1 同款纪律）：
 * 1. **主路径 = 图谱** `(:PhysicalTable)-[:RELATES_TO]->(:PhysicalTable)`（属性名依
 *    `.agents/skills/govio/assets/schema.md`：`relationship_type` / `description` /
 *    `source_columns` / `target_columns`），经 `runGraphQuery` 执行（带缓存 + 单次重试）；
 *    表键取 `graphTableKey`（qualifiedName 优先）并按 `tableKeyCandidates` 双形匹配
 *    （图谱 full_table_name 含不含 catalog 段随导入环境不一致，BUGFIX-injection-graph-key）。
 * 2. **降级路径 = 字段级** `fields[].references`（isForeignKey + references.table/field）。
 * 3. 两者都拿不到 → 返回空数组，调用方**不写键、不建边**。
 *
 * 降级纪律：**永不 throw、永不阻断节点创建**。图谱 CLI 不可达 / 超时 / Binder 错误 /
 * 输出不可解析一律按降级处理并留痕（`status:"degraded"` + `error`，参照
 * `prompt-injection.ts` 的 graphStatus/graphError 写法）。空结果是合法语义（图谱里没有
 * RELATES_TO 边），算 `ok` 但同样回退字段级来源。
 *
 * 本模块另设 `RELATIONS_QUERY_TIMEOUT_MS` 本地闸：`runGraphQuery` 内部超时 12s + 失败重试
 * 一次，最坏 24s+ 才 reject，会把 sourceTable 节点上画布的时间一起拖住。本地超时到点即降级
 * （底层查询继续在后台跑完并填缓存，下次同表命中缓存不再等）。
 */
import { runGraphQuery, type GraphQueryRunner, type GraphRow } from "./graph-query.js";
import { graphTableKey, tableKeyCandidates, type TableFact } from "./prompt-injection.js";
import type { TableRelation, TableRelationsSource } from "../src/types/index.js";

/**
 * 字段级降级路径需要的最小字段形状。
 * 不用 `TableField`（它要求 `nullable`，而 `govio_create_source_table` 的参数形状里没有），
 * `TableField[]` 结构上可直接传入。
 */
export interface TableRelationFieldLike {
  name?: string;
  isForeignKey?: boolean;
  references?: { table?: string; field?: string };
}

/** 关系查询的本地超时（毫秒）：到点即降级，不拖住节点创建（见模块头注释） */
export const RELATIONS_QUERY_TIMEOUT_MS = 8000;

/** 单表关系条数上限（星型模型个位数；防止异常图谱把节点数据撑爆） */
export const MAX_TABLE_RELATIONS = 50;

/** 字段级降级路径写入的 relationshipType（图谱不可用时没有原值可取，不做猜测） */
export const FIELD_RELATIONSHIP_TYPE = "foreign_key";

/** 关系查询结果（`relations` 为空时 `source` 不写键） */
export interface TableRelationsResult {
  relations: TableRelation[];
  source?: TableRelationsSource;
  /** `degraded` = 图谱查询失败/超时/无可用表键；`ok` = 查询成功（含空结果） */
  status: "ok" | "degraded";
  /** 降级原因（仅 degraded 时写键） */
  error?: string;
}

export interface ResolveTableRelationsInput {
  tableName?: string;
  qualifiedName?: string;
  schema?: string;
  fields?: TableRelationFieldLike[];
  /** 图谱查询执行器（默认 runGraphQuery；测试注入 fake） */
  runQuery?: GraphQueryRunner;
  /** 本地超时（默认 RELATIONS_QUERY_TIMEOUT_MS） */
  timeoutMs?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * 列形状容错：图谱 `r.source_columns` / `r.target_columns` 实测返回**字符串**
 * （`"channel_id"`），而导入源文件（chocolate_relationships.json 的 `Cols`）是数组——
 * 两种形状都解析为 `string[]`；另兼容「JSON 数组字符串」与逗号分隔串。
 * 解析不出内容返回 undefined（调用方省略键，不写空数组）。
 */
export function parseColumnList(value: unknown): string[] | undefined {
  const collect = (arr: unknown[]): string[] =>
    arr.map((v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "")).filter((v) => v.length > 0);

  let raw = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return undefined;
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        raw = Array.isArray(parsed) ? parsed : text;
      } catch {
        raw = text;
      }
    }
    if (typeof raw === "string") {
      const parts = collect(raw.split(","));
      return parts.length > 0 ? parts : undefined;
    }
  }
  if (Array.isArray(raw)) {
    const parts = collect(raw);
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

/** Cypher 字符串字面量转义（与 prompt-injection 同款：属性值用双引号） */
function cypherLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 表间关系查询 Cypher。表键按 `tableKeyCandidates` 双形（三段式 + 去 catalog 的两段式）
 * 匹配 `a.full_table_name`；属性名严格取自 schema.md（`RELATES_TO` 的四个属性）。
 */
export function buildRelatesToCypher(tableKey: string): string {
  const forms = tableKeyCandidates(tableKey).map(cypherLiteral).join(", ");
  return (
    `MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) WHERE a.full_table_name IN [${forms}] ` +
    "RETURN a.full_table_name AS src, r.relationship_type AS relationship_type, r.description AS description, " +
    "r.source_columns AS source_columns, b.full_table_name AS target, r.target_columns AS target_columns " +
    `LIMIT ${MAX_TABLE_RELATIONS}`
  );
}

/** 表键的点号后缀变体（小写），用于识别自环与判断「行属于本表」 */
function keyVariants(key: string): Set<string> {
  const parts = key.split(".");
  const out = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const v = parts.slice(i).join(".").trim().toLowerCase();
    if (v) out.add(v);
  }
  return out;
}

/**
 * 图谱行 → TableRelation。丢弃：无目标表名的行、指向自己的行（自环不建边）。
 * 同一 (targetTable, relationshipType, 列) 组合去重（图谱里重复导入会出重复边）。
 */
export function relationsFromGraphRows(rows: GraphRow[], selfKey?: string): TableRelation[] {
  const self = selfKey ? keyVariants(selfKey) : new Set<string>();
  const out: TableRelation[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    const targetTable = str(row.target) ?? str(row.tgt) ?? str(row.full_table_name);
    if (!targetTable) continue;
    const targetVariants = keyVariants(targetTable);
    // 自环（a RELATES_TO a）：变体集合与本表相交即视为自指
    if (self.size > 0 && [...targetVariants].some((v) => self.has(v))) continue;
    const relationshipType = str(row.relationship_type) ?? str(row.rel) ?? "";
    const description = str(row.description);
    const sourceColumns = parseColumnList(row.source_columns ?? row.src_cols);
    const targetColumns = parseColumnList(row.target_columns ?? row.tgt_cols);
    const dedupeKey = [targetTable.toLowerCase(), relationshipType, (sourceColumns ?? []).join("|"), (targetColumns ?? []).join("|")].join("::");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      targetTable,
      relationshipType,
      ...(description ? { description } : {}),
      ...(sourceColumns ? { sourceColumns } : {}),
      ...(targetColumns ? { targetColumns } : {}),
    });
    if (out.length >= MAX_TABLE_RELATIONS) break;
  }
  return out;
}

/**
 * 降级路径：字段级 `references` → TableRelation。
 *
 * 只在 `references.table` 存在时产出（`isForeignKey === false` 的显式否定尊重之；
 * 未标注 isForeignKey 时以 references 为准——`govio_create_source_table` 的参数形状里
 * 没有 isForeignKey）。同一目标表的多列外键合并为一条关系（列累积），避免重复边。
 */
export function relationsFromFields(fields?: TableRelationFieldLike[]): TableRelation[] {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  const byTarget = new Map<string, TableRelation & { sourceColumns: string[]; targetColumns: string[] }>();
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    if (field.isForeignKey === false) continue;
    const ref = field.references;
    const targetTable = str(ref?.table);
    if (!targetTable) continue;
    const key = targetTable.toLowerCase();
    const sourceColumns = str(field.name) ? [str(field.name)!] : [];
    const targetColumns = str(ref?.field) ? [str(ref!.field)!] : [];
    const existing = byTarget.get(key);
    if (existing) {
      for (const c of sourceColumns) if (!existing.sourceColumns.includes(c)) existing.sourceColumns.push(c);
      for (const c of targetColumns) if (!existing.targetColumns.includes(c)) existing.targetColumns.push(c);
      continue;
    }
    byTarget.set(key, {
      targetTable,
      relationshipType: FIELD_RELATIONSHIP_TYPE,
      sourceColumns: [...sourceColumns],
      targetColumns: [...targetColumns],
    });
    if (byTarget.size >= MAX_TABLE_RELATIONS) break;
  }
  return [...byTarget.values()].map((r) => ({
    targetTable: r.targetTable,
    relationshipType: r.relationshipType,
    ...(r.sourceColumns.length > 0 ? { sourceColumns: r.sourceColumns } : {}),
    ...(r.targetColumns.length > 0 ? { targetColumns: r.targetColumns } : {}),
  }));
}

/** 本地超时闸：到点 reject（底层 promise 继续跑完并填 runGraphQuery 的缓存） */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 解析一张表的表间关系。**永不 throw**：任何失败都降级为
 * `{ relations: <字段级或空>, status:"degraded", error }`。
 */
export async function resolveTableRelations(input: ResolveTableRelationsInput): Promise<TableRelationsResult> {
  const runQuery = input.runQuery ?? runGraphQuery;
  const timeoutMs = input.timeoutMs ?? RELATIONS_QUERY_TIMEOUT_MS;
  const fact: TableFact = {
    nodeId: "",
    label: "",
    tableName: str(input.tableName) ?? "",
    ...(input.qualifiedName ? { qualifiedName: input.qualifiedName } : {}),
    ...(input.schema ? { schema: input.schema } : {}),
  };

  let status: "ok" | "degraded" = "ok";
  let error: string | undefined;
  let relations: TableRelation[] = [];
  let source: TableRelationsSource | undefined;

  const key = graphTableKey(fact);
  if (!key) {
    // 连表键都构造不出（tableName/qualifiedName 均缺失）：查不了图谱，如实留痕后走降级路径
    status = "degraded";
    error = "无可用于图谱查询的表键（qualifiedName / tableName 均缺失）";
  } else {
    try {
      const rows = await withTimeout(runQuery(buildRelatesToCypher(key)), timeoutMs, "RELATES_TO 查询");
      relations = relationsFromGraphRows(rows, key);
      if (relations.length > 0) source = "graph";
    } catch (err) {
      status = "degraded";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  if (relations.length === 0) {
    const fromFields = relationsFromFields(input.fields);
    if (fromFields.length > 0) {
      relations = fromFields;
      source = "fields";
    }
  }

  return {
    relations,
    ...(source ? { source } : {}),
    status,
    ...(error !== undefined ? { error } : {}),
  };
}
