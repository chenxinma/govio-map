/**
 * T2.1 验证脚本：图谱定义自动注入 Prompt（自动注入 / 留痕 / 命中率测量 / 降级）。
 *
 * 复跑：`npm run verify:prompt-injection`（等价于 `npx tsx scripts/verify-prompt-injection.ts`）
 *
 * 覆盖（对齐 task-plan T2.1 acceptance）：
 *  1. 自动注入序列化：引用 sourceTable 时 prompt 含 qualifiedName/datasourceType
 *     （makePrompt 的 REF/CTX 序列化）；REF envelope 形态逐字保持（旧断言兼容）
 *  2. 注入留痕：每次注入记录被注入节点 ID 与图谱实体 ID 列表，落 `<session>.injection.jsonl`
 *     sidecar（append-only、随会话删除）
 *  3. 口径命中率测量：抽样比对生成 SQL 的表引用与注入的 qualifiedName
 *     （限定名命中 / 裸表名 miss / CTE 引用排除；fixture 会话 jsonl 走真实解析路径）
 *  4. 降级：图谱不可达 / 单查询失败 / 无相关实体时注入降级且不阻断会话
 *
 * 另含：会话 transcript 上屏时 CTX 注入行剥离（留痕不上屏）。
 * 任一断言失败退出码为 1。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInjectionContext,
  composePrompt,
  resolveTableFacts,
  buildTraceEntry,
  recordInjectionTrace,
  readInjectionTrace,
  deleteInjectionTrace,
  injectionTracePathFor,
  graphTableKey,
  CTX_INSTRUCTIONS,
  type InjectionContext,
  type TableFact,
} from "../server/prompt-injection.js";
import { parseQueryRows, isEmptyResultOutput, describeExecError, type GraphQueryRunner, type GraphRow } from "../server/graph-query.js";
import { buildTranscript } from "../server/session-history.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── fixture 数据（形态取自 2026-11-05 ladybug 后端实测输出） ──────────────────

const FX_METRICS: GraphRow[] = [
  { id: "ME1", code: "m_sales_amount", name: "销售额", definition: "统计周期内所有订单的销售金额合计", metric_type: "atomic", formula: "", unit: "元" },
  { id: "ME2", code: "m_boxes_shipped", name: "出货箱数", definition: "统计周期内所有订单的出货箱数合计", metric_type: "atomic", formula: "", unit: "箱" },
  { id: "ME3", code: "m_unrelated", name: "无关指标", definition: "不应被注入", metric_type: "atomic", formula: "", unit: "元" },
];
// 图谱 full_table_name 实测为 SQL 限定名形态（duckdb 三段式，2026-11-08 ladybug 实证）
const FX_METRIC_TABLES: GraphRow[] = [
  { metric_id: "ME1", table_full_name: "chocolate.chocolate.fact_sales" },
  { metric_id: "ME2", table_full_name: "chocolate.chocolate.fact_sales" },
];
const FX_METRIC_DIMS: GraphRow[] = [
  { metric_id: "ME1", id: "DI1", code: "dim_time", name: "时间维度", granularity: "day", values_example: "2024-01-01" },
  { metric_id: "ME1", id: "DI2", code: "dim_region", name: "区域", granularity: "province", values_example: "华东区" },
];
const FX_COLS_DIM_PRODUCT: GraphRow[] = [
  { id: "CO1", column_name: "product_id", data_type: "BIGINT", dtype: "BIGINT", precision: "0", scale: "0" },
  { id: "CO2", column_name: "product_name", data_type: "VARCHAR", dtype: "VARCHAR", precision: "0", scale: "0" },
];

/** 按 Cypher 关键词分发的 fake 图谱 runner（记录发出的 Cypher 供纪律断言） */
function fakeRunner(opts: { failAll?: boolean; failCols?: boolean } = {}): {
  runQuery: GraphQueryRunner;
  cyphers: string[];
} {
  const cyphers: string[] = [];
  const runQuery: GraphQueryRunner = async (cypher) => {
    cyphers.push(cypher);
    if (opts.failAll) throw new Error("spawn govio-cli ENOENT");
    if (cypher.includes("MATCH (c:Col)")) {
      if (opts.failCols) throw new Error("Binder exception");
      return FX_COLS_DIM_PRODUCT;
    }
    if (cypher.includes("USES_TABLE")) return FX_METRIC_TABLES;
    if (cypher.includes("DIMENSION_USED")) return FX_METRIC_DIMS;
    return FX_METRICS;
  };
  return { runQuery, cyphers };
}

