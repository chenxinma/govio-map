/**
 * X13 集成测试：表间关系的**展示模型**与**边侧出口**。
 *
 * 覆盖：
 *  - `tableRelationsHint`（caliberNodeAppearance 同构）：正常态不打扰、字段级降级与图谱
 *    失败才亮灯、原因过长截断 + 全文、空白原因的边界
 *  - 展示小函数：目标表裸名、列映射（单侧缺失只渲染存在的一侧）、边 label 摘要
 *    （X15：label 只有列映射，不再带关系类型；类型原值仍留在数据里）
 *  - `tableSemanticEdgeCandidates` 的**加法扩展**：候选携带关系原文、同节点对多关系合并、
 *    既有语义边覆盖时不产出、① 优先于 ② 的去重语义不变
 *  - `canvas-store` 建边：`edge.data.tableRelations` + `label` 挂上，且 lineageKind /
 *    样式 / Handle / type 全部仍由 lineageEdge 工厂派生（X10 断言零回归）
 *  - sqlQuery 口径沿袭语义边不带关系（形状不变）
 *  - 旧边（只有 lineageKind）向后兼容 + canvas sidecar 往返无损、hydrateSession 不重复建边
 *
 * 不调 govio-cli、不调模型、不碰网络。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// canvas-store 的 persist 中间件默认读 window.localStorage；node 环境注入内存 stub
vi.stubGlobal("localStorage", {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null; },
  setItem(k: string, v: string) { this.store.set(k, v); },
  removeItem(k: string) { this.store.delete(k); },
});

import { useCanvasStore } from "../../src/store/canvas-store.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../../server/session-history.js";
import {
  lineageEdgeAppearance,
  lineageKindOf,
  SEMANTIC_SOURCE_HANDLE,
  SEMANTIC_TARGET_HANDLE,
} from "../../src/utils/lineage.js";
import { nodeTableRelations, tableSemanticEdgeCandidates } from "../../src/utils/table-relations.js";
import {
  MAX_HINT_REASON_LENGTH,
  TABLE_RELATIONS_HINT_COLOR,
  relationColumnView,
  relationEdgeLabel,
  relationRowTitle,
  relationTargetLabel,
  tableRelationsHint,
} from "../../src/utils/table-relations-ui.js";
import type { TableRelation } from "../../src/types/index.js";
import type { CanvasEvent } from "../../src/services/canvas-service.js";
import type { Edge, Node } from "@xyflow/react";

const FACT = "chocolate.chocolate.fact_sales";
const DIM_PRODUCT = "chocolate.chocolate.dim_product";
const DIM_COUNTRY = "chocolate.chocolate.dim_country";
const DIM_CHANNEL = "chocolate.chocolate.dim_channel";

/** live 图谱实测形状（X10）：三段式目标 + many_to_one + 单列映射，无 description */
const STAR_RELATIONS: TableRelation[] = [
  { targetTable: DIM_PRODUCT, relationshipType: "many_to_one", sourceColumns: ["product_id"], targetColumns: ["product_id"] },
  { targetTable: DIM_COUNTRY, relationshipType: "many_to_one", sourceColumns: ["country_id"], targetColumns: ["country_id"] },
  { targetTable: DIM_CHANNEL, relationshipType: "many_to_one", sourceColumns: ["channel_id"], targetColumns: ["channel_id"] },
];

// ── 1. tableRelationsHint：降级留痕判定（不打扰取舍）──────────────────────

