/**
 * T2.1 图谱定义自动注入（语义上下文）。
 *
 * 动机：agent 写 SQL 靠猜测表名/限定名要试错（`docs/tasks/BUGFIX-load-parse.md`）。
 * 本模块在 **prompt 组装时**自动注入两类语义上下文，替代 agent 主动查图谱：
 *   ① 被引用 sourceTable 节点的 qualifiedName/datasourceType/datasource/schema
 *      （T2.0 产物，SQL 表引用一律以 qualifiedName 为准，禁止猜测）；
 *   ② 图谱中与「问题实体 / 引用表」相关的指标定义（Metric）、字段标准（Col）、
 *      枚举码值（Dimension.values_example），来源 `govio-cli query`（Cypher 属性名
 *      以 `.agents/skills/govio/assets/schema.md` 为准）。
 *
 * 注入形态：prompt 中 REF 行之后追加一行 `CTX:<json>`（无 REF 时直接在内容前）。
 * `CTX:` 行随消息写入会话 transcript（jsonl）即为「注入内容随消息留痕」；
 * 被注入节点与图谱实体 ID 列表另行落 `<session>.injection.jsonl` sidecar
 * （append-only，生命周期同会话，与 permission-audit 同款模式）。
 *
 * 降级纪律（acceptance 4）：图谱不可达 / 查询失败 / 无相关实体时**绝不阻断会话**——
 * 图谱部分降级为不注入（graphStatus=degraded 只随已注入内容留痕），表限定名注入
 * 与图谱无关照常进行；两者都拿不到时 prompt 与现状（REF + content）逐字一致。
 *
 * 取数纪律：TableFact 的 qualifiedName 等字段只从「消息内 ref.data JSON」与
 * 「canvas sidecar 节点数据」合并而来，拿不到就省略——禁止猜测（spec 11）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { SemanticEntityType } from "../src/types/semantic.js";
import { runGraphQuery, type GraphRow, type GraphQueryRunner } from "./graph-query.js";

// ---- 注入载荷类型 ----

/** 被引用 sourceTable 的事实（供 SQL 表引用取值，禁止猜测） */
export interface TableFact {
  /** 画布节点 ID（注入留痕用） */
  nodeId: string;
  /** 节点标题 */
  label: string;
  /** 表名（不含 schema/catalog） */
  tableName: string;
  database?: string;
  /** SQL 中应使用的全限定表名（spec 11），缺失即省略 */
  qualifiedName?: string;
  /** observe 数据源名（`observe load --datasource` 取值） */
  datasource?: string;
  datasourceType?: string;
  schema?: string;
}

/** 图谱实体类型（与前端 semanticRefs 同源：src/types/semantic.ts，T2.2） */
export type GraphEntityType = SemanticEntityType;

/** 图谱实体（Metric 指标定义 / Dimension 枚举码值 / Col 字段标准） */
export interface GraphEntity {
  entityType: GraphEntityType;
  /** 图谱节点主键（注入留痕用） */
  id: string;
  code?: string;
  name?: string;
  /** Metric：业务定义 / 公式 / 单位 / 类型 */
  definition?: string;
  formula?: string;
  unit?: string;
  metricType?: string;
  /** Dimension：粒度 / 枚举码值样例 */
  granularity?: string;
  valuesExample?: string;
  /** Col：字段标准（列名 / 数据类型） */
  columnName?: string;
  dataType?: string;
}

/**
 * 图谱查询状态：
 * - `ok`：全部查询成功（无相关实体时 graphEntities 为空数组）
 * - `degraded`：至少一条查询失败（CLI 不可达/超时/Binder 错误），已注入内容仍可用
 */
export type GraphStatus = "ok" | "degraded";

export interface InjectionContext {
  tables: TableFact[];
  graphEntities: GraphEntity[];
  graphStatus: GraphStatus;
  graphError?: string;
}

/** makePrompt 传入的消息形状（WSMessage 的 prompt 分支子集） */
export interface PromptMessageLike {
  content: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type?: string; data?: string | null }>;
}

