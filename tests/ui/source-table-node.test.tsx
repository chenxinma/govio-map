// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import SourceTableNode from "../../src/components/Nodes/SourceTableNode.js";
import type { SourceTableNodeData, TableField, TableRelation } from "../../src/types/index.js";

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

  it("渲染语义血缘专用 Handle：表关系边反向（source 下 / target 上），默认左右 Handle 保留", () => {
    renderNode(sourceData());
    const semSource = document.querySelector('[data-handleid="semantic-source"]');
    const semTarget = document.querySelector('[data-handleid="semantic-target"]');
    expect(semSource).toBeTruthy();
    expect(semSource?.getAttribute("data-handlepos")).toBe("bottom");
    expect(semTarget).toBeTruthy();
    expect(semTarget?.getAttribute("data-handlepos")).toBe("top");
    // 默认（无 id）source/target Handle 仍各一个，数据血缘继续左右连接
    expect(document.querySelectorAll(".react-flow__handle")).toHaveLength(4);
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

    expect(screen.queryByTitle("复制完整表名")).toBeNull();
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
// ── X13：表间关系小节与降级留痕提示 ──────────────────────────────────────

/** live 图谱实测形状（X10）：三段式目标 + many_to_one，三行都没有 description */
const STAR_RELATIONS: TableRelation[] = [
  { targetTable: "chocolate.chocolate.dim_product", relationshipType: "many_to_one", sourceColumns: ["product_id"], targetColumns: ["product_id"] },
  { targetTable: "chocolate.chocolate.dim_country", relationshipType: "many_to_one", sourceColumns: ["country_id"], targetColumns: ["country_id"] },
  { targetTable: "chocolate.chocolate.dim_channel", relationshipType: "many_to_one", sourceColumns: ["channel_id"], targetColumns: ["channel_id"] },
];

describe("SourceTableNode 表间关系出口（X13）", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("星型模型 3 条关系：裸表名 + many_to_one 徽标 + 列映射都可见", () => {
    renderNode(sourceData({ tableName: "fact_sales", tableRelations: STAR_RELATIONS, tableRelationsSource: "graph" }));

    expect(screen.getByText("表间关系")).toBeTruthy();
    expect(screen.getByText("dim_product")).toBeTruthy();
    expect(screen.getByText("dim_country")).toBeTruthy();
    expect(screen.getByText("dim_channel")).toBeTruthy();
    expect(screen.getAllByText("many_to_one")).toHaveLength(3);
    expect(screen.getByText("product_id → product_id")).toBeTruthy();
    expect(screen.getByText("channel_id → channel_id")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByTitle("关系目标表：chocolate.chocolate.dim_product").textContent).toBe("dim_product");
  });

  it("description 存在时渲染说明行，缺失时不渲染空行（行数可断言）", () => {
    renderNode(sourceData({
      tableRelations: [{ ...STAR_RELATIONS[0], description: "事实表产品外键" }],
      tableRelationsSource: "graph",
    }));
    const row = screen.getByText("dim_product").closest(".text-xs");
    expect(row).not.toBeNull();
    expect(screen.getByText("事实表产品外键")).toBeTruthy();
    // 行结构：目标表 + 类型 / 列映射 / 说明 = 3 个子节点
    expect(row!.children).toHaveLength(3);
    cleanup();

    renderNode(sourceData({ tableRelations: [STAR_RELATIONS[0]], tableRelationsSource: "graph" }));
    const bare = screen.getByText("dim_product").closest(".text-xs");
    expect(bare!.children).toHaveLength(2);
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("无 tableRelations 时整个小节不渲染（旧节点形状不变、不出现空壳）", () => {
    renderNode(sourceData());
    expect(screen.queryByText("表间关系")).toBeNull();
    expect(screen.queryByText("many_to_one")).toBeNull();
  });

  it("关系多于 3 条时默认折叠，可展开与收起", async () => {
    const user = userEvent.setup();
    const relations: TableRelation[] = [
      ...STAR_RELATIONS,
      { targetTable: "chocolate.chocolate.dim_date", relationshipType: "many_to_one", sourceColumns: ["date_id"], targetColumns: ["date_id"] },
    ];
    renderNode(sourceData({ tableRelations: relations, tableRelationsSource: "graph" }));

    expect(screen.queryByText("dim_date")).toBeNull();
    expect(screen.getByText("+1 more relations")).toBeTruthy();

    await user.click(screen.getByText("+1 more relations"));
    expect(screen.getByText("dim_date")).toBeTruthy();
    expect(screen.getByText("date_id → date_id")).toBeTruthy();

    await user.click(screen.getByText("Collapse"));
    expect(screen.queryByText("dim_date")).toBeNull();
  });

  it("列映射单侧缺失只渲染存在的一侧，两侧都缺时不渲染映射行", () => {
    renderNode(sourceData({
      tableRelations: [
        { targetTable: "dim_product", relationshipType: "many_to_one", sourceColumns: ["product_id"] },
        { targetTable: "dim_country", relationshipType: "one_to_many", targetColumns: ["country_id"] },
        { targetTable: "dim_channel", relationshipType: "many_to_one" },
      ],
    }));
    expect(screen.getByText("product_id")).toBeTruthy();
    expect(screen.getByText("country_id")).toBeTruthy();
    expect(screen.getByText("dim_channel")).toBeTruthy();
    // 没有任何一条孤立的「→」空映射行
    expect(document.body.textContent).not.toContain("→");
    expect(screen.getByText("dim_channel").closest(".text-xs")!.children).toHaveLength(1);
  });

  it("降级留痕：source=fields 出现「字段级关系」提示；graph 正常态不出现", () => {
    renderNode(sourceData({
      tableRelations: [{ targetTable: "dim_product", relationshipType: "foreign_key", sourceColumns: ["product_id"], targetColumns: ["product_id"] }],
      tableRelationsSource: "fields",
    }));
    expect(screen.getByText("字段级关系")).toBeTruthy();
    expect(screen.getByTitle(/图谱未记录该表关系/)).toBeTruthy();
    cleanup();

    renderNode(sourceData({ tableRelations: STAR_RELATIONS, tableRelationsSource: "graph" }));
    expect(screen.queryByText("字段级关系")).toBeNull();
    expect(screen.queryByText("图谱降级")).toBeNull();
    expect(screen.getByText("表间关系")).toBeTruthy();
  });

  it("降级留痕：图谱失败原因可见（展示行截断，title 保留全文）", () => {
    const longError = `spawn govio-cli ENOENT: ${"detail ".repeat(30)}`;
    renderNode(sourceData({
      tableRelations: [{ targetTable: "dim_product", relationshipType: "foreign_key" }],
      tableRelationsSource: "fields",
      tableRelationsError: longError,
    }));
    const shown = screen.getByTitle(/spawn govio-cli ENOENT/);
    expect(shown.textContent!.length).toBeLessThanOrEqual(60);
    expect(shown.getAttribute("title")).toContain(longError.trim());
    expect(screen.getByText("字段级关系")).toBeTruthy();
  });

  it("只有 tableRelationsError（一条关系都没拿到）：提示图谱降级，关系小节仍不渲染", () => {
    renderNode(sourceData({ tableRelationsError: "graph query timeout after 8000ms" }));
    expect(screen.getByText("图谱降级")).toBeTruthy();
    expect(screen.getByTitle(/本表无表间关系/)).toBeTruthy();
    expect(screen.queryByText("表间关系")).toBeNull();
  });

  it("脏关系数据被过滤（null / 缺 targetTable），节点不报错", () => {
    renderNode(sourceData({
      tableRelations: [STAR_RELATIONS[0], null, { relationshipType: "many_to_one" }] as unknown as TableRelation[],
      tableRelationsSource: "graph",
    }));
    expect(screen.getByText("表间关系")).toBeTruthy();
    expect(screen.getByText("dim_product")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("关系小节不影响 Handle：默认左右 + 语义上下仍各 4 个", () => {
    renderNode(sourceData({ tableRelations: STAR_RELATIONS, tableRelationsSource: "graph" }));
    expect(document.querySelectorAll(".react-flow__handle")).toHaveLength(4);
  });
});