describe("tableRelationsHint：降级留痕的唯一判定", () => {
  it("图谱正常态（source=graph）不提示，且各文案字段为 null", () => {
    const hint = tableRelationsHint({
      tableRelationsSource: "graph",
      tableRelations: STAR_RELATIONS,
    });
    expect(hint.showHint).toBe(false);
    expect(hint.badgeLabel).toBeNull();
    expect(hint.detail).toBeNull();
    expect(hint.detailFull).toBeNull();
  });

  it("无关系、无留痕（旧节点 / 图谱空结果且无 FK）同样不提示", () => {
    expect(tableRelationsHint({}).showHint).toBe(false);
    expect(tableRelationsHint({ tableRelations: [] }).showHint).toBe(false);
  });

  it("字段级降级（无 error，图谱空结果）提示「字段级」与图谱未记录", () => {
    const hint = tableRelationsHint({
      tableRelationsSource: "fields",
      tableRelations: [{ targetTable: "dim_product", relationshipType: "foreign_key" }],
    });
    expect(hint.showHint).toBe(true);
    expect(hint.badgeLabel).toBe("字段级关系");
    expect(hint.detailFull).toContain("字段级外键");
    expect(hint.detailFull).toContain("图谱未记录该表关系");
  });

  it("字段级降级 + 图谱失败原因：原因全文进 detailFull", () => {
    const hint = tableRelationsHint({
      tableRelationsSource: "fields",
      tableRelationsError: "spawn govio-cli ENOENT",
      tableRelations: [{ targetTable: "dim_product", relationshipType: "foreign_key" }],
    });
    expect(hint.badgeLabel).toBe("字段级关系");
    expect(hint.detailFull).toContain("spawn govio-cli ENOENT");
    expect(hint.detail).not.toContain("undefined");
  });

  it("只有 tableRelationsError（图谱挂了且没拿到任何关系）提示图谱降级并说明无关系", () => {
    const hint = tableRelationsHint({
      tableRelationsError: "graph query timeout after 8000ms",
      tableRelations: [],
    });
    expect(hint.showHint).toBe(true);
    expect(hint.badgeLabel).toBe("图谱降级");
    expect(hint.detailFull).toContain("graph query timeout after 8000ms");
    expect(hint.detailFull).toContain("本表无表间关系");
  });

  it("边界：空白 / 空串 error 不算降级（不误报）", () => {
    expect(tableRelationsHint({ tableRelationsError: "   " }).showHint).toBe(false);
    expect(tableRelationsHint({ tableRelationsError: "" }).showHint).toBe(false);
    expect(tableRelationsHint({ tableRelationsError: undefined, tableRelationsSource: undefined }).showHint).toBe(false);
  });

  it("矛盾数据（source=graph 但带 error）仍按图谱降级提示", () => {
    const hint = tableRelationsHint({
      tableRelationsSource: "graph",
      tableRelationsError: "Binder exception: property not found",
      tableRelations: STAR_RELATIONS,
    });
    expect(hint.showHint).toBe(true);
    expect(hint.badgeLabel).toBe("图谱降级");
    expect(hint.detailFull).toContain("Binder exception");
  });

  it("超长原因在画布截断、title 保留全文", () => {
    const long = `Error: ${"x".repeat(200)}`;
    const hint = tableRelationsHint({ tableRelationsError: long, tableRelations: [] });
    expect(hint.detail!.length).toBeLessThanOrEqual(MAX_HINT_REASON_LENGTH);
    expect(hint.detail!.endsWith("…")).toBe(true);
    expect(hint.detailFull).toContain(long);
  });

  it("警示色唯一来源 = green-deck warning token", () => {
    const hint = tableRelationsHint({ tableRelationsSource: "fields" });
    expect(hint.hintColor).toBe(TABLE_RELATIONS_HINT_COLOR);
    expect(TABLE_RELATIONS_HINT_COLOR).toBe("#F59B23");
  });
});

// ── 2. 展示小函数：裸表名 / 列映射 / 边摘要 ──────────────────────────────

