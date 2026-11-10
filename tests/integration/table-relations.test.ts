/**
 * X10 集成测试：表间语义关系（sourceTable ↔ sourceTable 语义血缘边）服务端链路。
 *
 * 驱动方式：
 *  - `server/table-relations.ts` 的纯函数直接调用；图谱查询以 fake runner 注入（不调真实
 *    govio-cli，与 verify-prompt-injection.ts 同款做法）；
 *  - `govio_create_source_table` 工具用 stub pi 捕获（与 govio-canvas-extension.test.ts 同款），
 *    图谱经 `deps.runGraphQuery` 注入 fake；
 *  - 持久化往返用真实 `server/session-history.ts` + tmp 会话文件；
 *  - 导出 HTML 直接调 `buildDeliveryReportHtml()`。
 *
 * 覆盖：
 *  - 列形状容错（图谱返回字符串 / 导入源文件是数组 / JSON 数组字符串 / 逗号分隔）
 *  - Cypher 构造（表键双形 IN 列表、属性名严格取 schema.md、LIMIT）
 *  - 图谱行解析（自环丢弃、重复行去重、缺目标丢弃）与字段级降级路径
 *  - resolveTableRelations 降级矩阵：图谱 ok / 空结果 / reject / 超时 / 无表键 → 状态与留痕
 *  - 工具链路：事件带 tableRelations；图谱降级时不阻断节点创建且 tableRelationsError 留痕
 *  - 星型模型全链路：4 节点 3 条语义边 → canvas sidecar 往返无损、hydrate 不重复建边
 *  - 导出 HTML：表间语义边按紫虚线渲染 + 图例含「语义血缘」
 *  - 失败/边界：每条链路至少 1 个（永不 resolve 的 runner、非法字段元素、空画布导出）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// govio-canvas 内部经动态 import 使用 agent.runGovioCli（readObserveInfo 回退路径）；
// 本测试不涉及 observe，mock 掉避免误调真实 CLI。
vi.mock("../../server/agent.js", () => ({
  runGovioCli: vi.fn(async () => {
    throw new Error("govio-cli not available in tests (mock)");
  }),
}));

// canvas-store 的 persist 中间件默认读 window.localStorage；node 环境注入内存 stub
vi.stubGlobal("localStorage", {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null; },
  setItem(k: string, v: string) { this.store.set(k, v); },
  removeItem(k: string) { this.store.delete(k); },
});

import {
  FIELD_RELATIONSHIP_TYPE,
  buildRelatesToCypher,
  parseColumnList,
  relationsFromFields,
  relationsFromGraphRows,
  resolveTableRelations,
} from "../../server/table-relations.js";
import type { GraphRow } from "../../server/graph-query.js";
import govioCanvasExtension from "../../server/extensions/govio-canvas.js";
import { flushGovioNodes, type GovioNodeCreateEvent } from "../../server/govio-node-queue.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../../server/session-history.js";
import { useCanvasStore } from "../../src/store/canvas-store.js";
import { lineageEdgeAppearance } from "../../src/utils/lineage.js";
import { buildDeliveryReportHtml, layoutLineage } from "../../src/utils/export-report.js";
import type { CanvasEvent } from "../../src/services/canvas-service.js";
import type { TableRelation } from "../../src/types/index.js";
import type { Edge, Node } from "@xyflow/react";

// ── 星型模型夹具（取值与 live 图谱实测一致：chocolate fact_sales → dim_*）─────

const FACT = "chocolate.chocolate.fact_sales";
const DIM_PRODUCT = "chocolate.chocolate.dim_product";
const DIM_COUNTRY = "chocolate.chocolate.dim_country";
const DIM_CHANNEL = "chocolate.chocolate.dim_channel";

/** 图谱实测行形态：source_columns / target_columns 是**字符串**（导入源文件里才是数组） */
const STAR_ROWS: GraphRow[] = [
  { src: FACT, relationship_type: "many_to_one", description: "事实表产品外键：每条销售订单归属一个产品", source_columns: "product_id", target: DIM_PRODUCT, target_columns: "product_id" },
  { src: FACT, relationship_type: "many_to_one", description: "事实表国家外键", source_columns: "country_id", target: DIM_COUNTRY, target_columns: "country_id" },
  { src: FACT, relationship_type: "many_to_one", source_columns: "channel_id", target: DIM_CHANNEL, target_columns: "channel_id" },
];

