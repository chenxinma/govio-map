/**
 * X4 链路③集成测试：canvas-store —— createGovioNode 节点创建 / 自动边生成 / positionNewNode 布局。
 *
 * 驱动方式：直接操作 `useCanvasStore.getState()`（与既有 verify-manifest-roundtrip.ts 同款）。
 * persist 中间件的 localStorage 在 node 环境不可用 → 测试前注入 stub storage（zustand
 * createJSONStorage 兜底行为：取不到 storage 时 persist 停用，store 仍可正常读写）。
 *
 * 覆盖：
 *  - 各 nodeType 建节点字段完整性（sqlQuery / dataFrame / sourceTable / report / chart）
 *  - referencedNodes（prompt 引用）→ 自动边；sourceRefs（label 匹配 title/tableName/dfName）→ 自动边
 *  - positionNewNode 布局：空画布 (100,100)；同类型节点纵向排列；连接节点在源右侧
 *  - dataFrame 去重：同 dfName 不重复建节点（Manifest 缺失时回填）
 *  - 表间语义血缘边（X10）：星型模型 3 条 fact→dim 边、双向匹配两种上画布顺序、
 *    同一对节点去重、与数据血缘边并存、限定名变体匹配、关系缺失/目标不在画布/自环不建边
 *  - 失败/边界：未知 nodeType 静默忽略；引用不存在的节点不建边
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// canvas-store persist 默认读 window.localStorage；node 环境注入内存 stub 即可
vi.stubGlobal("localStorage", {
  store: new Map<string, string>(),
  getItem(k: string) { return this.store.get(k) ?? null; },
  setItem(k: string, v: string) { this.store.set(k, v); },
  removeItem(k: string) { this.store.delete(k); },
});

import { useCanvasStore } from "../../src/store/canvas-store.js";
import { lineageEdgeAppearance, SEMANTIC_SOURCE_HANDLE, SEMANTIC_TARGET_HANDLE } from "../../src/utils/lineage.js";
import type { CanvasEvent } from "../../src/services/canvas-service.js";
import type { Edge } from "@xyflow/react";

const baseEvent = (over: Partial<CanvasEvent> & { nodeType: CanvasEvent["nodeType"] }): CanvasEvent => ({
  type: "govio_node_create",
  title: "T",
  ...over,
});

describe("canvas-store：createGovioNode 节点创建 / 自动边 / 布局", () => {
  beforeEach(() => {
    useCanvasStore.getState().clearCanvas();
  });

  it("sqlQuery 节点：字段完整，manifest 写入 node.data", () => {
    const manifest = {
      schemaVersion: 1,
      origin: "assistant-sql" as const,
      sql: "SELECT 1",
      datasource: "",
      executedAt: "2026-11-05T00:00:00.000Z",
    };
    useCanvasStore.getState().createGovioNode(baseEvent({
      nodeType: "sqlQuery",
      title: "Q: orders",
      sql: "SELECT 1",
      outputColumns: ["id"],
      manifest: manifest as never,
    }));
    const { nodes } = useCanvasStore.getState();
    expect(nodes).toHaveLength(1);
    const data = nodes[0].data as Record<string, unknown>;
    expect(data.type).toBe("sqlQuery");
    expect(data.sql).toBe("SELECT 1");
    expect(data.manifest).toEqual(manifest);
  });

  it("dataFrame 节点：列结构与规模字段写入", () => {
    useCanvasStore.getState().createGovioNode(baseEvent({
      nodeType: "dataFrame",
      title: "DF: df_a",
      dfName: "df_a",
      sourceName: "sales",
      totalRows: 100,
      totalColumns: 2,
      memoryUsage: "1.6 KB",
      columns: [{ name: "id", dtype: "int64", nonNull: 100 }],
    }));
    const data = useCanvasStore.getState().nodes[0].data as Record<string, unknown>;
    expect(data.dfName).toBe("df_a");
    expect(data.totalRows).toBe(100);
    expect((data.columns as unknown[]).length).toBe(1);
  });

  it("sourceTable / report / chart 节点：核心字段写入", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({
      nodeType: "sourceTable", title: "orders", tableName: "orders", database: "sales",
      fields: [{ name: "id", type: "BIGINT", nullable: false }],
    }));
    st.createGovioNode(baseEvent({
      nodeType: "report", title: "Diff", reportType: "diff", content: "比对结果",
    }));
    st.createGovioNode(baseEvent({
      nodeType: "chart", title: "Chart", sourceDf: "df_a",
      config: { type: "bar", data: [{ type: "bar", x: [1], y: [2] }] },
    }));
    const nodes = useCanvasStore.getState().nodes;
    expect(nodes.map((n) => n.type)).toEqual(["sourceTable", "report", "chart"]);
    expect((nodes[2].data as Record<string, unknown>).sourceDf).toBe("df_a");
  });

  it("自动边：referencedNodes（按 nodeId 匹配）生成边", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "sourceTable", title: "orders", tableName: "orders" }));
    const srcId = useCanvasStore.getState().nodes[0].id;
    st.createGovioNode(baseEvent({
      nodeType: "sqlQuery", title: "Q: orders", sql: "SELECT * FROM orders",
      referencedNodes: [{ nodeId: srcId, label: "orders", type: "sourceTable" }],
    }));
    const { nodes, edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(srcId);
    expect(edges[0].target).toBe(nodes[1].id);
  });

  it("自动边：sourceRefs（label 匹配 dfName）生成边；label 无匹配节点不建边", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "dataFrame", title: "DF: df_up", dfName: "df_up" }));
    const srcId = useCanvasStore.getState().nodes[0].id;
    st.createGovioNode(baseEvent({
      nodeType: "dataFrame", title: "DF: df_down", dfName: "df_down",
      sourceRefs: [{ label: "df_up" }, { label: "not_on_canvas" }],
    }));
    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(srcId);
  });

  it("边界：引用不存在的 nodeId 不建边", () => {
    useCanvasStore.getState().createGovioNode(baseEvent({
      nodeType: "sqlQuery", title: "Q: x", sql: "SELECT 1",
      referencedNodes: [{ nodeId: "ghost-999", label: "ghost", type: "sqlQuery" }],
    }));
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it("边界：未知 nodeType 静默忽略，不产生节点", () => {
    useCanvasStore.getState().createGovioNode({ type: "govio_node_create", nodeType: "bogus" } as never);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("positionNewNode 布局：空画布 (100,100)；同类型节点不重叠且向下排列", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "report", title: "R1", reportType: "diff", content: "" }));
    st.createGovioNode(baseEvent({ nodeType: "report", title: "R2", reportType: "diff", content: "" }));
    const [n1, n2] = useCanvasStore.getState().nodes;
    expect(n1.position).toEqual({ x: 100, y: 100 });
    // 第二个同类型节点排在第一个下方（y 更大），不与第一个重叠
    expect(n2.position.y).toBeGreaterThan(n1.position.y);
    expect(n2.position.x).toBe(n1.position.x);
  });

  it("positionNewNode 布局：有入边的节点放在源节点右侧", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "sourceTable", title: "orders", tableName: "orders" }));
    const src = useCanvasStore.getState().nodes[0];
    st.createGovioNode(baseEvent({
      nodeType: "sqlQuery", title: "Q: orders", sql: "SELECT 1",
      referencedNodes: [{ nodeId: src.id, label: "orders", type: "sourceTable" }],
    }));
    const target = useCanvasStore.getState().nodes[1];
    expect(target.position.x).toBeGreaterThan(src.position.x);
  });

  it("dataFrame 去重：同 dfName 不重复建节点；已有节点缺 Manifest 时回填", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "dataFrame", title: "DF: df_dup", dfName: "df_dup", totalRows: 1 }));
    const manifest = {
      schemaVersion: 1,
      origin: "observe-load" as const,
      sql: "SELECT 1",
      datasource: "s",
      dfName: "df_dup",
    };
    st.createGovioNode(baseEvent({
      nodeType: "dataFrame", title: "DF: df_dup", dfName: "df_dup", totalRows: 1,
      manifest: manifest as never,
    }));
    const { nodes } = useCanvasStore.getState();
    expect(nodes).toHaveLength(1);
    // 第二次调用回填了 Manifest（去重不丢留痕）
    expect((nodes[0].data as Record<string, unknown>).manifest).toEqual(manifest);
  });

  it("布局边界：混类型节点画布不重叠（位置互异）", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({ nodeType: "sourceTable", title: "t1", tableName: "t1" }));
    st.createGovioNode(baseEvent({ nodeType: "report", title: "r1", reportType: "diff", content: "" }));
    st.createGovioNode(baseEvent({ nodeType: "chart", title: "c1", config: { data: [] } }));
    const nodes = useCanvasStore.getState().nodes;
    const positions = nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(nodes.length);
  });
});

// ── X10：表间语义血缘边（sourceTable ↔ sourceTable）──────────────────────────
//
// 星型模型（chocolate fact_sales → dim_product / dim_country / dim_channel）为基准：
// 关系挂在 fact 节点的 tableRelations 上，dim 节点自身无出向关系；两种上画布顺序
// （先 fact 后 dim / 先 dim 后 fact）都必须连出 3 条紫虚线语义边。

const STAR_QUALIFIED = {
  fact: "chocolate.chocolate.fact_sales",
  product: "chocolate.chocolate.dim_product",
  country: "chocolate.chocolate.dim_country",
  channel: "chocolate.chocolate.dim_channel",
};

/** fact_sales 的 3 条图谱关系（RELATES_TO 原值形态：三段式目标 + many_to_one） */
const FACT_RELATIONS = [
  { targetTable: STAR_QUALIFIED.product, relationshipType: "many_to_one", description: "事实表产品外键", sourceColumns: ["product_id"], targetColumns: ["product_id"] },
  { targetTable: STAR_QUALIFIED.country, relationshipType: "many_to_one", sourceColumns: ["country_id"], targetColumns: ["country_id"] },
  { targetTable: STAR_QUALIFIED.channel, relationshipType: "many_to_one", sourceColumns: ["channel_id"], targetColumns: ["channel_id"] },
];