type RefLike = NonNullable<PromptMessageLike["referencedNodes"]>[number];

// ---- 工具 ----

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseDataJson(data?: string | null): Record<string, unknown> {
  if (!data) return {};
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 图谱侧 two-segment 表键（PhysicalTable.full_table_name 形态：`schema.table`） */
export function graphTableKey(fact: TableFact): string | undefined {
  return fact.schema && fact.tableName ? `${fact.schema}.${fact.tableName}` : undefined;
}

function questionMentions(question: string, term?: string): boolean {
  return !!term && term.length >= 2 && question.includes(term);
}

/** Cypher 字符串字面量转义（属性值按 govio-query 纪律用双引号） */
function cypherLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---- ① 表事实解析（消息 data + canvas sidecar 合并，缺啥省啥，禁止猜测） ----

/**
 * 从 referencedNodes 解析 sourceTable 事实。
 * 字段优先级：消息内 `ref.data` JSON（前端 addReference 序列化）> canvas sidecar
 * 节点数据（`loadCanvas()` 的 nodes，含 T2.0 全套标注字段）。
 * 仅收 sourceTable；认不出 tableName 的引用直接跳过（不注入半截事实）。
 */
export function resolveTableFacts(
  referencedNodes: RefLike[] | undefined,
  canvasNodes?: unknown[],
): TableFact[] {
  if (!referencedNodes || referencedNodes.length === 0) return [];
  const byId = new Map<string, Record<string, unknown>>();
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const raw of canvasNodes ?? []) {
    const node = raw as { id?: unknown; data?: unknown };
    if (typeof node.id !== "string" || node.data === null || typeof node.data !== "object") continue;
    const d = node.data as Record<string, unknown>;
    byId.set(node.id, d);
    const title = str(d.title);
    if (title && !byLabel.has(title)) byLabel.set(title, d);
  }

  const facts: TableFact[] = [];
  for (const ref of referencedNodes) {
    const nodeData = byId.get(ref.nodeId) ?? byLabel.get(ref.label ?? "") ?? {};
    const msgData = parseDataJson(ref.data);
    const type = str(nodeData.type) ?? ref.type;
    if (type !== "sourceTable") continue;
    // addReference 现行序列化是 {full_table_name: <tableName>, fields}——full_table_name
    // 在消息里实际是**表名**（历史命名），sidecar 的 tableName 才是规范来源。
    const tableName = str(nodeData.tableName) ?? str(msgData.tableName) ?? str(msgData.table_name) ?? str(msgData.full_table_name);
    if (!tableName) continue;
    const fact: TableFact = {
      nodeId: ref.nodeId,
      label: ref.label ?? "",
      tableName,
    };
    fact.database = str(nodeData.database) ?? str(msgData.database);
    fact.qualifiedName = str(nodeData.qualifiedName) ?? str(msgData.qualifiedName);
    fact.datasource = str(nodeData.datasource) ?? str(msgData.datasource);
    fact.datasourceType = str(nodeData.datasourceType) ?? str(msgData.datasourceType);
    fact.schema = str(nodeData.schema) ?? str(msgData.schema);
    facts.push(fact);
  }
  return facts;
}

// ---- ② 图谱实体获取（govio-cli query，Cypher 属性名依 schema.md） ----

const MAX_METRICS = 15;
const MAX_DIMENSIONS = 15;
const MAX_COLS_PER_TABLE = 40;

const QUERY_METRICS =
  "MATCH (m:Metric) RETURN m.id AS id, m.code AS code, m.name AS name, " +
  "m.business_definition AS definition, m.type AS metric_type, m.formula AS formula, m.unit AS unit LIMIT 300";
const QUERY_METRIC_TABLES =
  "MATCH (m:Metric)-[:USES_TABLE]->(t:PhysicalTable) " +
  "RETURN m.id AS metric_id, t.full_table_name AS table_full_name LIMIT 300";