const FK_FIELDS = [
  { name: "order_id", type: "BIGINT", nullable: false, isPrimaryKey: true },
  { name: "product_id", type: "BIGINT", nullable: false, isForeignKey: true, references: { table: "dim_product", field: "product_id" } },
  { name: "country_id", type: "BIGINT", nullable: false, isForeignKey: true, references: { table: "dim_country", field: "country_id" } },
];

/** fake 图谱 runner：记录收到的 Cypher（供断言表键构造），返回固定行 */
function okRunner(rows: GraphRow[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (cypher: string): Promise<GraphRow[]> => {
    calls.push(cypher);
    return rows;
  });
  return Object.assign(fn, { calls });
}

/** fake 图谱 runner：直接 reject（模拟 CLI 不可达 / Binder 错误） */
function failRunner(message: string) {
  return vi.fn((): Promise<GraphRow[]> => Promise.reject(new Error(message)));
}

// ── 1. 列形状容错 ───────────────────────────────────────────────────────────

describe("table-relations：parseColumnList 列形状容错", () => {
  it("图谱实测形态：字符串 → 单元素数组", () => {
    expect(parseColumnList("channel_id")).toEqual(["channel_id"]);
  });

  it("导入源文件形态：数组原样保留（含数字元素字符串化）", () => {
    expect(parseColumnList(["product_id", "channel_id"])).toEqual(["product_id", "channel_id"]);
    expect(parseColumnList([1, 2])).toEqual(["1", "2"]);
  });

  it("容错：JSON 数组字符串与逗号分隔串都能解析", () => {
    expect(parseColumnList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseColumnList("a, b")).toEqual(["a", "b"]);
  });

  it("边界：null / 空串 / 空数组 / 非字符串非数组 → undefined（调用方省略键）", () => {
    expect(parseColumnList(null)).toBeUndefined();
    expect(parseColumnList(undefined)).toBeUndefined();
    expect(parseColumnList("")).toBeUndefined();
    expect(parseColumnList("   ")).toBeUndefined();
    expect(parseColumnList([])).toBeUndefined();
    expect(parseColumnList(42)).toBeUndefined();
    expect(parseColumnList({ a: 1 })).toBeUndefined();
  });
});

// ── 2. Cypher 构造与图谱行解析 ───────────────────────────────────────────────