const factProduct: TableFact = {
  nodeId: "n-product",
  label: "dim_product",
  tableName: "dim_product",
  database: "chocolate",
  qualifiedName: "chocolate.chocolate.dim_product",
  datasource: "chocolate",
  datasourceType: "duckdb",
  schema: "chocolate",
};
const factSales: TableFact = {
  nodeId: "n-sales",
  label: "fact_sales",
  tableName: "fact_sales",
  database: "chocolate",
  qualifiedName: "chocolate.chocolate.fact_sales",
  datasource: "chocolate",
  datasourceType: "duckdb",
  schema: "chocolate",
};

// ── A. composePrompt：REF/CTX 序列化（acceptance 1） ─────────────────────────

console.log("\n[A] makePrompt/REF 序列化（引用 sourceTable 注入 qualifiedName/datasourceType）");

{
  const prompt = composePrompt(
    { content: "统计订单金额", referencedNodes: [{ nodeId: "g1", label: "orders", type: "sqlQuery", data: "SELECT * FROM orders" }] },
    null,
  );
  check("REF envelope 形态逐字保持（^REF:[ + content，旧断言兼容）",
    prompt === 'REF:[{"orders":"SELECT * FROM orders"}]\n统计订单金额', prompt);
}

{
  const ctx: InjectionContext = { tables: [factProduct], graphEntities: [], graphStatus: "ok" };
  const prompt = composePrompt(
    { content: "统计订单金额", referencedNodes: [{ nodeId: "n-product", label: "dim_product", type: "sourceTable", data: "{}" }] },
    ctx,
  );
  check("CTX 行注入且含 qualifiedName", prompt.includes("CTX:") && prompt.includes("chocolate.chocolate.dim_product"));
  check("CTX 行注入且含 datasourceType", prompt.includes('"datasourceType":"duckdb"'));
  check("CTX 行含 datasource/schema 与表限定名纪律指令", prompt.includes('"datasource":"chocolate"') && prompt.includes('"schema":"chocolate"') && prompt.includes(CTX_INSTRUCTIONS));
  check("CTX 在 REF 之后、用户内容之前",
    prompt.indexOf("REF:[") === 0 && prompt.indexOf("CTX:") < prompt.indexOf("统计订单金额") && prompt.indexOf("CTX:") > prompt.indexOf("REF:["));
  const ctxLine = prompt.split("\n").find((l) => l.startsWith("CTX:")) ?? "";
  let parsed: unknown = null;
  try { parsed = JSON.parse(ctxLine.slice("CTX:".length)); } catch { /* fallthrough */ }
  const obj = parsed as { tables?: unknown[]; graphStatus?: string } | null;
  check("CTX 行为单行合法 JSON（含 tables/graphStatus/instructions 键）",
    !!obj && Array.isArray(obj.tables) && obj.graphStatus === "ok" && ctxLine.includes("instructions"));
  check("注入后用户内容原样保留", prompt.endsWith("统计订单金额"));
}

{
  const prompt = composePrompt({ content: "普通问题" }, null);
  check("无注入内容时 prompt 与现状逐字一致（无 CTX 行，降级为现状行为）", prompt === "普通问题" && !prompt.includes("CTX:"));
}

{
  // 问题实体命中注入：无 referencedNodes 也应带 CTX（会话启动首条消息场景）
  const ctx: InjectionContext = {
    tables: [],
    graphEntities: [{ entityType: "Metric", id: "ME1", code: "m_sales_amount", name: "销售额" }],
    graphStatus: "ok",
  };
  const prompt = composePrompt({ content: "销售额是多少" }, ctx);
  check("无 referencedNodes 但命中问题实体时只出 CTX 行（无 REF）",
    !prompt.startsWith("REF:") && prompt.startsWith("CTX:") && prompt.endsWith("销售额是多少"));
}

{
  // 退化但仍有表事实：CTx 带 graphStatus=degraded，prompt 依旧可用
  const ctx: InjectionContext = { tables: [factProduct], graphEntities: [], graphStatus: "degraded", graphError: "spawn govio-cli ENOENT" };
  const prompt = composePrompt({ content: "q", referencedNodes: [{ nodeId: "n", label: "dim_product", type: "sourceTable" }] }, ctx);
  check("图谱降级时 CTX 仍注入表事实且标记 degraded", prompt.includes("CTX:") && prompt.includes('"graphStatus":"degraded"') && prompt.endsWith("q"));
}