describe("关系展示小函数", () => {
  it("目标表显示名取裸表名，全限定名交给 title", () => {
    expect(relationTargetLabel(DIM_PRODUCT)).toBe("dim_product");
    expect(relationTargetLabel("dim_product")).toBe("dim_product");
    expect(relationTargetLabel("")).toBe("");
  });

  it("列映射：两侧都有用箭头连接；任一侧缺失只渲染存在的一侧", () => {
    expect(relationColumnView(STAR_RELATIONS[0]).text).toBe("product_id → product_id");
    expect(relationColumnView({ targetTable: "d", relationshipType: "r", sourceColumns: ["a"] }).text).toBe("a");
    expect(relationColumnView({ targetTable: "d", relationshipType: "r", targetColumns: ["b"] }).text).toBe("b");
  });

  it("列映射边界：两侧都缺 / 空数组 / 非字符串元素 → text 为空（调用方省略该行）", () => {
    expect(relationColumnView({ targetTable: "d", relationshipType: "r" }).text).toBe("");
    expect(relationColumnView({ targetTable: "d", relationshipType: "r", sourceColumns: [], targetColumns: [] }).text).toBe("");
    expect(relationColumnView({ targetTable: "d", relationshipType: "r", sourceColumns: ["  "] }).text).toBe("");
  });

  it("行 hover 全文（X15.1）：目标表全限定名 + 字段关联 + 说明；缺项自动省略，类型不进 hover", () => {
    expect(relationRowTitle(STAR_RELATIONS[0])).toBe(
      "关系目标表：chocolate.chocolate.dim_product\n字段关联：product_id → product_id",
    );
    expect(relationRowTitle({ ...STAR_RELATIONS[0], description: "事实表产品外键" })).toBe(
      "关系目标表：chocolate.chocolate.dim_product\n字段关联：product_id → product_id\n说明：事实表产品外键",
    );
    // 只有类型、没有列信息：hover 只有目标表行（不出现空的「字段关联：」，也不出现类型原值）
    const typeOnly = relationRowTitle({ targetTable: "sales.region", relationshipType: "one_to_many" });
    expect(typeOnly).toBe("关系目标表：sales.region");
    expect(typeOnly).not.toContain("one_to_many");
    // 单侧列缺失只带存在的一侧；空白 description 不算有说明
    expect(relationRowTitle({ targetTable: "d", relationshipType: "r", sourceColumns: ["a"] }))
      .toBe("关系目标表：d\n字段关联：a");
    expect(relationRowTitle({ ...STAR_RELATIONS[0], description: "   " })).not.toContain("说明：");
  });

  it("边 label 摘要 = 列映射（X15：不含关系类型）；多条关系末尾附 +N；空输入/全缺列为空串", () => {
    expect(relationEdgeLabel([STAR_RELATIONS[0]])).toBe("product_id → product_id");
    expect(relationEdgeLabel(STAR_RELATIONS)).toBe("product_id → product_id +2");
    expect(relationEdgeLabel([])).toBe("");
    expect(relationEdgeLabel(undefined)).toBe("");
    expect(relationEdgeLabel([{ targetTable: "d", relationshipType: "" }])).toBe("");
    // 关系类型不再出现在 label 里（数据层仍有该值，只是不展示）
    expect(relationEdgeLabel(STAR_RELATIONS)).not.toContain("many_to_one");
    // 首条缺列、次条有列 → 取有列的那条做摘要（不让 label 白白变空），+N 仍按总条数
    expect(
      relationEdgeLabel([
        { targetTable: "a", relationshipType: "many_to_one" },
        { targetTable: "b", relationshipType: "many_to_one", sourceColumns: ["x"], targetColumns: ["y"] },
      ]),
    ).toBe("x → y +1");
  });
});

// ── 3. 候选携带关系原文（table-relations 的加法扩展）────────────────────

const factNode = (id: string, relations: TableRelation[]) => ({
  id,
  data: { type: "sourceTable", tableName: "fact_sales", qualifiedName: FACT, tableRelations: relations },
});
const dimNode = (id: string, name: string, qualified: string, relations?: TableRelation[]) => ({
  id,
  data: {
    type: "sourceTable",
    tableName: name,
    schema: "chocolate",
    qualifiedName: qualified,
    ...(relations ? { tableRelations: relations } : {}),
  },
});