describe("table-relations：Cypher 构造与图谱行解析", () => {
  it("Cypher：表键双形 IN 列表 + 属性名严格取 schema.md", () => {
    const cypher = buildRelatesToCypher(FACT);
    expect(cypher).toContain('a.full_table_name IN ["chocolate.chocolate.fact_sales", "chocolate.fact_sales"]');
    expect(cypher).toContain("MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable)");
    for (const prop of ["r.relationship_type", "r.description", "r.source_columns", "r.target_columns"]) {
      expect(cypher).toContain(prop);
    }
    expect(cypher).toContain("LIMIT");
  });

  it("Cypher 边界：表名含双引号/反斜杠时被转义（不破坏字面量）", () => {
    const cypher = buildRelatesToCypher('a."b\\c');
    expect(cypher).toContain('\\"');
    expect(cypher).toContain("\\\\");
  });

  it("图谱行 → TableRelation：3 行星型关系字段逐一映射", () => {
    const relations = relationsFromGraphRows(STAR_ROWS, FACT);
    expect(relations).toHaveLength(3);
    expect(relations[0]).toEqual({
      targetTable: DIM_PRODUCT,
      relationshipType: "many_to_one",
      description: "事实表产品外键：每条销售订单归属一个产品",
      sourceColumns: ["product_id"],
      targetColumns: ["product_id"],
    });
    // description 缺失时省略键（不写 undefined）
    expect(Object.keys(relations[2])).not.toContain("description");
    expect(relations.map((r) => r.targetTable)).toEqual([DIM_PRODUCT, DIM_COUNTRY, DIM_CHANNEL]);
  });

  it("图谱行：自环丢弃、重复行去重、缺目标名丢弃", () => {
    const rows: GraphRow[] = [
      ...STAR_ROWS,
      { src: FACT, relationship_type: "many_to_one", target: STAR_ROWS[0].target, source_columns: "product_id", target_columns: "product_id" }, // 完全重复
      { src: FACT, relationship_type: "self_loop", target: FACT },                                    // 自环
      { src: FACT, relationship_type: "many_to_one", target: "chocolate.fact_sales" },                // 自环（两段式变体）
      { src: FACT, relationship_type: "many_to_one" },                                                // 缺 target
      { src: FACT, relationship_type: "many_to_one", target: "   " },                                 // 空白 target
    ];
    const relations = relationsFromGraphRows(rows, FACT);
    expect(relations).toHaveLength(3);
    expect(relations.every((r) => r.targetTable !== FACT)).toBe(true);
  });

  it("边界：非数组 / 空数组 / 非对象元素 → 空结果不抛错", () => {
    expect(relationsFromGraphRows([], FACT)).toEqual([]);
    expect(relationsFromGraphRows(undefined as never, FACT)).toEqual([]);
    expect(relationsFromGraphRows([null, "bogus", 42] as never, FACT)).toEqual([]);
    // 没有 selfKey 时不做自环判定（调用方缺表键的场景），但空目标仍丢弃
    expect(relationsFromGraphRows([{ target: DIM_PRODUCT, relationship_type: "many_to_one" }])).toHaveLength(1);
  });
});

// ── 3. 字段级降级路径 ────────────────────────────────────────────────────────

describe("table-relations：字段级 references 降级路径", () => {
  it("FK 字段 → foreign_key 关系（裸表名 + 源/目标列）", () => {
    const relations = relationsFromFields(FK_FIELDS);
    expect(relations).toEqual([
      { targetTable: "dim_product", relationshipType: FIELD_RELATIONSHIP_TYPE, sourceColumns: ["product_id"], targetColumns: ["product_id"] },
      { targetTable: "dim_country", relationshipType: FIELD_RELATIONSHIP_TYPE, sourceColumns: ["country_id"], targetColumns: ["country_id"] },
    ]);
  });

  it("同一目标表的多列外键合并为一条关系（列累积、不重复）", () => {
    const relations = relationsFromFields([
      { name: "product_id", type: "BIGINT", nullable: false, references: { table: "dim_product", field: "product_id" } },
      { name: "product_code", type: "VARCHAR", nullable: true, references: { table: "dim_product", field: "code" } },
      { name: "product_id", type: "BIGINT", nullable: false, references: { table: "dim_product", field: "product_id" } },
    ]);
    expect(relations).toHaveLength(1);
    expect(relations[0].sourceColumns).toEqual(["product_id", "product_code"]);
    expect(relations[0].targetColumns).toEqual(["product_id", "code"]);
  });

  it("边界：isForeignKey:false / 无 references / 非法元素 / 非数组 → 不产出关系", () => {
    expect(relationsFromFields([
      { name: "a", type: "BIGINT", nullable: false, isForeignKey: false, references: { table: "t", field: "id" } },
      { name: "b", type: "BIGINT", nullable: false },
      null as never,
      { references: { table: "  ", field: "id" } } as never,
    ])).toEqual([]);
    expect(relationsFromFields([])).toEqual([]);
    expect(relationsFromFields(undefined)).toEqual([]);
    expect(relationsFromFields("bogus" as never)).toEqual([]);
  });
});

// ── 4. resolveTableRelations 降级矩阵 ────────────────────────────────────────

