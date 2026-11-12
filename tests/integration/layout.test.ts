/**
 * 方案B全局排版（src/utils/layout.ts getLayoutedElements + alignSemanticPeers）：
 *  - dagre 只按数据血缘边做 LR 分层（数据定列序）
 *  - 语义血缘边不参与分层，语义同伴同列纵向堆叠（源在上、目标在下）
 *  - 数据边优先：接入数据边的节点冻结，纯语义节点迁就
 *
 * node 环境无 DOM → measureNodeSize 返回 null，尺寸走 getNodeSize 估算兜底
 * （真实测量路径由 tests/ui 的组件渲染覆盖不到这里，浏览器端人工验证）。
 */
import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { getLayoutedElements } from "../../src/utils/layout.js";
import { lineageEdge } from "../../src/utils/lineage.js";

const mkNode = (id: string, type: string): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data: { type } }) as Node;

// getNodeSize 估算值（node 环境走兜底）
const SQL = { w: 300, h: 280 };
const GAP_Y = 40;

const posOf = (out: Node[], id: string) => out.find((n) => n.id === id)!.position;

describe("layout：方案B（数据边 LR 分层 + 语义边同列堆叠）", () => {
  it("数据血缘链 LR 分层：x 严格递增", () => {
    const nodes = [mkNode("t1", "sourceTable"), mkNode("q1", "sqlQuery"), mkNode("df1", "dataFrame")];
    const edges = [
      lineageEdge("data", { id: "e1", source: "t1", target: "q1" }),
      lineageEdge("data", { id: "e2", source: "q1", target: "df1" }),
    ];
    const { nodes: out } = getLayoutedElements(nodes, edges);
    expect(posOf(out, "t1").x).toBeLessThan(posOf(out, "q1").x);
    expect(posOf(out, "q1").x).toBeLessThan(posOf(out, "df1").x);
  });

  it("语义同伴同列堆叠：数据锚冻结，纯语义节点对齐其列并放其下方", () => {
    const nodes = [mkNode("t1", "sourceTable"), mkNode("q1", "sqlQuery"), mkNode("q2", "sqlQuery")];
    const edges = [
      lineageEdge("data", { id: "e1", source: "t1", target: "q1" }),
      lineageEdge("semantic", { id: "e-sem", source: "q1", target: "q2" }),
    ];
    const { nodes: out } = getLayoutedElements(nodes, edges);
    const q1 = posOf(out, "q1");
    const q2 = posOf(out, "q2");
    expect(q2.x).toBe(q1.x); // 同列（同宽 → 左缘对齐即同列）
    expect(q2.y).toBe(q1.y + SQL.h + GAP_Y); // 源在上、目标在下，间距 = 估算高 + GAP
  });

  it("数据优先：语义边两端都是数据锚时，两端位置与仅数据边布局完全一致", () => {
    const nodes = [
      mkNode("t1", "sourceTable"), mkNode("t2", "sourceTable"),
      mkNode("q1", "sqlQuery"), mkNode("q2", "sqlQuery"),
    ];
    const dataEdges = [
      lineageEdge("data", { id: "e1", source: "t1", target: "q1" }),
      lineageEdge("data", { id: "e2", source: "t2", target: "q2" }),
    ];
    const semantic = lineageEdge("semantic", { id: "e-sem", source: "q1", target: "q2" });
    const base = getLayoutedElements(nodes, dataEdges).nodes;
    const full = getLayoutedElements(nodes, [...dataEdges, semantic]).nodes;
    for (const id of ["q1", "q2"]) {
      expect(posOf(full, id)).toEqual(posOf(base, id));
    }
  });

  it("纯语义组件（无数据边）：同列堆叠、不重叠", () => {
    const nodes = [mkNode("q1", "sqlQuery"), mkNode("q2", "sqlQuery")];
    const edges = [lineageEdge("semantic", { id: "e-sem", source: "q1", target: "q2" })];
    const { nodes: out } = getLayoutedElements(nodes, edges);
    const q1 = posOf(out, "q1");
    const q2 = posOf(out, "q2");
    expect(q2.x).toBe(q1.x);
    expect(q2.y).toBeGreaterThanOrEqual(q1.y + SQL.h); // 矩形不相交
  });

  it("语义链 A→B→C：按语义方向依次向下、互不重叠", () => {
    const nodes = [mkNode("q1", "sqlQuery"), mkNode("q2", "sqlQuery"), mkNode("q3", "sqlQuery")];
    const edges = [
      lineageEdge("semantic", { id: "e-s1", source: "q1", target: "q2" }),
      lineageEdge("semantic", { id: "e-s2", source: "q2", target: "q3" }),
    ];
    const { nodes: out } = getLayoutedElements(nodes, edges);
    const [q1, q2, q3] = ["q1", "q2", "q3"].map((id) => posOf(out, id));
    expect(q2.x).toBe(q1.x);
    expect(q3.x).toBe(q1.x);
    expect(q2.y).toBe(q1.y + SQL.h + GAP_Y);
    expect(q3.y).toBe(q2.y + SQL.h + GAP_Y);
  });

  it("语义边不改变 dagre 分层：数据边布局结果不受语义边干扰", () => {
    const nodes = [
      mkNode("t1", "sourceTable"), mkNode("t2", "sourceTable"),
      mkNode("q1", "sqlQuery"), mkNode("q2", "sqlQuery"),
    ];
    const dataEdges = [
      lineageEdge("data", { id: "e1", source: "t1", target: "q1" }),
      lineageEdge("data", { id: "e2", source: "q2", target: "t2" }),
    ];
    const semantic = lineageEdge("semantic", { id: "e-sem", source: "q1", target: "q2" });
    const base = getLayoutedElements(nodes, dataEdges).nodes;
    const full = getLayoutedElements(nodes, [...dataEdges, semantic]).nodes;
    // 参与数据边的四个节点全部冻结（本例语义边两端 q1/q2 也都是数据锚）
    for (const id of ["t1", "t2", "q1", "q2"]) {
      expect(posOf(full, id)).toEqual(posOf(base, id));
    }
  });
});