// ── B. resolveTableFacts（消息 data + sidecar 合并，缺啥省啥） ────────────────

console.log("\n[B] 表事实解析（禁止猜测、字段可追溯）");

{
  const facts = resolveTableFacts(
    [{ nodeId: "n1", label: "dim_product", type: "sourceTable", data: JSON.stringify({ full_table_name: "dim_product", qualifiedName: "chocolate.chocolate.dim_product", datasourceType: "duckdb", datasource: "chocolate", schema: "chocolate", fields: [] }) }],
  );
  check("消息 data JSON 提供 T2.0 标注（无 sidecar 也可注入）",
    facts.length === 1 && facts[0].qualifiedName === "chocolate.chocolate.dim_product" && facts[0].datasourceType === "duckdb");
}

{
  // addReference 现行序列化只有 {full_table_name, fields}，T2.0 字段靠 sidecar 节点补齐
  const sidecarNodes = [{ id: "n1", data: { type: "sourceTable", title: "dim_product", tableName: "dim_product", database: "chocolate", qualifiedName: "chocolate.chocolate.dim_product", datasourceType: "duckdb", datasource: "chocolate", schema: "chocolate", fields: [] } }];
  const facts = resolveTableFacts(
    [{ nodeId: "n1", label: "dim_product", type: "sourceTable", data: JSON.stringify({ full_table_name: "dim_product", fields: [] }) }],
    sidecarNodes,
  );
  check("sidecar 节点数据补齐消息 data 缺失的 qualifiedName/datasourceType",
    facts.length === 1 && facts[0].qualifiedName === "chocolate.chocolate.dim_product" && facts[0].datasourceType === "duckdb" && facts[0].tableName === "dim_product");
  check("graphTableKey 取 qualifiedName（图谱 full_table_name 形态，三段式）", graphTableKey(facts[0]) === "chocolate.chocolate.dim_product");
}

{
  // 回归（BUGFIX-injection-graph-key）：历史节点 tableName 存的就是限定名，
  // graphTableKey 不得再拼 schema 前缀——曾产生 chocolate.chocolate.chocolate.fact_sales 四段式
  const facts = resolveTableFacts(
    [{ nodeId: "n1", label: "fact_sales", type: "sourceTable", data: JSON.stringify({ full_table_name: "chocolate.chocolate.fact_sales", schema: "chocolate" }) }],
  );
  check("tableName 已带点号时不再拼 schema 前缀（四段式回归防护）",
    graphTableKey(facts[0]) === "chocolate.chocolate.fact_sales");
}

{
  const facts = resolveTableFacts(
    [
      { nodeId: "a", label: "sql1", type: "sqlQuery", data: "SELECT 1" },
      { nodeId: "b", label: "df1", type: "dataFrame", data: "df_x" },
      { nodeId: "c", label: "mystery", type: "sourceTable", data: JSON.stringify({ fields: [] }) },
    ],
  );
  check("非 sourceTable 引用不产生事实", !facts.some((f) => f.nodeId === "a" || f.nodeId === "b"));
  check("认不出 tableName 的引用跳过（禁止猜测，不注入半截事实）", facts.length === 0);
}

// ── C. buildInjectionContext：图谱实体选择 + 降级（acceptance 4） ─────────────

console.log("\n[C] 图谱实体注入与降级（图谱不可达不阻断会话）");