describe("table-relations：resolveTableRelations 取数分层与降级留痕", () => {
  it("主路径：图谱命中 → source=graph、status=ok、无 error 键", async () => {
    const runQuery = okRunner(STAR_ROWS);
    const res = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT, schema: "chocolate", runQuery });
    expect(res.status).toBe("ok");
    expect(res.source).toBe("graph");
    expect(Object.keys(res)).not.toContain("error");
    expect(res.relations).toHaveLength(3);
    // 查询用的是 qualifiedName 派生的表键（三段式优先），且只查一次
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.calls[0]).toBe(buildRelatesToCypher(FACT));
  });

  it("降级：图谱 reject → status=degraded + error 留痕，回退字段级 references", async () => {
    const runQuery = failRunner("Command failed: govio-cli query | exit=1 | stderr=Binder exception");
    const res = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT, fields: FK_FIELDS, runQuery });
    expect(res.status).toBe("degraded");
    expect(res.error).toContain("Binder exception");
    expect(res.source).toBe("fields");
    expect(res.relations).toHaveLength(2);
    expect(res.relations[0].relationshipType).toBe(FIELD_RELATIONSHIP_TYPE);
  });

  it("降级：图谱空结果算 ok（非失败），仍回退字段级来源", async () => {
    const res = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT, fields: FK_FIELDS, runQuery: okRunner([]) });
    expect(res.status).toBe("ok");
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("fields");
    expect(res.relations).toHaveLength(2);
  });

  it("边界：图谱与字段级都拿不到 → 空关系且不写 source 键（调用方不建键、不建边）", async () => {
    const res = await resolveTableRelations({ tableName: "dim_channel", qualifiedName: DIM_CHANNEL, runQuery: okRunner([]) });
    expect(res.relations).toEqual([]);
    expect(Object.keys(res)).not.toContain("source");
    expect(res.status).toBe("ok");
  });

  it("边界：图谱 reject 且无 FK 字段 → 空关系 + degraded 留痕，绝不 throw", async () => {
    const runQuery = failRunner("spawn govio-cli ENOENT");
    const res = await resolveTableRelations({ tableName: "dim_channel", qualifiedName: DIM_CHANNEL, runQuery });
    expect(res.relations).toEqual([]);
    expect(res.status).toBe("degraded");
    expect(res.error).toContain("ENOENT");
    expect(Object.keys(res)).not.toContain("source");
  });

  it("边界：表键构造不出（tableName/qualifiedName 均缺）→ degraded 留痕，仍走字段级", async () => {
    const runQuery = okRunner(STAR_ROWS);
    const res = await resolveTableRelations({ fields: FK_FIELDS, runQuery });
    expect(res.status).toBe("degraded");
    expect(res.error).toContain("表键");
    expect(runQuery).not.toHaveBeenCalled(); // 无键不查图谱（禁止猜测表名）
    expect(res.source).toBe("fields");
    expect(res.relations).toHaveLength(2);
  });

  it("边界：图谱查询永不返回 → 本地超时闸降级，不挂死调用方", async () => {
    const runQuery = vi.fn((): Promise<GraphRow[]> => new Promise<GraphRow[]>(() => {}));
    const started = Date.now();
    const res = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT, fields: FK_FIELDS, runQuery, timeoutMs: 30 });
    expect(res.status).toBe("degraded");
    expect(res.error).toContain("超时");
    expect(res.source).toBe("fields");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("表键回退：无 qualifiedName 时用 schema.tableName 构造（不重复拼已带点号的表名）", async () => {
    const runQuery = okRunner(STAR_ROWS);
    await resolveTableRelations({ tableName: "fact_sales", schema: "chocolate", runQuery });
    expect(runQuery.calls[0]).toBe(buildRelatesToCypher("chocolate.fact_sales"));
  });
});

// ── 5. 工具链路：govio_create_source_table → GovioNodeCreateEvent ────────────

interface StubTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: never) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function makePiStub(deps: { runGraphQuery?: (cypher: string) => Promise<GraphRow[]> } = {}) {
  const tools = new Map<string, StubTool>();
  const piStub = {
    registerTool: (tool: StubTool) => { tools.set(tool.name, tool); },
    on: () => () => {},
  };
  govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0], deps);
  return tools;
}

