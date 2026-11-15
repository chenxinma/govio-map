// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import SQLQueryNode from "../../src/components/Nodes/SQLQueryNode.js";
import type { SemanticRef, SQLQueryNodeData } from "../../src/types/index.js";

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

/** 「口径」小节头部的计数（按结构取，避免与 SQL 高亮拆出的数字 span 撞文本） */
function badgeCount(): string | null {
  const label = screen.getByText("口径");
  return label.parentElement?.querySelector("span.ml-auto")?.textContent ?? null;
}

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

describe("SQLQueryNode 口径徽标（X18 / PD-1 方案 1）", () => {
  const REFS: SemanticRef[] = [
    { entityType: "Metric", id: "m-gmv", code: "m_gmv", name: "销售额" },
    { entityType: "Dimension", id: "d-region", code: "region", name: "区域" },
  ];

  it("渲染「口径」小节：指标徽标 code 优先、维度带类型前缀、计数只算可展示徽标", () => {
    renderNode(sqlData({ semanticRefs: REFS, outputColumns: ["sales"] }));

    expect(screen.getByText("口径")).toBeTruthy();
    expect(screen.getByText("m_gmv")).toBeTruthy();
    expect(screen.getByText("维度·region")).toBeTruthy();
    expect(badgeCount()).toBe("2");
  });

  it("hover title 给完整信息（类型 / 编码 / 名称 / 图谱 ID）", () => {
    renderNode(sqlData({ semanticRefs: REFS }));

    const chip = screen.getByTitle(/类型：指标/);
    expect(chip.title).toContain("编码：m_gmv");
    expect(chip.title).toContain("名称：销售额");
    expect(chip.title).toContain("图谱 ID：m-gmv");
    expect(screen.getByTitle(/类型：维度/).title).toContain("图谱 ID：d-region");
  });

  it("code 缺失回落 name；code/name 都缺（含纯空白）的引用整条跳过，无 undefined 文案", () => {
    renderNode(sqlData({
      outputColumns: ["sales"],
      semanticRefs: [
        { entityType: "Metric", id: "m-orders", name: "订单数" },
        { entityType: "Col", id: "col-no-label" },
        { entityType: "Metric", id: "m-blank", code: "   ", name: "" },
      ],
    }));

    expect(screen.getByText("订单数")).toBeTruthy();
    expect(badgeCount()).toBe("1");
    expect(screen.queryByText("undefined")).toBeNull();
    expect(document.body.textContent).not.toContain("col-no-label");
    expect(document.body.textContent).not.toContain("m-blank");
  });

  it("无 semanticRefs（旧节点 / 手动 SQL 节点 / 图谱降级）→ 整个徽标区不渲染", () => {
    renderNode(sqlData());

    expect(screen.queryByText("口径")).toBeNull();
    expect(document.body.textContent).not.toContain("more refs");
  });

  it("超过 3 条默认折叠：「+N more refs」展开、「Collapse」收起（关系小节同款范式）", () => {
    const many: SemanticRef[] = [1, 2, 3, 4, 5].map((i) => ({
      entityType: "Metric",
      id: `m-${i}`,
      code: `m_${i}`,
    }));
    renderNode(sqlData({ semanticRefs: many }));

    expect(screen.getByText("m_3")).toBeTruthy();
    expect(screen.queryByText("m_4")).toBeNull();
    fireEvent.click(screen.getByText("+2 more refs"));
    expect(screen.getByText("m_5")).toBeTruthy();
    fireEvent.click(screen.getByText("Collapse"));
    expect(screen.queryByText("m_4")).toBeNull();
  });

  it("与 T2.3 口径警示共存：警示仍在标题行优先呈现，徽标不借警示色、不写死色值", () => {
    renderNode(sqlData({
      semanticRefs: REFS,
      caliberCheck: {
        status: "conflict",
        differences: [{ aspect: "column", expected: "amount", found: "price * boxes" }],
      },
    }));

    const warning = screen.getByText("口径冲突");
    const sectionLabel = screen.getByText("口径");
    expect(warning).toBeTruthy();
    expect(screen.getByText("m_gmv")).toBeTruthy();
    // 警示优先级高于徽标：警示徽标在文档顺序上先出现（标题行），口径小节在其后独立成行
    expect(
      warning.compareDocumentPosition(sectionLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 徽标配色走 green-deck token class，组件内不留内联色值（警示黄仍只由 caliber 给出）
    const chip = screen.getByTitle(/类型：指标/);
    expect(chip.getAttribute("style")).toBeNull();
    expect(chip.className).toContain("text-node-source");
    // 警示徽标的黄色内联样式仍在（未被徽标区改写）
    expect(warning.closest("button")?.style.color).not.toBe("");
  });
});