{
  const { runQuery, cyphers } = fakeRunner();
  const ctx = await buildInjectionContext({
    content: "按区域统计销售额",
    referencedNodes: [{ nodeId: "n-product", label: "dim_product", type: "sourceTable", data: JSON.stringify(factProduct) }],
    runQuery,
  });
  const ids = ctx.graphEntities.map((e) => e.id);
  check("引用表事实注入 tables（qualifiedName/datasourceType 齐全）",
    ctx.tables.length === 1 && ctx.tables[0].qualifiedName === "chocolate.chocolate.dim_product" && ctx.tables[0].datasourceType === "duckdb");
  check("问题命中的指标注入（含业务定义/单位）",
    ids.includes("ME1") && ctx.graphEntities.some((e) => e.id === "ME1" && e.definition?.includes("销售金额") && e.unit === "元"));
  check("选中指标的维度注入（含枚举码值 valuesExample）",
    ids.includes("DI1") && ids.includes("DI2") && ctx.graphEntities.some((e) => e.id === "DI2" && e.valuesExample === "华东区"));
  check("引用表字段标准注入（Col data_type）",
    ids.includes("CO1") && ctx.graphEntities.some((e) => e.id === "CO1" && e.dataType === "BIGINT"));
  check("无关实体不注入（ME3 未命中问题与引用表）", !ids.includes("ME3"));
  check("Cypher 纪律：全部查询以 MATCH 开头且带 LIMIT 300",
    cyphers.length === 4 && cyphers.every((c) => c.startsWith("MATCH") && c.includes("LIMIT 300")));
  check("Col 查询按表键双形匹配（三段式 + 去 catalog 段兜底）",
    cyphers.some((c) => c.includes('c.full_table_name IN ["chocolate.chocolate.dim_product", "chocolate.dim_product"]')));
  check("graphStatus=ok", ctx.graphStatus === "ok" && ctx.graphError === undefined);
}

{
  const { runQuery } = fakeRunner();
  const ctx = await buildInjectionContext({
    content: "随便问点什么",
    referencedNodes: [{ nodeId: "n-sales", label: "fact_sales", type: "sourceTable", data: JSON.stringify(factSales) }],
    runQuery,
  });
  const ids = ctx.graphEntities.map((e) => e.id);
  check("引用表命中指标（USES_TABLE 边）注入：ME1+ME2", ids.includes("ME1") && ids.includes("ME2"));
}

{
  // 表键段数容错（BUGFIX-injection-graph-key）：图谱 full_table_name 2↔3 段偏差（catalog 前缀）
  // 不应让引用表指标失联——semanticRefs 缺失会令 T2.3 口径冲突检测静默跳过
  const twoPartRunner: GraphQueryRunner = async (cypher) => {
    if (cypher.includes("USES_TABLE")) return [{ metric_id: "ME1", table_full_name: "chocolate.fact_sales" }];
    if (cypher.includes("DIMENSION_USED")) return [];
    if (cypher.includes("MATCH (c:Col)")) return [];
    return FX_METRICS;
  };
  const ctx = await buildInjectionContext({
    content: "随便问点什么",
    referencedNodes: [{ nodeId: "n-sales", label: "fact_sales", type: "sourceTable", data: JSON.stringify(factSales) }],
    runQuery: twoPartRunner,
  });
  check("图谱表键 2↔3 段偏差仍命中引用表指标（后缀容错）", ctx.graphEntities.some((e) => e.id === "ME1"));
}

{
  // 图谱整体不可达：不 throw、tables 保留、状态 degraded
  const { runQuery } = fakeRunner({ failAll: true });
  const ctx = await buildInjectionContext({
    content: "q",
    referencedNodes: [{ nodeId: "n-product", label: "dim_product", type: "sourceTable", data: JSON.stringify(factProduct) }],
    runQuery,
  });
  check("图谱不可达整体降级：graphStatus=degraded 且 error 留痕",
    ctx.graphStatus === "degraded" && !!ctx.graphError && ctx.graphError.includes("ENOENT"));  check("降级时表事实照常注入（不依赖图谱）", ctx.tables.length === 1 && ctx.graphEntities.length === 0);
  const prompt = composePrompt({ content: "q" }, ctx);
  check("降级后 prompt 仍可用且不阻断（含 CTX 表事实 + 用户内容）",
    prompt.includes("CTX:") && prompt.endsWith("q") && prompt.includes("chocolate.chocolate.dim_product"));
}

{
  // 单查询失败（Col Binder error）：degraded 但其余实体照常注入
  const { runQuery } = fakeRunner({ failCols: true });
  const ctx = await buildInjectionContext({
    content: "按区域统计销售额",
    referencedNodes: [{ nodeId: "n-product", label: "dim_product", type: "sourceTable", data: JSON.stringify(factProduct) }],
    runQuery,
  });
  check("单查询失败 → degraded 且其余实体照常注入",
    ctx.graphStatus === "degraded" && ctx.graphEntities.some((e) => e.id === "ME1") && !ctx.graphEntities.some((e) => e.entityType === "Col"));
}