const QUERY_METRIC_DIMENSIONS =
  "MATCH (m:Metric)-[r:DIMENSION_USED]->(d:Dimension) " +
  "RETURN m.id AS metric_id, d.id AS id, d.code AS code, d.name AS name, " +
  "d.granularity AS granularity, d.values_example AS values_example LIMIT 300";

function queryTableColumns(fullTableName: string): string {
  return (
    `MATCH (c:Col) WHERE c.full_table_name = ${cypherLiteral(fullTableName)} ` +
    "RETURN c.id AS id, c.column_name AS column_name, c.data_type AS data_type, " +
    "c.dtype AS dtype, c.precision AS precision, c.scale AS scale LIMIT 300"
  );
}

function entityFromRow(row: GraphRow, entityType: GraphEntityType): GraphEntity | null {
  const id = str(row.id);
  if (!id) return null;
  const e: GraphEntity = { entityType, id };
  e.code = str(row.code);
  e.name = str(row.name);
  if (entityType === "Metric") {
    e.definition = str(row.definition);
    e.formula = str(row.formula);
    e.unit = str(row.unit);
    e.metricType = str(row.metric_type);
  } else if (entityType === "Dimension") {
    e.granularity = str(row.granularity);
    e.valuesExample = str(row.values_example);
  } else {
    e.columnName = str(row.column_name);
    e.dataType = str(row.data_type) ?? str(row.dtype);
  }
  return e;
}

export interface BuildInjectionOptions {
  content: string;
  referencedNodes?: RefLike[];
  /** `loadCanvas()` 的 nodes（sidecar），用于补齐消息 data 里缺的 T2.0 标注字段 */
  canvasNodes?: unknown[];
  /** 图谱查询执行器（默认 govio-cli；测试注入 fake） */
  runQuery?: GraphQueryRunner;
}

/**
 * 组装注入上下文。**永不 throw**：图谱部分任何失败都降级为 graphStatus=degraded
 * （已获得的实体照常注入），表事实部分不依赖图谱。
 */