const sourceTableParams = (over: Record<string, unknown> = {}) => ({
  tableName: "fact_sales",
  database: "chocolate",
  datasource: "chocolate",
  datasourceType: "duckdb",
  schema: "chocolate",
  qualifiedName: FACT,
  fields: [
    { name: "order_id", type: "BIGINT" },
    { name: "product_id", type: "BIGINT", references: { table: "dim_product", field: "product_id" } },
  ],
  ...over,
});

describe("govio_create_source_table：表间关系附加与降级不阻断", () => {
  beforeEach(() => {
    flushGovioNodes();
  });

  it("图谱命中 → 事件带 tableRelations + source=graph，工具回执报告关系条数", async () => {
    const tools = makePiStub({ runGraphQuery: okRunner(STAR_ROWS) });
    const res = await tools.get("govio_create_source_table")!.execute("call-1", sourceTableParams() as never);
    const events = flushGovioNodes();
    expect(events).toHaveLength(1);
    const ev = events[0] as GovioNodeCreateEvent;
    expect(ev.nodeType).toBe("sourceTable");
    expect(ev.tableRelations).toHaveLength(3);
    expect(ev.tableRelationsSource).toBe("graph");
    expect(ev.tableRelationsError).toBeUndefined();
    expect(ev.tableRelations?.[0].targetTable).toBe(DIM_PRODUCT);
    expect(res.content[0].text).toContain("relations: 3 (graph)");
  });

  it("图谱降级 → 回退字段级关系，事件带 tableRelationsError 留痕且节点照常创建", async () => {
    const tools = makePiStub({ runGraphQuery: failRunner("spawn govio-cli ENOENT") });
    const res = await tools.get("govio_create_source_table")!.execute("call-2", sourceTableParams() as never);
    const events = flushGovioNodes();
    expect(events).toHaveLength(1); // 不阻断节点创建
    const ev = events[0];
    expect(ev.tableRelationsSource).toBe("fields");
    expect(ev.tableRelations).toHaveLength(1);
    expect(ev.tableRelations?.[0]).toEqual({
      targetTable: "dim_product",
      relationshipType: FIELD_RELATIONSHIP_TYPE,
      sourceColumns: ["product_id"],
      targetColumns: ["product_id"],
    });
    expect(ev.tableRelationsError).toContain("ENOENT");
    expect(res.content[0].text).toContain("Created source table node: fact_sales");
  });

  it("边界：图谱与字段级都无关系 → 三个键一律不写（旧节点形状不变）", async () => {
    const tools = makePiStub({ runGraphQuery: okRunner([]) });
    const res = await tools.get("govio_create_source_table")!.execute(
      "call-3",
      sourceTableParams({ fields: [{ name: "id", type: "BIGINT" }] }) as never,
    );
    const ev = flushGovioNodes()[0];
    expect(Object.keys(ev)).not.toContain("tableRelations");
    expect(Object.keys(ev)).not.toContain("tableRelationsSource");
    expect(Object.keys(ev)).not.toContain("tableRelationsError");
    expect(res.content[0].text).toContain("relations: none");
  });
});

// ── 6. 星型模型全链路：事件 → 画布边 → sidecar 往返 → 导出 HTML ──────────────