{
  // 无相关实体：graphEntities 空；且无 tables 时 CTX 不出现（现状行为）
  const emptyRunner: GraphQueryRunner = async () => [];
  const ctx = await buildInjectionContext({ content: "完全无关的问题", runQuery: emptyRunner });
  check("图谱返回空 → graphEntities 空数组且状态 ok（非失败）", ctx.graphEntities.length === 0 && ctx.graphStatus === "ok");
  check("无表无实体时 composePrompt 无 CTX 行（降级为现状行为）",
    composePrompt({ content: "完全无关的问题" }, ctx) === "完全无关的问题");
}

// ── D. 注入留痕（acceptance 2） ─────────────────────────────────────────────

console.log("\n[D] 注入留痕（节点 ID + 图谱实体 ID 列表随会话持久化）");

const tmp = mkdtempSync(join(tmpdir(), "govio-t21-"));
const sessionFile = join(tmp, "sess-t21.jsonl");
try {
  const ctx: InjectionContext = {
    tables: [factProduct],
    graphEntities: [{ entityType: "Metric", id: "ME1", code: "m_sales_amount" }, { entityType: "Col", id: "CO1" }],
    graphStatus: "ok",
  };
  const entry = buildTraceEntry(ctx, { sessionId: "sess-1", sessionFile, content: "统计销售额" });
  check("留痕记录被注入节点 ID 与图谱实体 ID 列表",
    entry.tables.length === 1 && entry.tables[0].nodeId === "n-product" &&
    entry.graphEntities.length === 2 && entry.graphEntities[0].id === "ME1" && entry.graphEntities[1].id === "CO1");
  check("留痕含 qualifiedName/datasourceType 与 graphStatus（口径可追溯）",
    entry.tables[0].qualifiedName === "chocolate.chocolate.dim_product" && entry.tables[0].datasourceType === "duckdb" && entry.graphStatus === "ok");

  check("recordInjectionTrace 落盘返回条目", recordInjectionTrace(sessionFile, entry) !== null);
  recordInjectionTrace(sessionFile, { ...entry, at: new Date().toISOString(), contentPreview: "第二问" });
  const lines = readFileSync(injectionTracePathFor(sessionFile), "utf8").trim().split("\n");
  check("留痕 sidecar 为 append-only JSONL（两条）", lines.length === 2 && lines.every((l) => JSON.parse(l).v === 1));
  const back = readInjectionTrace(sessionFile);
  check("readInjectionTrace 读回与写入一致", back.length === 2 && back[0].graphEntities.length === 2 && back[1].contentPreview === "第二问");
  check("坏行不影响整份留痕读取", (() => {
    appendFileSync(injectionTracePathFor(sessionFile), "{bad json\n", "utf8");
    return readInjectionTrace(sessionFile).length === 2;
  })());
  check("deleteInjectionTrace 随会话删除 sidecar",
    deleteInjectionTrace(sessionFile) === true && !existsSync(injectionTracePathFor(sessionFile)));
  check("无会话文件时跳过留痕且不抛错", recordInjectionTrace(null, entry) === null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── E. 口径命中率测量（acceptance 3） ────────────────────────────────────────

console.log("\n[E] 口径命中率测量（生成 SQL 表引用 vs 注入的 qualifiedName）");

interface InjectedTable {
  tableName?: string;
  schema?: string;
  qualifiedName?: string;
}

interface SampleDetail {
  file: string;
  ref: string;
  matched: string;
  kind: "hit" | "miss";
}

interface MeasureReport {
  sessionFiles: number;
  roundsInjected: number;
  roundsSkipped: number;
  samples: number;
  hits: number;
  misses: number;
  unrelated: number;
  rate: number;
  details: SampleDetail[];
}

/** 从用户消息（含 REF/CTX 前缀的 prompt 原文）提取本次注入的表事实 */
function extractInjectedTables(userContent: string): InjectedTable[] {
  const m = /^CTX:(.+)$/m.exec(userContent);
  if (!m) return [];
  try {
    const payload = JSON.parse(m[1]) as { tables?: InjectedTable[] };
    return Array.isArray(payload.tables) ? payload.tables : [];
  } catch {
    return [];
  }
}

/** 从 SQL 提取表引用（FROM/JOIN 后的限定名；先剥离字符串字面量） */
function extractTableRefs(sql: string): string[] {
  const stripped = sql.replace(/'(?:[^']|'')*'/g, "''");
  const refs: string[] = [];
  const ident = "(?:`[^`]+`|\"[^\"]+\"|[a-zA-Z_][a-zA-Z0-9_$]*)";
  const re = new RegExp(`\\b(?:from|join)\\s+(${ident}(?:\\s*\\.\\s*${ident})*)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    refs.push(m[1].replace(/\s+/g, "").replace(/[`"]/g, ""));
  }
  return refs;
}

/** 从工具调用块抽取 SQL（bash 的 --sql "..." 与工具参数 sql 字段） */
function extractSqlsFromToolCalls(message: unknown): string[] {
  const sqls: string[] = [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return sqls;
  for (const b of content) {
    const block = b as { type?: string; arguments?: unknown };
    if (block.type !== "toolCall") continue;
    const args = (block.arguments ?? {}) as Record<string, unknown>;
    if (typeof args.sql === "string") sqls.push(args.sql);
    if (typeof args.command === "string") {
      const m = /--sql\s+"((?:[^"\\]|\\.)*)"/.exec(args.command);
      if (m) sqls.push(m[1]);
    }
  }
  return sqls;
}