describe("tableSemanticEdgeCandidates：候选携带关系", () => {
  it("星型模型：三条候选各带一条关系原文（列映射可取）", () => {
    const dims = [dimNode("d1", "dim_product", DIM_PRODUCT), dimNode("d2", "dim_country", DIM_COUNTRY)];
    const candidates = tableSemanticEdgeCandidates(dims, factNode("f", STAR_RELATIONS));
    expect(candidates).toHaveLength(2);
    expect(candidates[0].relations).toEqual([STAR_RELATIONS[0]]);
    expect(candidates[1].relations).toEqual([STAR_RELATIONS[1]]);
    expect(candidates.every((c) => c.sourceId === "f")).toBe(true);
  });

  it("同一对节点被多条关系命中 → 仍一条候选，relations 合并（复合外键场景）", () => {
    const rels: TableRelation[] = [
      { targetTable: DIM_PRODUCT, relationshipType: "many_to_one", sourceColumns: ["product_id"], targetColumns: ["product_id"] },
      { targetTable: "chocolate.dim_product", relationshipType: "many_to_one", sourceColumns: ["sku"], targetColumns: ["sku"] },
    ];
    const candidates = tableSemanticEdgeCandidates([dimNode("d1", "dim_product", DIM_PRODUCT)], {
      id: "f",
      data: { type: "sourceTable", tableName: "fact_sales", qualifiedName: FACT, tableRelations: rels },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].relations).toHaveLength(2);
    expect(relationEdgeLabel(candidates[0].relations)).toBe("product_id → product_id +1");
  });

  it("既有语义边覆盖的节点对不再产出候选（恢复后不重复建边）", () => {
    const existing = { id: "old", source: "f0", target: "d1", data: { lineageKind: "semantic" } };
    const candidates = tableSemanticEdgeCandidates(
      [dimNode("d1", "dim_product", DIM_PRODUCT)],
      factNode("f0", STAR_RELATIONS),
      [existing],
    );
    expect(candidates).toEqual([]);
  });

  it("② 既有节点的关系指向新节点：关系挂在既有节点侧也带出", () => {
    const candidates = tableSemanticEdgeCandidates(
      [dimNode("d1", "dim_product", DIM_PRODUCT, [
        { targetTable: FACT, relationshipType: "one_to_many", sourceColumns: ["product_id"], targetColumns: ["product_id"] },
      ])],
      { id: "f", data: { type: "sourceTable", tableName: "fact_sales", qualifiedName: FACT } },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("d1");
    expect(candidates[0].relations?.[0].relationshipType).toBe("one_to_many");
  });

  it("互相声明关系（① 优先于 ②）：一条候选且只保留 ① 方向的关系", () => {
    const candidates = tableSemanticEdgeCandidates(
      [dimNode("d1", "dim_product", DIM_PRODUCT, [{ targetTable: FACT, relationshipType: "one_to_many" }])],
      factNode("f", [STAR_RELATIONS[0]]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("f");
    expect(candidates[0].relations).toEqual([STAR_RELATIONS[0]]);
  });

  it("边界：关系目标不在画布 / 关系数据非法 → 不产出候选，不报错", () => {
    expect(tableSemanticEdgeCandidates([], factNode("f", STAR_RELATIONS))).toEqual([]);
    const dirty = tableSemanticEdgeCandidates(
      [dimNode("d1", "dim_product", DIM_PRODUCT)],
      { id: "f", data: { type: "sourceTable", tableName: "fact_sales", tableRelations: [null, { targetTable: "" }, 42] } },
    );
    expect(dirty).toEqual([]);
  });

  it("nodeTableRelations 只保留合法关系（脏元素过滤，不猜测补全）", () => {
    const cleaned = nodeTableRelations({
      id: "n",
      data: { tableRelations: [STAR_RELATIONS[0], null, "bogus", { relationshipType: "x" }] },
    });
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0].targetTable).toBe(DIM_PRODUCT);
  });
});

// ── 4. canvas-store：关系上边（edge.data + label）与零回归 ────────────────

const baseEvent = (over: Partial<CanvasEvent> & { nodeType: CanvasEvent["nodeType"] }): CanvasEvent => ({
  type: "govio_node_create",
  title: "T",
  ...over,
});

const tableEvent = (name: string, qualified: string, extra: Partial<CanvasEvent> = {}): CanvasEvent =>
  baseEvent({
    nodeType: "sourceTable",
    title: name,
    tableName: name,
    database: "chocolate",
    schema: "chocolate",
    qualifiedName: qualified,
    fields: [{ name: `${name.slice(4)}_id`, type: "BIGINT", nullable: false }],
    ...extra,
  });

function pushStarModel(): { nodes: Node[]; edges: Edge[] } {
  const store = useCanvasStore.getState();
  store.createGovioNode(tableEvent("fact_sales", FACT, {
    tableRelations: STAR_RELATIONS,
    tableRelationsSource: "graph",
  }));
  store.createGovioNode(tableEvent("dim_product", DIM_PRODUCT));
  store.createGovioNode(tableEvent("dim_country", DIM_COUNTRY));
  store.createGovioNode(tableEvent("dim_channel", DIM_CHANNEL));
  const state = useCanvasStore.getState();
  return { nodes: state.nodes, edges: state.edges };
}

describe("canvas-store：表间关系上边（X13）", () => {
  beforeEach(() => {
    useCanvasStore.getState().clearCanvas();
  });

  it("语义边携带关系原文与 label，且样式/Handle/lineageKind 仍由工厂派生", () => {
    const { nodes, edges } = pushStarModel();
    expect(edges).toHaveLength(3);
    const ap = lineageEdgeAppearance("semantic");
    for (const e of edges) {
      const data = e.data as Record<string, unknown>;
      expect(data.lineageKind).toBe("semantic");
      const rels = data.tableRelations as TableRelation[];
      expect(rels).toHaveLength(1);
      // X15：label 只有列映射（关系类型不再展示），但类型原值仍随 edge.data 持久化
      expect(e.label).toBe(`${rels[0].sourceColumns![0]} → ${rels[0].targetColumns![0]}`);
      expect(e.label).not.toContain("many_to_one");
      expect(rels[0].relationshipType).toBe("many_to_one");
      // 零回归：形状/样式/Handle 全部来自 lineageEdge 工厂
      expect(e.type).toBe(ap.edgeType);
      expect(e.animated).toBe(ap.animated);
      expect(e.style).toEqual({ stroke: ap.stroke, strokeWidth: ap.strokeWidth, strokeDasharray: ap.strokeDasharray });
      expect(e.sourceHandle).toBe(SEMANTIC_SOURCE_HANDLE);
      expect(e.targetHandle).toBe(SEMANTIC_TARGET_HANDLE);
    }
    const factId = nodes[0].id;
    expect(edges.every((e) => e.source === factId)).toBe(true);
  });

  it("边上关系的列映射可与节点数据对上（星型 3 条：product/country/channel）", () => {
    const { edges } = pushStarModel();
    const pairs = edges
      .map((e) => relationEdgeLabel((e.data as Record<string, unknown>).tableRelations as TableRelation[]))
      .sort();
    expect(pairs).toEqual([
      "channel_id → channel_id",
      "country_id → country_id",
      "product_id → product_id",
    ]);
  });

  it("sqlQuery 口径沿袭语义边不带关系（形状不变，无 label）", () => {
    const ref = [{ entityType: "Metric" as const, id: "m1", code: "gmv", name: "销售额" }];
    useCanvasStore.getState().createGovioNode(baseEvent({ nodeType: "sqlQuery", title: "Q: A", sql: "SELECT 1", outputColumns: ["1"], semanticRefs: ref }));
    useCanvasStore.getState().createGovioNode(baseEvent({ nodeType: "sqlQuery", title: "Q: B", sql: "SELECT 2", outputColumns: ["2"], semanticRefs: ref }));
    const sem = useCanvasStore.getState().edges.find((e) => lineageKindOf(e) === "semantic");
    expect(sem).toBeDefined();
    expect((sem!.data as Record<string, unknown>).tableRelations).toBeUndefined();
    expect(sem!.label).toBeUndefined();
  });

  it("② 方向建边同样带关系；关系无列映射时不写 label 键（X15：类型不再充当 label 兜底）", () => {
    const store = useCanvasStore.getState();
    store.createGovioNode(tableEvent("dim_product", DIM_PRODUCT));
    // 模拟历史节点：关系后来才出现在既有节点的 node.data 上
    useCanvasStore.getState().updateNodeData(useCanvasStore.getState().nodes[0].id, {
      tableRelations: [{ targetTable: DIM_COUNTRY, relationshipType: "one_to_many" }],
    } as never);
    store.createGovioNode(tableEvent("dim_country", DIM_COUNTRY));
    const edges = useCanvasStore.getState().edges;
    expect(edges).toHaveLength(1);
    expect((edges[0].data as Record<string, unknown>).tableRelations).toHaveLength(1);
    // 没有列映射就没有可展示的字段关联 → label 键省略（不出现空 label，也不出现 undefined 字样）
    expect(edges[0].label).toBeUndefined();
    expect("label" in edges[0]).toBe(false);
    // 数据留痕不变：类型原值仍在 edge.data.tableRelations 里（只是不展示）
    expect(
      ((edges[0].data as Record<string, unknown>).tableRelations as TableRelation[])[0].relationshipType,
    ).toBe("one_to_many");
  });

  it("旧边（只有 lineageKind，无 tableRelations）恢复后不报错、不显示 label", () => {
    const legacyNode: Node[] = [
      { id: "t1", type: "sourceTable", position: { x: 0, y: 0 }, data: { type: "sourceTable", title: "fact_sales", tableName: "fact_sales", database: "chocolate", fields: [], createdAt: "2026-11-01T00:00:00Z" } },
      { id: "t2", type: "sourceTable", position: { x: 300, y: 0 }, data: { type: "sourceTable", title: "dim_product", tableName: "dim_product", database: "chocolate", fields: [], createdAt: "2026-11-01T00:00:00Z" } },
    ];
    const legacyEdges: Edge[] = [{ id: "e-legacy-sem", source: "t1", target: "t2", data: { lineageKind: "semantic" } }];
    useCanvasStore.getState().hydrateSession(legacyNode, legacyEdges);
    const restored = useCanvasStore.getState().edges;
    expect(restored).toHaveLength(1);
    expect(lineageKindOf(restored[0])).toBe("semantic");
    expect(restored[0].label).toBeUndefined();
    expect((restored[0].data as Record<string, unknown>).tableRelations).toBeUndefined();
    // 旧边升级 Handle 后仍不丢 lineageKind（withSemanticHandles 零回归）
    expect(restored[0].sourceHandle).toBe(SEMANTIC_SOURCE_HANDLE);
  });

  it("canvas sidecar 往返：edge.data.tableRelations 与 label 无损，hydrate 不重复建边", () => {
    const { nodes, edges } = pushStarModel();
    const dir = mkdtempSync(join(tmpdir(), "govio-x13-relations-ui-"));
    try {
      const sessionFile = join(dir, "2026-11-12T00-00-00-000Z_sess-x13.jsonl");
      saveCanvas(sessionFile, nodes, edges);
      expect(canvasPathFor(sessionFile).endsWith(".canvas.json")).toBe(true);
      const loaded = loadCanvas(sessionFile);
      expect(loaded).not.toBeNull();
      expect(loaded!.edges).toEqual(edges as unknown as unknown[]);
      const labelOf = (id: string) => (loaded!.edges.find((e) => e.id === id) as Edge).label;
      expect(typeof labelOf(edges[0].id!)).toBe("string");
      useCanvasStore.getState().hydrateSession(loaded!.nodes as Node[], loaded!.edges as Edge[]);
      const restored = useCanvasStore.getState().edges;
      expect(restored).toHaveLength(3);
      // 恢复后关系详情与 label 仍在（hydrate 只做 Handle 升级，不吞新键）
      expect(restored.every((e) => lineageKindOf(e) === "semantic")).toBe(true);
      expect(restored.every((e) => typeof e.label === "string" && e.label !== "")).toBe(true);
      expect(
        restored.every((e) => Array.isArray((e.data as Record<string, unknown>).tableRelations)),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 5. 降级留痕在 node.data 上的透传（store 不吞键）─────────────────────

describe("canvas-store：降级留痕透传", () => {
  beforeEach(() => {
    useCanvasStore.getState().clearCanvas();
  });

  it("字段级降级：tableRelationsSource=fields + error 都落 node.data", () => {
    useCanvasStore.getState().createGovioNode(tableEvent("fact_sales", FACT, {
      tableRelations: [{ targetTable: DIM_PRODUCT, relationshipType: "foreign_key", sourceColumns: ["product_id"], targetColumns: ["product_id"] }],
      tableRelationsSource: "fields",
      tableRelationsError: "spawn govio-cli ENOENT",
    }));
    const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
    const hint = tableRelationsHint({
      tableRelationsSource: data.tableRelationsSource as "graph" | "fields",
      tableRelationsError: data.tableRelationsError as string,
      tableRelations: data.tableRelations as TableRelation[],
    });
    expect(hint.showHint).toBe(true);
    expect(hint.badgeLabel).toBe("字段级关系");
    expect(hint.detailFull).toContain("spawn govio-cli ENOENT");
  });

  it("图谱正常态：node.data 上判定结果静默（不打扰）", () => {
    pushStarModel();
    const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
    const hint = tableRelationsHint({
      tableRelationsSource: data.tableRelationsSource as "graph" | "fields",
      tableRelationsError: data.tableRelationsError as string | undefined,
      tableRelations: data.tableRelations as TableRelation[],
    });
    expect(hint.showHint).toBe(false);
    expect(data.tableRelations).toHaveLength(3);
  });
});