type DimName = "dim_product" | "dim_country" | "dim_channel";

const dimEvent = (name: DimName, qualified?: string): CanvasEvent =>
  baseEvent({
    nodeType: "sourceTable",
    title: name,
    tableName: name,
    database: "chocolate",
    fields: [{ name: `${name}_id`, type: "BIGINT", nullable: false }],
    ...(qualified ? { schema: "chocolate", qualifiedName: qualified } : {}),
  });

const factEvent = (extra: Partial<CanvasEvent> = {}): CanvasEvent =>
  baseEvent({
    nodeType: "sourceTable",
    title: "fact_sales",
    tableName: "fact_sales",
    database: "chocolate",
    schema: "chocolate",
    qualifiedName: STAR_QUALIFIED.fact,
    fields: [{ name: "order_id", type: "BIGINT", nullable: false }],
    tableRelations: FACT_RELATIONS,
    tableRelationsSource: "graph",
    ...extra,
  });

describe("canvas-store：表间语义血缘边（X10）", () => {
  beforeEach(() => {
    useCanvasStore.getState().clearCanvas();
  });

  /** 语义边外观断言：样式唯一来源是 src/utils/lineage.ts，store 不得硬编码色值/线型 */
  const expectSemanticAppearance = (edge: {
    type?: string; animated?: boolean; style?: unknown; data?: unknown;
    sourceHandle?: string | null; targetHandle?: string | null;
  }) => {
    const ap = lineageEdgeAppearance("semantic");
    expect(edge.type).toBe(ap.edgeType);
    expect(edge.animated).toBe(ap.animated);
    expect(edge.style).toEqual({ stroke: ap.stroke, strokeWidth: ap.strokeWidth, strokeDasharray: ap.strokeDasharray });
    expect((edge.data as Record<string, unknown>).lineageKind).toBe("semantic");
    // 语义边走上/下专用 Handle（数据边不带 handle 键）
    expect(edge.sourceHandle).toBe(SEMANTIC_SOURCE_HANDLE);
    expect(edge.targetHandle).toBe(SEMANTIC_TARGET_HANDLE);
  };

  it("星型模型（先 fact 后 dim）：3 条 fact→dim 语义边，id 带 -sem 后缀", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(factEvent());
    const factId = useCanvasStore.getState().nodes[0].id;
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    st.createGovioNode(dimEvent("dim_country", STAR_QUALIFIED.country));
    st.createGovioNode(dimEvent("dim_channel", STAR_QUALIFIED.channel));

    const { nodes, edges } = useCanvasStore.getState();
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expectSemanticAppearance(e);
      expect(e.source).toBe(factId);
      expect(e.target).not.toBe(factId);
      expect(e.id).toBe(`e-${e.source}-${e.target}-sem`);
    }
    // 三个 dim 各一条（无重复、无遗漏）
    expect(new Set(edges.map((e) => e.target)).size).toBe(3);
  });

  it("星型模型（先 dim 后 fact）：双向匹配另一侧同样连出 3 条 fact→dim 边", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    st.createGovioNode(dimEvent("dim_country", STAR_QUALIFIED.country));
    st.createGovioNode(dimEvent("dim_channel", STAR_QUALIFIED.channel));
    // dim 之间无关系 → 此时不建边
    expect(useCanvasStore.getState().edges).toHaveLength(0);
    st.createGovioNode(factEvent());
    const factId = useCanvasStore.getState().nodes[3].id;

    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.source === factId)).toBe(true);
    expect(new Set(edges.map((e) => e.target)).size).toBe(3);
    edges.forEach(expectSemanticAppearance);
  });

  it("去重：两表互相声明关系（a→b 与 b→a）时同一对节点只保留一条语义边", () => {
    const st = useCanvasStore.getState();
    // 先落 dim_product，且它反向声明指向 fact_sales
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    const dimId = useCanvasStore.getState().nodes[0].id;
    st.updateNodeData(dimId, {
      tableRelations: [{ targetTable: STAR_QUALIFIED.fact, relationshipType: "one_to_many" }],
    } as never);
    // 再落 fact_sales（关系指向 dim_product）：①新→既有与②既有→新同时命中同一对节点
    st.createGovioNode(factEvent());
    const factId = useCanvasStore.getState().nodes[1].id;

    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    // ① 优先于 ②：方向为 fact → dim（关系语义 more-accurate 的一侧先产出）
    expect(edges[0].source).toBe(factId);
    expect(edges[0].target).toBe(dimId);
  });

  it("并存：同一对 sourceTable 已有数据血缘边时，语义边共存且 id 不冲突", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    const dimId = useCanvasStore.getState().nodes[0].id;
    // 新 fact 节点经 referencedNodes 建数据血缘边（dim → fact），同时关系指向 dim（fact → dim）
    st.createGovioNode(factEvent({ referencedNodes: [{ nodeId: dimId, label: "dim_product" }] }));
    const factId = useCanvasStore.getState().nodes[1].id;

    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(2);
    const data = edges.find((e) => (e.data as Record<string, unknown>).lineageKind === "data");
    const sem = edges.find((e) => (e.data as Record<string, unknown>).lineageKind === "semantic");
    expect(data?.id).toBe(`e-${dimId}-${factId}`);
    expect(data?.sourceHandle).toBeUndefined();
    expect(data?.targetHandle).toBeUndefined();
    expect(data?.type).toBe(lineageEdgeAppearance("data").edgeType);
    expect(sem?.id).toBe(`e-${factId}-${dimId}-sem`);
    expect(new Set(edges.map((e) => e.id)).size).toBe(2);
  });

  it("变体匹配：新节点只有裸 tableName（无 qualifiedName）也能对上三段式关系目标", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(factEvent());
    const factId = useCanvasStore.getState().nodes[0].id;
    st.createGovioNode(dimEvent("dim_product"));
    const { edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(factId);
  });

  it("边界：tableRelations 缺失 → 不建边且不写 node.data 键（旧节点形状不变）", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(factEvent({ tableRelations: undefined, tableRelationsSource: undefined }));
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    const { nodes, edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(0);
    for (const n of nodes) {
      expect(Object.keys(n.data as Record<string, unknown>)).not.toContain("tableRelations");
      expect(Object.keys(n.data as Record<string, unknown>)).not.toContain("tableRelationsSource");
    }
  });

  it("边界：关系目标不在画布上 → 不建边、不报错、关系原样留在节点上", () => {
    useCanvasStore.getState().createGovioNode(factEvent());
    const { nodes, edges } = useCanvasStore.getState();
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
    expect((nodes[0].data as Record<string, unknown>).tableRelations).toHaveLength(3);
  });

  it("边界：自环关系与形状非法的关系元素被忽略", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(factEvent({
      tableRelations: [
        { targetTable: STAR_QUALIFIED.fact, relationshipType: "many_to_one" }, // 自环
        { targetTable: "", relationshipType: "many_to_one" },                  // 空目标
        { relationshipType: "many_to_one" },                                   // 缺 targetTable
        null,                                                                  // 非法元素
        "bogus",                                                               // 非法元素
      ] as never,
    }));
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });

  it("边界：hydrateSession 恢复的边不被重复追加，新表照常补边", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(factEvent());
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    const before = useCanvasStore.getState().edges;
    expect(before).toHaveLength(1);
    // 模拟 canvas_restore：原样恢复节点与边后再落地 dim_country（既有 fact 关系指向它）
    const { nodes, edges } = useCanvasStore.getState();
    st.hydrateSession(nodes, edges);
    st.createGovioNode(dimEvent("dim_country", STAR_QUALIFIED.country));
    const after = useCanvasStore.getState().edges;
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
  });

  it("升级：hydrateSession 把旧持久化语义边补上上下 Handle/straight（数据边不动、幂等）", () => {
    const legacySem: Edge = {
      id: "e-old-sem", source: "a", target: "b", type: "smoothstep", animated: false, style: {},
      data: { lineageKind: "semantic" },
    };
    const dataEdge: Edge = {
      id: "e-d", source: "a", target: "c", type: "smoothstep", animated: true, style: {},
      data: { lineageKind: "data" },
    };
    useCanvasStore.getState().hydrateSession([], [legacySem, dataEdge]);
    const sem = useCanvasStore.getState().edges.find((e) => e.id === "e-old-sem")!;
    expect(sem.sourceHandle).toBe(SEMANTIC_SOURCE_HANDLE);
    expect(sem.targetHandle).toBe(SEMANTIC_TARGET_HANDLE);
    expect(sem.type).toBe(lineageEdgeAppearance("semantic").edgeType);
    const data = useCanvasStore.getState().edges.find((e) => e.id === "e-d");
    expect(data?.sourceHandle).toBeUndefined();
    expect(data?.type).toBe(lineageEdgeAppearance("data").edgeType);
    // 幂等：再次恢复已升级的边返回同一引用
    useCanvasStore.getState().hydrateSession([], useCanvasStore.getState().edges);
    expect(useCanvasStore.getState().edges.find((e) => e.id === "e-old-sem")).toBe(sem);
  });

  it("降级路径：字段级 foreign_key 关系同样建边，tableRelationsError 透传留痕", () => {
    const st = useCanvasStore.getState();
    st.createGovioNode(baseEvent({
      nodeType: "sourceTable",
      title: "fact_sales",
      tableName: "fact_sales",
      qualifiedName: STAR_QUALIFIED.fact,
      fields: [{ name: "product_id", type: "BIGINT", nullable: false, isForeignKey: true, references: { table: "dim_product", field: "product_id" } }],
      tableRelations: [{ targetTable: "dim_product", relationshipType: "foreign_key", sourceColumns: ["product_id"], targetColumns: ["product_id"] }],
      tableRelationsSource: "fields",
      tableRelationsError: "spawn govio-cli ENOENT",
    } as Partial<CanvasEvent> as CanvasEvent));
    st.createGovioNode(dimEvent("dim_product", STAR_QUALIFIED.product));
    const { nodes, edges } = useCanvasStore.getState();
    expect(edges).toHaveLength(1); // 裸表名 references 也能对上三段式节点
    const fact = nodes[0].data as Record<string, unknown>;
    expect(fact.tableRelationsSource).toBe("fields");
    expect(fact.tableRelationsError).toBe("spawn govio-cli ENOENT");
  });
});