/** 口径分类：命中=表引用与注入 qualifiedName 逐字一致；miss=指向注入表却没用限定名 */
function classifyRef(ref: string, tables: InjectedTable[]): "hit" | "miss" | "unrelated" {
  const norm = ref.toLowerCase();
  if (tables.some((t) => t.qualifiedName && t.qualifiedName.toLowerCase() === norm)) return "hit";
  for (const t of tables) {
    const tail = (t.tableName ?? "").toLowerCase();
    const segs = norm.split(".");
    if (tail && segs[segs.length - 1] === tail) return "miss";
    if (t.schema && t.tableName && norm === `${t.schema}.${t.tableName}`.toLowerCase()) return "miss";
  }
  return "unrelated";
}

/** 抽样比对：扫描会话 jsonl，逐轮对比「生成 SQL 的表引用」与「注入的 qualifiedName」 */
function measureSessions(dir: string): MeasureReport {
  const report: MeasureReport = {
    sessionFiles: 0,
    roundsInjected: 0,
    roundsSkipped: 0,
    samples: 0,
    hits: 0,
    misses: 0,
    unrelated: 0,
    rate: 1,
    details: [],
  };
  if (!existsSync(dir)) return report;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.includes(".jsonl."));
  report.sessionFiles = files.length;
  for (const f of files) {
    const path = join(dir, f);
    let entries: unknown[];
    try {
      entries = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      continue;
    }
    let injected: InjectedTable[] = [];
    let roundHasCtx = false;
    let inRound = false;
    const flush = (): void => {
      if (!inRound) return;
      if (roundHasCtx) report.roundsInjected++;
      else report.roundsSkipped++;
    };
    for (const raw of entries) {
      const entry = raw as { type?: string; message?: unknown };
      if (entry.type !== "message") continue;
      const msg = entry.message as { role?: string; content?: unknown };
      if (msg.role === "user") {
        flush();
        inRound = true;
        const text = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
            : "";
        injected = extractInjectedTables(text);
        roundHasCtx = injected.length > 0;
      } else if (msg.role === "assistant" && roundHasCtx) {
        for (const sql of extractSqlsFromToolCalls(msg)) {
          for (const ref of extractTableRefs(sql)) {
            const kind = classifyRef(ref, injected);
            if (kind === "unrelated") {
              report.unrelated++;
              continue;
            }
            report.samples++;
            if (kind === "hit") report.hits++;
            else report.misses++;
            const matched = injected.find((t) => (t.tableName ?? "").toLowerCase() === ref.toLowerCase().split(".").pop()) ?? injected[0];
            report.details.push({ file: f, ref, matched: matched?.qualifiedName ?? "", kind });
          }
        }
      }
    }
    flush();
  }
  report.rate = report.samples > 0 ? report.hits / report.samples : 1;
  return report;
}

// ── E 断言：fixture 会话 jsonl 走真实解析路径 ────────────────────────────────

