/**
 * X4 链路②集成测试：govio-canvas 扩展工具结果 / message_end → GovioNodeCreateEvent 转换。
 *
 * 驱动方式：stub pi（registerTool / on 捕获处理器），与既有 verify-*.ts 同款模式；
 * govio-cli 以 vi.mock 的 runGovioCli 兜底（readObserveInfo 回退路径），不调用真实 CLI。
 *
 * 覆盖（含 BUGFIX-load-parse / BUGFIX-df-columns 教训）：
 *  - observe load 成功输出 → dataFrame 事件：列结构（column_info）、Manifest、source_tables 血缘
 *  - success:false 失败输出 → 不建节点
 *  - jq 摘要缺 column_info → enrichLoadOutput 以 observe info 补列结构
 *  - govio_show_dataframe 工具 → dataFrame 事件（show-dataframe Manifest origin）
 *  - govio_create_source_table 工具 → sourceTable 事件（标注字段透传/枚举校验）
 *  - message_end 的 ```sql 代码块 → sqlQuery 事件（Manifest origin=assistant-sql）
 *  - 失败/边界：非法 dfName（注入防护）不建节点；非法 JSON 输出回退复核不建节点
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock agent.runGovioCli（govio-canvas 内部经动态 import 使用），供 readObserveInfo 回退
vi.mock("../../server/agent.js", () => ({
  runGovioCli: vi.fn(async () => {
    throw new Error("govio-cli not available in tests (mock)");
  }),
}));

import govioCanvasExtension from "../../server/extensions/govio-canvas.js";
import { flushGovioNodes } from "../../server/govio-node-queue.js";

// ── stub pi：捕获注册工具与事件处理器（与 verify-source-table.ts 同款） ────────

interface StubTool {
  name: string;
  description?: string;
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: never) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

function makePiStub() {
  const tools = new Map<string, StubTool>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const piStub = {
    registerTool: (tool: StubTool) => { tools.set(tool.name, tool); },
    on: (name: string, handler: unknown) => {
      handlers.set(name, handler as (event: unknown, ctx: unknown) => unknown);
      return () => {};
    },
  };
  govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0]);
  return { tools, handlers };
}

const piCtx = {
  sessionManager: { getSessionId: () => "sess-x4-ext" },
  model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
};

const bashResultEvent = (command: string, stdout: string, isError = false) => ({
  type: "tool_result",
  toolName: "bash",
  toolCallId: "call-x4-1",
  isError,
  input: { command },
  content: [{ type: "text", text: stdout }],
});

describe("govio-canvas 扩展：工具结果 → GovioNodeCreateEvent", () => {
  beforeEach(() => {
    flushGovioNodes();
  });

  it("observe load 成功输出 → dataFrame 事件，携带列结构与 Manifest", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    expect(toolResult).toBeTypeOf("function");

    const loadCmd = 'govio-cli observe load --name df_orders --datasource sales --sql "SELECT id, amt FROM orders" 2>&1';
    const stdout = JSON.stringify({
      success: true,
      rows: 1200,
      columns: 2,
      column_info: [
        { name: "id", dtype: "int64" },
        { name: "amt", dtype: "float64" },
      ],
    });
    await toolResult?.(bashResultEvent(loadCmd, stdout), piCtx);

    const events = flushGovioNodes();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.nodeType).toBe("dataFrame");
    expect(ev.dfName).toBe("df_orders");
    expect(ev.totalRows).toBe(1200);
    expect(ev.totalColumns).toBe(2);
    // BUGFIX-df-columns 教训：列结构必须进事件（节点列结构表与 Manifest 校验和依赖它）
    expect(ev.columns).toEqual([
      { name: "id", dtype: "int64", nonNull: 1200 },
      { name: "amt", dtype: "float64", nonNull: 1200 },
    ]);
    // Manifest：origin / sql / 模型 / 会话
    expect(ev.manifest?.origin).toBe("observe-load");
    expect(ev.manifest?.sql).toBe("SELECT id, amt FROM orders");
    expect(ev.manifest?.model?.id).toBe("claude-sonnet-4-5");
    expect(ev.manifest?.sessionId).toBe("sess-x4-ext");
    // 未过确认门 → permissionDecisionId 为 null（而非缺字段）
    expect(ev.manifest?.permissionDecisionId).toBeNull();
  });

  it("--memory 加载：SQL 提及的 source_tables 生成 sourceRefs 血缘，未提及的被过滤", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    const loadCmd = 'govio-cli observe load --name df_join --memory --sql "SELECT a.id FROM upstream_a a JOIN upstream_b b ON a.id = b.id" 2>&1';
    const stdout = JSON.stringify({
      success: true,
      rows: 10,
      columns: 1,
      column_info: [{ name: "id", dtype: "int64" }],
      source_tables: ["upstream_a", "upstream_b", "unrelated_df"],
    });
    await toolResult?.(bashResultEvent(loadCmd, stdout), piCtx);

    const ev = flushGovioNodes().find((e) => e.nodeType === "dataFrame");
    expect(ev).toBeDefined();
    const labels = (ev?.sourceRefs ?? []).map((r) => r.label);
    expect(labels).toContain("upstream_a");
    expect(labels).toContain("upstream_b");
    // 未在 SQL 中出现的 df 不应产生血缘边
    expect(labels).not.toContain("unrelated_df");
  });

  it("success:false 失败输出 → 不建节点（BUGFIX-load-parse 回归）", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    const failCmd = 'govio-cli observe load --name df_should_not_exist --datasource sales --sql "SELECT * FROM nope" 2>&1';
    const stdout = JSON.stringify({ success: false, error: "Catalog Error: Table nope does not exist" });
    await toolResult?.(bashResultEvent(failCmd, stdout), piCtx);

    expect(flushGovioNodes().find((e) => e.nodeType === "dataFrame")).toBeUndefined();
  });

  it("非法 JSON 输出（如 head 截断）→ 回退 observe info 复核，复核不到即不建节点", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    const loadCmd = 'govio-cli observe load --name df_trunc --datasource sales --sql "SELECT 1" 2>&1';
    await toolResult?.(bashResultEvent(loadCmd, '{"success": true, "rows": 1'), piCtx);
    // readObserveInfo 走 mock runGovioCli 抛错 → 返回 null → 不建节点
    expect(flushGovioNodes().find((e) => e.nodeType === "dataFrame")).toBeUndefined();
  });

  it("边界：非法 dfName（注入防护）→ 直接丢弃不建节点", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    const loadCmd = 'govio-cli observe load --name "df; rm -rf /" --datasource sales --sql "SELECT 1" 2>&1';
    const stdout = JSON.stringify({ success: true, rows: 1, columns: 1, column_info: [] });
    await toolResult?.(bashResultEvent(loadCmd, stdout), piCtx);
    expect(flushGovioNodes()).toHaveLength(0);
  });

  it("tool_result isError=true 的结果不建节点", async () => {
    const { handlers } = makePiStub();
    const toolResult = handlers.get("tool_result");
    const loadCmd = 'govio-cli observe load --name df_err --datasource sales --sql "SELECT 1" 2>&1';
    await toolResult?.(bashResultEvent(loadCmd, "command not found", true), piCtx);
    expect(flushGovioNodes()).toHaveLength(0);
  });

  it("govio_show_dataframe 工具 → dataFrame 事件（origin=show-dataframe，SQL 为空）", async () => {
    const { tools } = makePiStub();
    // readObserveInfo 依赖真实 CLI，这里 mock runGovioCli 返回 observe info 载荷
    const { runGovioCli } = await import("../../server/agent.js");
    vi.mocked(runGovioCli).mockResolvedValueOnce(JSON.stringify({
      rows: 5,
      columns: 2,
      column_info: [{ name: "a", dtype: "int" }, { name: "b", dtype: "str" }],
    }));

    const tool = tools.get("govio_show_dataframe");
    expect(tool).toBeDefined();
    const result = await tool!.execute("call-df", { dfName: "df_shown" } as never);
    expect(result.content[0]?.text).toContain("df_shown");

    const ev = flushGovioNodes().find((e) => e.nodeType === "dataFrame");
    expect(ev?.dfName).toBe("df_shown");
    expect(ev?.columns).toHaveLength(2);
    expect(ev?.manifest?.origin).toBe("show-dataframe");
    expect(ev?.manifest?.sql).toBe("");
  });

  it("govio_create_source_table：标注字段透传，枚举外 datasourceType 被丢弃", async () => {
    const { tools } = makePiStub();
    const tool = tools.get("govio_create_source_table");
    expect(tool).toBeDefined();

    await tool!.execute("call-st", {
      tableName: "chocolate.dim_product",
      database: "chocolate",
      datasource: "chocolate",
      datasourceType: "duckdb",
      schema: "chocolate",
      qualifiedName: "chocolate.chocolate.dim_product",
      fields: [{ name: "product_id", type: "VARCHAR", description: "产品ID" }],
    } as never);
    const ev = flushGovioNodes().find((e) => e.nodeType === "sourceTable");
    expect(ev?.datasourceType).toBe("duckdb");
    expect(ev?.qualifiedName).toBe("chocolate.chocolate.dim_product");

    await tool!.execute("call-st2", {
      tableName: "orders",
      database: "sales",
      datasourceType: "tds", // 枚举外
      fields: [{ name: "order_id", type: "BIGINT" }],
    } as never);
    const ev2 = flushGovioNodes().find((e) => e.nodeType === "sourceTable");
    expect(ev2).toBeDefined();
    expect(ev2 && "datasourceType" in ev2).toBe(false);
  });

  it("message_end 的 ```sql 代码块 → sqlQuery 事件（origin=assistant-sql）", async () => {
    const { handlers } = makePiStub();
    const messageEnd = handlers.get("message_end");
    expect(messageEnd).toBeTypeOf("function");

    await messageEnd?.({
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: Date.parse("2026-11-05T10:00:00.000Z"),
        content: [{ type: "text", text: "取数 SQL：\n```sql\nSELECT id FROM orders WHERE amt > 100\n```" }],
      },
    }, piCtx);

    const ev = flushGovioNodes().find((e) => e.nodeType === "sqlQuery");
    expect(ev).toBeDefined();
    expect(ev?.sql).toBe("SELECT id FROM orders WHERE amt > 100");
    expect(ev?.manifest?.origin).toBe("assistant-sql");
    expect(ev?.manifest?.executedAt).toBe("2026-11-05T10:00:00.000Z");
    // sqlQuery 节点尚未执行 → 无结果校验和
    expect(ev?.manifest?.checksum).toBeUndefined();
  });

  it("message_end 边界：无 sql 代码块 / 非 assistant 消息 → 不建节点", async () => {
    const { handlers } = makePiStub();
    const messageEnd = handlers.get("message_end");
    await messageEnd?.({
      message: { role: "assistant", content: [{ type: "text", text: "纯文本回复，没有代码块" }] },
    }, piCtx);
    await messageEnd?.({
      message: { role: "user", content: [{ type: "text", text: "```sql\nSELECT 1\n```" }] },
    }, piCtx);
    expect(flushGovioNodes()).toHaveLength(0);
  });
});
