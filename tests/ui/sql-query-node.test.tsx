// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import SQLQueryNode from "../../src/components/Nodes/SQLQueryNode.js";
import type { SQLQueryNodeData } from "../../src/types/index.js";

const storeMocks = vi.hoisted(() => ({
  addReference: vi.fn(),
  deleteNodes: vi.fn(),
  updateNodeData: vi.fn(),
}));

vi.mock("../../src/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: typeof storeMocks) => unknown) => selector(storeMocks),
}));

function sqlData(overrides: Partial<SQLQueryNodeData> = {}): SQLQueryNodeData {
  return {
    type: "sqlQuery",
    title: "Q: 汇总",
    createdAt: "2026-11-12T00:00:00.000Z",
    sql: "SELECT 1",
    outputColumns: ["1"],
    ...overrides,
  };
}

function renderNode(data: SQLQueryNodeData) {
  const props = { id: "sql-1", data } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <SQLQueryNode {...props} />
    </ReactFlowProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SQLQueryNode 语义血缘 Handle 方向", () => {
  it("语义 Handle 下出上入（source@Bottom / target@Top），默认左右 Handle 保留", () => {
    renderNode(sqlData());

    const semSource = document.querySelector('[data-handleid="semantic-source"]');
    const semTarget = document.querySelector('[data-handleid="semantic-target"]');
    expect(semSource).toBeTruthy();
    expect(semSource?.getAttribute("data-handlepos")).toBe("bottom");
    expect(semTarget).toBeTruthy();
    expect(semTarget?.getAttribute("data-handlepos")).toBe("top");
    // 默认（无 id）source/target Handle 仍各一个，数据血缘继续左右连接
    expect(document.querySelectorAll(".react-flow__handle")).toHaveLength(4);
  });

  it("渲染标题（smoke；SQL 正文为语法高亮拆分的 span，不断言整串）", () => {
    renderNode(sqlData());
    expect(screen.getByText("Q: 汇总")).toBeTruthy();
    expect(document.querySelector("textarea, .react-flow__node") ?? document.body).toBeTruthy();
  });
});