{
  const fxDir = mkdtempSync(join(tmpdir(), "govio-t21-fx-"));
  try {
    const ctxTables = [{ nodeId: "n-product", label: "dim_product", tableName: "dim_product", schema: "chocolate", qualifiedName: "chocolate.chocolate.dim_product", datasourceType: "duckdb" }];
    const userPrompt =
      'REF:[{"dim_product":"{}"}]\n' +
      `CTX:${JSON.stringify({ tables: ctxTables, graphEntities: [], graphStatus: "ok", instructions: CTX_INSTRUCTIONS })}\n` +
      "查一下产品";
    const toolCall = (id: string, command: string): unknown =>
      ({ type: "toolCall", id, name: "bash", arguments: { command } });
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: userPrompt } },
      {
        type: "message", id: "a1", parentId: null, timestamp: "", message: {
          role: "assistant", content: [
            { type: "text", text: "好" },
            // hit：三段式限定名与注入 qualifiedName 逐字一致
            toolCall("t1", 'govio-cli observe load --name df_a --datasource chocolate --sql "SELECT * FROM chocolate.chocolate.dim_product"'),
            // miss：指向注入表却用了裸表名（BUGFIX-load-parse 的试错形态）
            toolCall("t2", 'govio-cli observe load --name df_b --datasource chocolate --sql "SELECT product_id FROM dim_product"'),
            // unrelated：memory CTE 引用，非物理表，排除出分母
            toolCall("t3", 'govio-cli observe load --name df_c --memory --sql "SELECT * FROM df_tmp"'),
            // hit：工具参数 sql 字段也参与抽样
            { type: "toolCall", id: "t4", name: "govio_create_sql_query", arguments: { sql: "SELECT count(*) FROM chocolate.chocolate.dim_product" } },
          ],
        },
      },
      { type: "message", id: "u2", parentId: null, timestamp: "", message: { role: "user", content: "继续" } },
      {
        type: "message", id: "a2", parentId: null, timestamp: "", message: {
          role: "assistant", content: [toolCall("t5", 'govio-cli observe load --name df_d --datasource x --sql "SELECT * FROM whatever"')],
        },
      },
    ];
    writeFileSync(join(fxDir, "sess-fx.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    // sidecar 噪声文件：不应被当作会话扫描
    writeFileSync(join(fxDir, "sess-fx.jsonl.injection.jsonl"), JSON.stringify({ v: 1 }) + "\n");

    const report = measureSessions(fxDir);
    check("命中率抽样：限定名命中 / 裸表名 miss / CTE 引用排除",
      report.hits === 2 && report.misses === 1 && report.unrelated === 1,
      JSON.stringify(report));
    check("工具参数 sql 字段也参与抽样（bash --sql 之外的生成 SQL 来源）",
      report.details.filter((d) => d.kind === "hit" && d.ref.toLowerCase() === "chocolate.chocolate.dim_product").length === 2);
    check("命中率计算正确（2 hit / 3 sample = 2/3）", Math.abs(report.rate - 2 / 3) < 1e-9, `rate=${report.rate}`);
    check("无 CTX 的轮次跳过（不误报）", report.roundsInjected === 1 && report.roundsSkipped === 1);
    check("sidecar 文件不被当作会话扫描", report.sessionFiles === 1);
  } finally {
    rmSync(fxDir, { recursive: true, force: true });
  }
}

{
  const report = measureSessions(join(tmpdir(), "govio-t21-no-such-dir"));
  check("目录不存在时测量优雅返回空报告", report.sessionFiles === 0 && report.samples === 0 && report.rate === 1);
}

// 真实会话抽样（信息性输出，不参与判定——verify 环境可能没有会话）
{
  const realDir = join(process.cwd(), ".govio", "sessions");
  if (existsSync(realDir)) {
    const report = measureSessions(realDir);
    console.log(`  ℹ 真实会话抽样：${report.sessionFiles} 个会话 / 注入轮 ${report.roundsInjected} / 样本 ${report.samples} / 命中率 ${(report.rate * 100).toFixed(1)}%`);
    for (const d of report.details.slice(0, 10)) {
      console.log(`    - [${d.kind}] ${d.ref} → ${d.matched} (${d.file})`);
    }
  } else {
    console.log("  ℹ 真实会话抽样：无 .govio/sessions 目录，跳过（fixture 断言已覆盖测量逻辑）");
  }
}

// ── F. transcript 上屏剥离（注入留痕不上屏） ─────────────────────────────────

console.log("\n[F] 会话 transcript：CTX 注入行剥离（留痕保留在 jsonl 原文）");

