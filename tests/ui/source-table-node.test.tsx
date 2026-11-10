// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import SourceTableNode from "../../src/components/Nodes/SourceTableNode.js";
import type { SourceTableNodeData, TableField } from "../../src/types/index.js";

const storeMocks = vi.hoisted(() => ({
  addReference: vi.fn(),
  deleteNodes: vi.fn(),
}));

vi.mock("../../src/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: typeof storeMocks) => unknown) => selector(storeMocks),
}));

function field(name: string, overrides: Partial<TableField> = {}): TableField {
  return { name, type: "VARCHAR", nullable: true, ...overrides };
}

function sourceData(overrides: Partial<SourceTableNodeData> = {}): SourceTableNodeData {
  return {
    type: "sourceTable",
    title: "orders",
    createdAt: "2026-11-10T00:00:00.000Z",
    tableName: "orders",
    database: "sales",
    rowCount: 1200,
    fields: [
      field("id", {
        type: "BIGINT",
        nullable: false,
        isPrimaryKey: true,
        description: "订单主键",
      }),
      field("customer_id", {
        type: "BIGINT",
        isForeignKey: true,
        references: { table: "customers", field: "id" },
      }),
    ],
    ...overrides,
  };
}

function renderNode(data: SourceTableNodeData) {
  const props = { id: "source-1", data } as unknown as NodeProps;
  return render(
    <ReactFlowProvider>
      <SourceTableNode {...props} />
    </ReactFlowProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SourceTableNode 渲染与交互", () => {
  it("渲染字段、类型、PK/FK 徽标和关系字段", () => {
    renderNode(
      sourceData({
        datasource: "warehouse",
        datasourceType: "duckdb",
        qualifiedName: "warehouse.sales.orders",
      })
    );

    expect(screen.getByText("orders")).toBeTruthy();
    expect(screen.getByText("sales")).toBeTruthy();
    expect(screen.getByText("1,200 rows")).toBeTruthy();
    expect(screen.getByText("duckdb")).toBeTruthy();
    expect(screen.getByText("warehouse.sales.orders")).toBeTruthy();
    expect(screen.getByText("id")).toBeTruthy();
    expect(screen.getAllByText("BIGINT")).toHaveLength(2);
    expect(screen.getByText("PK")).toBeTruthy();
    expect(screen.getByText("FK")).toBeTruthy();
    expect(screen.getByText("订单主键")).toBeTruthy();
  });

  it("引用按钮把节点 id 交给 store.addReference", async () => {
    const user = userEvent.setup();
    renderNode(sourceData());

    await user.click(screen.getByRole("button", { name: "引用" }));

    expect(storeMocks.addReference).toHaveBeenCalledTimes(1);
    expect(storeMocks.addReference).toHaveBeenCalledWith("source-1");
  });

  it("缺失 qualifiedName/datasourceType 时回退旧显示且不出现 undefined", () => {
    renderNode(sourceData());

    expect(screen.queryByTitle("复制全限定名")).toBeNull();
    expect(screen.queryByText("undefined")).toBeNull();
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("字段超过 6 行时可展开全部并折叠", async () => {
    const user = userEvent.setup();
    const fields = Array.from({ length: 8 }, (_, index) => field(`field_${index}`));
    renderNode(sourceData({ fields }));

    expect(screen.queryByText("field_7")).toBeNull();
    expect(screen.getByText("+2 more fields")).toBeTruthy();

    await user.click(screen.getByText("+2 more fields"));
    expect(screen.getByText("field_7")).toBeTruthy();

    await user.click(screen.getByText("Collapse"));
    expect(screen.queryByText("field_7")).toBeNull();
  });

  it("删除按钮把当前节点 id 交给 store.deleteNodes", () => {
    renderNode(sourceData());

    const deleteButton = document.querySelector("button.ml-auto");
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(storeMocks.deleteNodes).toHaveBeenCalledWith(["source-1"]);
  });
});