const tmpDirs: string[] = [];
function tmpSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "govio-x10-relations-"));
  tmpDirs.push(dir);
  return join(dir, "2026-11-10T00-00-00-000Z_sess-x10.jsonl");
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 用真实事件形状把星型模型 4 张表推上画布（先 fact 后 dim） */
function pushStarModel(): { nodes: Node[]; edges: Edge[] } {
  const store = useCanvasStore.getState();
  const event = (over: Partial<CanvasEvent>): CanvasEvent => ({ type: "govio_node_create", title: "T", ...over } as CanvasEvent);
  store.createGovioNode(event({
    nodeType: "sourceTable", title: "fact_sales", tableName: "fact_sales", database: "chocolate",
    schema: "chocolate", qualifiedName: FACT, datasource: "chocolate", datasourceType: "duckdb",
    fields: [{ name: "order_id", type: "BIGINT", nullable: false }],
    tableRelations: STAR_ROWS.map((r) => ({
      targetTable: String(r.target),
      relationshipType: String(r.relationship_type),
      ...(r.description ? { description: String(r.description) } : {}),
      sourceColumns: [String(r.source_columns)],
      targetColumns: [String(r.target_columns)],
    })) as TableRelation[],
    tableRelationsSource: "graph",
  }));
  for (const [name, qualified] of [["dim_product", DIM_PRODUCT], ["dim_country", DIM_COUNTRY], ["dim_channel", DIM_CHANNEL]] as const) {
    store.createGovioNode(event({
      nodeType: "sourceTable", title: name, tableName: name, database: "chocolate",
      schema: "chocolate", qualifiedName: qualified, datasource: "chocolate", datasourceType: "duckdb",
      fields: [{ name: `${name.slice(4)}_id`, type: "BIGINT", nullable: false }],
    }));
  }
  const state = useCanvasStore.getState();
  return { nodes: state.nodes, edges: state.edges };
}

describe("X10 全链路：星型模型 3 条语义边 + 持久化 + 导出", () => {
  beforeEach(() => {
    useCanvasStore.getState().clearCanvas();
  });

  it("4 个 sourceTable 节点 → 3 条 fact→dim 语义边（方向与分类正确）", () => {
    const { nodes, edges } = pushStarModel();
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => (e.data as Record<string, unknown>).lineageKind === "semantic")).toBe(true);
    const factId = nodes[0].id;
    expect(edges.every((e) => e.source === factId)).toBe(true);
    expect(new Set(edges.map((e) => e.target)).size).toBe(3);
  });

  it("canvas sidecar 往返：tableRelations 与语义边无损，hydrate 后不重复建边", () => {
    const { nodes, edges } = pushStarModel();
    const sessionFile = tmpSession();
    saveCanvas(sessionFile, nodes, edges);
    const loaded = loadCanvas(sessionFile);
    expect(loaded).not.toBeNull();

    // 边与节点数据深度相等（含 tableRelations / tableRelationsSource）
    expect(loaded!.edges).toEqual(edges as unknown as unknown[]);
    const factData = (loaded!.nodes[0] as { data: Record<string, unknown> }).data;
    expect(factData.tableRelations).toEqual((nodes[0].data as Record<string, unknown>).tableRelations);
    expect(factData.tableRelationsSource).toBe("graph");

    // hydrateSession（canvas_restore）后边数不变；再落地一张已存在的 dim 也不产生重复语义边
    useCanvasStore.getState().hydrateSession(loaded!.nodes as Node[], loaded!.edges as Edge[]);
    expect(useCanvasStore.getState().edges).toHaveLength(3);
    expect(canvasPathFor(sessionFile).endsWith(".canvas.json")).toBe(true);
  });

  it("导出交付报告：表间语义边进入血缘图（紫虚线 + 专属 marker）与图例", () => {
    const { nodes, edges } = pushStarModel();
    const layout = layoutLineage(nodes, edges);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.every((e) => e.lineageKind === "semantic")).toBe(true);

    const html = buildDeliveryReportHtml({ nodes, edges, exportedAt: "2026-11-10T12:00:00+08:00", audit: null });
    const sem = lineageEdgeAppearance("semantic");
    expect(html).toContain(`stroke="${sem.stroke}"`);
    expect(html).toContain(`stroke-dasharray="${sem.strokeDasharray}"`);
    expect(html).toContain('marker-end="url(#govio-arrow-sem)"');
    expect(html).toContain("语义血缘");
    // 关系留痕（图谱描述）随节点快照进入附录/卡片，且不引入脚本
    expect(html).not.toContain("<script");
  });

  it("边界：空画布导出不因表间边逻辑报错", () => {
    const html = buildDeliveryReportHtml({ nodes: [], edges: [], exportedAt: "2026-11-10T12:00:00+08:00", audit: null });
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });
});