{
  const entry = (id: string, message: unknown): SessionEntry =>
    ({ type: "message", id, parentId: null, timestamp: "", message }) as unknown as SessionEntry;
  const ctxLine = `CTX:${JSON.stringify({ tables: [factProduct], graphEntities: [{ entityType: "Metric", id: "ME1" }], graphStatus: "ok" })}`;
  const page = buildTranscript([
    entry("u1", { role: "user", content: `REF:[{"dim_product":"{}"}]\n${ctxLine}\n真实问题` }),
    entry("u2", { role: "user", content: `${ctxLine}\n无引用问题` }),
  ]);
  check("CTX 行剥离后上屏内容只剩用户问题（REF+CTX）", page.messages[0].content === "真实问题");
  check("CTX-only 注入同样剥离（无 REF）", page.messages[1].content === "无引用问题" && page.messages[1].referencedNodes === undefined);
  check("REF 标签在剥离 CTX 后仍可解析", page.messages[0].referencedNodes?.length === 1 && page.messages[0].referencedNodes[0].label === "dim_product");
}

// ── G. 空结果处理（Data not found. 是合法空行，不是失败） ────────────────────

console.log("\n[G] 空结果处理（BUGFIX-injection-graph-key：Data not found. 不降级）");

{
  check("parseQueryRows：Data not found. → 空数组（旧假设空结果打印 [] 有误）",
    parseQueryRows("Data not found.\n").length === 0);
  check("parseQueryRows：正常状态行 + 结果行解析",
    JSON.stringify(parseQueryRows('Result output: .govio\\output.json rows: 1 columns: ["a"]\n[{"a":1}]')) === '[{"a":1}]');
  check("parseQueryRows：无结果行且非空结果仍抛错（不可解析不静默）", (() => {
    try { parseQueryRows("weird output"); return false; } catch { return true; }
  })());
  check("isEmptyResultOutput 识别空结果输出",
    isEmptyResultOutput("Data not found.") && isEmptyResultOutput("data not found.") && !isEmptyResultOutput('[{"a":1}]'));
  // 诊断信息：仅 "Command failed" 无法定位是超时/非 0 退出/被杀
  const killed = Object.assign(new Error("Command failed: govio-cli query -c X"), {
    killed: true, signal: "SIGTERM" as const,
  });
  const desc = describeExecError(killed, "", "");
  check("describeExecError 保留超时/信号与退出码（不再只有 Command failed）",
    desc.includes("killed=true") && desc.includes("signal=SIGTERM"));
  const exitErr = Object.assign(new Error("Command failed: govio-cli query -c Y"), { code: 1 });
  check("describeExecError 带退出码与 stderr 尾部",
    describeExecError(exitErr, "Runtime exception: boom", "").includes("exit=1") &&
    describeExecError(exitErr, "Runtime exception: boom", "").includes("stderr=Runtime exception: boom"));
}

{
  // 多查询集体失败：留痕需保留全部失败项（旧实现只留最后一条）
  const multiFail: GraphQueryRunner = async (cypher) => {
    throw new Error(cypher.includes("DIMENSION_USED") ? "dim-fail" : "metrics-fail");
  };
  const ctx = await buildInjectionContext({ content: "q", runQuery: multiFail });
  check("多查询失败时 graphError 记录全部失败项",
    ctx.graphStatus === "degraded" &&
    (ctx.graphError ?? "").includes("metrics:") &&
    (ctx.graphError ?? "").includes("metricDims:") &&
    (ctx.graphError ?? "").includes(";;"));
}

// ── H. 图谱查询缓存与预热（避免并发冷启动撞超时） ─────────────────

console.log("\n[H] 图谱查询缓存（同一 Cypher 不重复 spawn CLI）");

{
  const { clearGraphQueryCache } = await import("../server/graph-query.js");
  clearGraphQueryCache();
  let calls = 0;
  const countingRunner: GraphQueryRunner = async () => {
    calls++;
    return FX_METRICS;
  };
  // 直接验证 buildInjectionContext 的 fake runner 不受缓存影响（缓存只包 runGraphQuery）
  await buildInjectionContext({ content: "销售额", runQuery: countingRunner });
  const first = calls;
  await buildInjectionContext({ content: "销售额", runQuery: countingRunner });
  check("注入层不对 runner 做隐式缓存（每轮都查，缓存属 graph-query 职责）", calls === first * 2);
  check("clearGraphQueryCache 可导出（测试/元数据导入后主动失效）", typeof clearGraphQueryCache === "function");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\nverify-prompt-injection: ${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  console.error(`失败断言 ${failures.length} 项: ${failures.join(" | ")}`);
  process.exit(1);
}