export async function buildInjectionContext(opts: BuildInjectionOptions): Promise<InjectionContext> {
  const tables = resolveTableFacts(opts.referencedNodes, opts.canvasNodes);
  const question = opts.content ?? "";
  const runQuery = opts.runQuery ?? runGraphQuery;

  const tableKeys = [...new Set(tables.map(graphTableKey).filter((k): k is string => !!k))];
  const queries: Array<{ key: string; cypher: string }> = [
    { key: "metrics", cypher: QUERY_METRICS },
    { key: "metricTables", cypher: QUERY_METRIC_TABLES },
    { key: "metricDims", cypher: QUERY_METRIC_DIMENSIONS },
    ...tableKeys.map((k) => ({ key: `cols:${k}`, cypher: queryTableColumns(k) })),
  ];

  let graphStatus: GraphStatus = "ok";
  let graphError: string | undefined;
  const rowsByKey = new Map<string, GraphRow[]>();
  if (queries.length > 0) {
    const settled = await Promise.allSettled(
      queries.map(async (q) => ({ key: q.key, rows: await runQuery(q.cypher) })),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") {
        rowsByKey.set(s.value.key, s.value.rows);
      } else {
        graphStatus = "degraded";
        graphError = String(s.reason instanceof Error ? s.reason.message : s.reason);
      }
    }
  }

  // 指标筛选：引用表相关（USES_TABLE 命中）∪ 问题实体命中（问题文本包含指标名/编码）
  const metrics: GraphEntity[] = [];
  const metricRowById = new Map<string, GraphRow>();
  for (const row of rowsByKey.get("metrics") ?? []) {
    const e = entityFromRow(row, "Metric");
    if (e) {
      metrics.push(e);
      metricRowById.set(e.id, row);
    }
  }
  const tablesByMetric = new Map<string, Set<string>>();
  for (const row of rowsByKey.get("metricTables") ?? []) {
    const metricId = str(row.metric_id);
    const ftn = str(row.table_full_name);
    if (!metricId || !ftn) continue;
    if (!tablesByMetric.has(metricId)) tablesByMetric.set(metricId, new Set());
    tablesByMetric.get(metricId)!.add(ftn);
  }
  const keySet = new Set(tableKeys.map((k) => k.toLowerCase()));
  const isReferencedMetric = (m: GraphEntity): boolean =>
    [...(tablesByMetric.get(m.id) ?? [])].some((t) => keySet.has(t.toLowerCase()));
  const selectedMetrics = metrics
    .filter((m) => isReferencedMetric(m) || questionMentions(question, m.name) || questionMentions(question, m.code))
    .slice(0, MAX_METRICS);

  // 维度筛选：选中指标的维度 ∪ 问题命中的维度（Dimension.values_example = 枚举码值）
  const dimByMetric = new Map<string, GraphEntity[]>();
  const allDims = new Map<string, GraphEntity>();
  for (const row of rowsByKey.get("metricDims") ?? []) {
    const e = entityFromRow(row, "Dimension");
    const metricId = str(row.metric_id);
    if (!e || !metricId) continue;
    if (!allDims.has(e.id)) allDims.set(e.id, e);
    if (!dimByMetric.has(metricId)) dimByMetric.set(metricId, []);
    dimByMetric.get(metricId)!.push(e);
  }
  const dimMap = new Map<string, GraphEntity>();
  for (const m of selectedMetrics) {
    for (const d of dimByMetric.get(m.id) ?? []) dimMap.set(d.id, d);
  }
  for (const d of allDims.values()) {
    if (questionMentions(question, d.name) || questionMentions(question, d.code)) dimMap.set(d.id, d);
  }
  const selectedDims = [...dimMap.values()].slice(0, MAX_DIMENSIONS);

  // 字段标准：引用表的 Col（data_type/精度等，spec 11 的「字段标准」来源）
  const cols: GraphEntity[] = [];
  for (const key of tableKeys) {
    const rows = rowsByKey.get(`cols:${key}`) ?? [];
    for (const row of rows) {
      const e = entityFromRow(row, "Col");
      if (e) cols.push(e);
    }
    if (cols.length >= MAX_COLS_PER_TABLE * tableKeys.length) break;
  }

  return {
    tables,
    graphEntities: [...selectedMetrics, ...selectedDims, ...cols.slice(0, MAX_COLS_PER_TABLE * Math.max(tableKeys.length, 1))],
    graphStatus,
    ...(graphError !== undefined ? { graphError } : {}),
  };
}

// ---- Prompt 组装（REF + CTX + content） ----

/** 注入块里的固定指令：SQL 表引用纪律 + 各实体类型的口径含义 */
export const CTX_INSTRUCTIONS =
  "语义上下文（自动注入）：SQL 表引用必须使用 tables[].qualifiedName 原文，禁止猜测或试错表名；" +
  "graphEntities 为口径参考——Metric.definition/formula/unit 是指标定义，Col.dataType 是字段标准，" +
  "Dimension.valuesExample 是枚举码值。graphStatus=degraded 时图谱查询失败，以 tables 为准。";

/**
 * 组装最终 prompt（纯函数，可直接断言）：
 * `REF:[...]`（原有形态逐字保留）→ `CTX:<json>`（有可注入内容时）→ 用户内容。
 * REF 序列化保持既有 envelope（JSON.stringify 单项），session-history 的
 * parseRefPrefix 依赖该形态；CTX 行为单行 JSON（不含换行），便于解析与剥离。
 */
export function composePrompt(msg: PromptMessageLike, ctx: InjectionContext | null): string {
  let prompt = "";
  if (msg.referencedNodes && msg.referencedNodes.length > 0) {
    // Serialize each ref as proper JSON so quotes/newlines in labels or node
    // data cannot break the REF:[...] envelope or inject extra structure.
    const entries = msg.referencedNodes.map((ref) =>
      JSON.stringify({ [ref.label ?? ""]: ref.data ?? "" }),
    );
    prompt += `REF:[${entries.join(", ")}]\n`;
  }
  if (ctx && (ctx.tables.length > 0 || ctx.graphEntities.length > 0)) {
    const payload = {
      tables: ctx.tables,
      graphEntities: ctx.graphEntities,
      graphStatus: ctx.graphStatus,
      instructions: CTX_INSTRUCTIONS,
    };
    prompt += `CTX:${JSON.stringify(payload)}\n`;
  }
  prompt += msg.content;
  return prompt;
}

