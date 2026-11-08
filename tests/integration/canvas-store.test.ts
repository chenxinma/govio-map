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
import type { CanvasEvent } from "../../src/services/canvas-service.js";

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