// ---- 注入留痕（sidecar JSONL，append-only） ----

/** 注入留痕记录结构版本；字段增删时递增 */
export const INJECTION_TRACE_VERSION = 1;

export interface InjectionTraceEntry {
  v: number;
  /** ISO 8601 时间戳（服务端时钟） */
  at: string;
  sessionId: string;
  sessionFile: string;
  /** 用户问题前缀（不含 REF/CTX 注入块） */
  contentPreview: string;
  /** 被注入节点 ID 列表 */
  tables: Array<{ nodeId: string; label: string; qualifiedName?: string; datasourceType?: string }>;
  /** 注入的图谱实体 ID 列表 */
  graphEntities: Array<{ entityType: GraphEntityType; id: string; code?: string }>;
  graphStatus: GraphStatus;
  graphError?: string;
}

/** 注入留痕 sidecar 路径：`<session-file>.injection.jsonl` */
export function injectionTracePathFor(sessionFile: string): string {
  return `${sessionFile}.injection.jsonl`;
}

/** 由注入上下文组装留痕条目（纯函数，可断言） */
export function buildTraceEntry(
  ctx: InjectionContext,
  meta: { sessionId: string; sessionFile: string; content: string },
): InjectionTraceEntry {
  const entry: InjectionTraceEntry = {
    v: INJECTION_TRACE_VERSION,
    at: new Date().toISOString(),
    sessionId: meta.sessionId,
    sessionFile: meta.sessionFile,
    contentPreview: meta.content.slice(0, 120),
    tables: ctx.tables.map((t) => {
      const item: InjectionTraceEntry["tables"][number] = { nodeId: t.nodeId, label: t.label };
      if (t.qualifiedName !== undefined) item.qualifiedName = t.qualifiedName;
      if (t.datasourceType !== undefined) item.datasourceType = t.datasourceType;
      return item;
    }),
    graphEntities: ctx.graphEntities.map((e) => {
      const item: InjectionTraceEntry["graphEntities"][number] = { entityType: e.entityType, id: e.id };
      if (e.code !== undefined) item.code = e.code;
      return item;
    }),
    graphStatus: ctx.graphStatus,
  };
  if (ctx.graphError !== undefined) entry.graphError = ctx.graphError;
  return entry;
}

/**
 * 追加一条注入留痕（只追加、不回改；写失败只告警不抛错，绝不阻断会话）。
 * sessionFile 为空（会话尚未落盘）时跳过留痕，返回 null。
 */
export function recordInjectionTrace(sessionFile: string | null, entry: InjectionTraceEntry): InjectionTraceEntry | null {
  if (!sessionFile) {
    console.warn("[prompt-injection] 当前无会话文件，注入留痕未落盘");
    return null;
  }
  const path = injectionTracePathFor(sessionFile);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error(`[prompt-injection] 写入 ${path} 失败:`, err);
    return null;
  }
  return entry;
}

/** 读回某会话的全部注入留痕（文件不存在返回空数组，坏行跳过）。 */
export function readInjectionTrace(sessionFile: string): InjectionTraceEntry[] {
  const path = injectionTracePathFor(sessionFile);
  if (!existsSync(path)) return [];
  try {
    const entries: InjectionTraceEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        entries.push(JSON.parse(text) as InjectionTraceEntry);
      } catch {
        // 坏行跳过：一行坏掉不应让整份留痕读不出来
      }
    }
    return entries;
  } catch (err) {
    console.error(`[prompt-injection] 读取 ${path} 失败:`, err);
    return [];
  }
}

/** 删除某会话的注入留痕 sidecar（`deleteSession()` 调用）。返回是否真的删掉了文件。 */
export function deleteInjectionTrace(sessionFile: string): boolean {
  const path = injectionTracePathFor(sessionFile);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
