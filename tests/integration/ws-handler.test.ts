/**
 * X4 链路①集成测试：ws-handler 消息处理 + permission-manager allow/deny/edit 决策分支。
 *
 * 驱动方式：真实 `setupWebSocket` 挂到临时 http server + `ws` 包客户端；
 * pi session / govio-cli / 模型配置全部 mock（vi.mock），不接触真实 LLM / 网络 / govio-cli。
 *
 * 覆盖：
 *  - 连接初始化：session_ready 推送
 *  - prompt：REF 前缀拼接（makePrompt）+ session.prompt 调用
 *  - tool_permission_request 推送 + tool_permission_response 的 allow / deny / edit 三分支
 *  - permission_accept_all → 后续请求不打扰前端但仍返回 decisionId（审计留痕路径）
 *  - 失败/边界：非法 JSON 消息返回 error；session_open 缺 path / 越界路径被拒；
 *    abort 清队列并 denyPending；canvas_save 静默不报错
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as WsClient } from "ws";

// ── mock 依赖：pi session / agent 单例 / 模型配置 ─────────────────────────────

vi.mock("../../server/agent.js", () => {
  const fakeSession = {
    sessionId: "sess-x4-mock",
    isStreaming: false,
    subscribe: (cb: (e: { type: string }) => void) => {
      // 捕获订阅者，供测试派发 agent_end 等生命周期事件
      (globalThis as Record<string, unknown>).__wsEmit = cb;
      return () => {};
    },
    prompt: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve("steered")),
    followUp: vi.fn(() => Promise.resolve("queued")),
    abort: vi.fn(),
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    modelRuntime: { getModel: () => ({ provider: "mock", id: "mock-model" }) },
    setModel: () => Promise.resolve(),
    sessionManager: {
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
  };
  return {
    __esModule: true,
    getOrCreateSession: vi.fn(async () => fakeSession),
    resetSession: vi.fn(),
    openSessionFile: vi.fn(async () => fakeSession),
    runGovioCli: vi.fn(async () => "[]"),
    agentSetup: vi.fn(async () => {}),
    getLoadedSkills: () => [],
    getSession: () => null,
    __fakeSession: fakeSession,
  };
});

vi.mock("../../server/backend.js", () => ({
  __esModule: true,
  isAgentConfigNeeded: () => false,
  completeAgentSetup: vi.fn(async () => {}),
  startBackend: vi.fn(),
}));

// T2.1：图谱查询执行器 mock——测试不得 spawn 真实 govio-cli；默认返回一组指标行。
const graphMock = vi.hoisted(() => ({
  runGraphQuery: vi.fn(async (): Promise<Array<Record<string, unknown>>> => [
    { id: "ME1", code: "m_sales_amount", name: "销售额", definition: "销售金额合计", metric_type: "atomic", formula: "", unit: "元" },
  ]),
}));

vi.mock("../../server/graph-query.js", () => ({
  __esModule: true,
  GRAPH_QUERY_TIMEOUT_MS: 12000,
  runGraphQuery: graphMock.runGraphQuery,
}));

vi.mock("../../server/models-config.js", () => ({
  __esModule: true,
  readModelsConfig: vi.fn(async () => ({ providers: {} })),
  writeModelsConfig: vi.fn(async () => {}),
  createDefaultModelsConfig: vi.fn(async () => {}),
  maskModelsConfig: (c: unknown) => c,
}));

import { setupWebSocket } from "../../server/ws-handler.js";
import { permissionManager } from "../../server/permission-manager.js";
import * as agentModule from "../../server/agent.js";

// ── 测试工具 ────────────────────────────────────────────────────────────────

interface WireMsg { type: string; [k: string]: unknown }

function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  setupWebSocket(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

/**
 * 连接并**持有**消息监听：在同一个 tick 里先于服务端首帧到达前挂好 listener。
 * （服务端连接回调为 async，首帧 session_ready 可能在 connect() resolve 后立即发出；
 *   若等 connect() 返回再挂 listener，同步竞争下会丢首帧。）
 */
function connectWithCollector(port: number): Promise<{ ws: WsClient; col: Collector }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/ws`);
    const col = new Collector();
    col.attach(ws);
    ws.on("open", () => resolve({ ws, col }));
    ws.on("error", reject);
  });
}

class Collector {
  messages: WireMsg[] = [];
  private waiters: Array<() => void> = [];
  attach(ws: WsClient): void {
    ws.on("message", (data) => {
      try {
        this.messages.push(JSON.parse(data.toString()));
      } catch {
        this.messages.push({ type: "__raw", raw: data.toString() });
      }
      const waiters = this.waiters;
      this.waiters = [];
      waiters.forEach((w) => w());
    });
    ws.on("error", (err) => {
      this.messages.push({ type: "__ws_error", raw: String(err) });
    });
    ws.on("close", (code) => {
      this.messages.push({ type: "__ws_close", raw: String(code) });
    });
  }
  /** 等到出现满足谓词的消息（带超时） */
  waitFor(pred: (m: WireMsg) => boolean, timeoutMs = 3000): Promise<WireMsg> {
    return new Promise((resolve, reject) => {
      const found = this.messages.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        reject(new Error(`waitFor 超时；已收消息: ${JSON.stringify(this.messages.map((m) => m.type))}`));
      }, timeoutMs);
      const onMsg = () => {
        const hit = this.messages.find(pred);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          this.waiters.push(onMsg);
        }
      };
      this.waiters.push(onMsg);
    });
  }
}

// ── 测试主体 ────────────────────────────────────────────────────────────────

describe("ws-handler 消息处理 + 权限决策流", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer());
  });

  afterAll(async () => {
    permissionManager.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 500).unref();
    });
  });

  beforeEach(() => {
    permissionManager.clearAll();
  });

  it("连接建立后推送 session_ready（mock session 初始化）", async () => {
    const { ws, col } = await connectWithCollector(port);
    const ready = await col.waitFor((m) => m.type === "session_ready");
    expect(ready.sessionId).toBe("sess-x4-mock");
    ws.close();
  });

  it("prompt 消息触发 session.prompt，带 referencedNodes 时拼 REF 前缀", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({
      type: "prompt",
      content: "统计订单金额",
      referencedNodes: [{ nodeId: "gov-1", label: "orders", type: "sourceTable", data: "SELECT * FROM orders" }],
    }));
    const fake = (agentModule as unknown as { __fakeSession: { prompt: ReturnType<typeof vi.fn> } }).__fakeSession;
    await vi.waitFor(() => expect(fake.prompt).toHaveBeenCalledTimes(1));
    // makePrompt：REF:[{"orders":"SELECT * FROM orders"}]\n + content
    const sent = fake.prompt.mock.calls[0][0] as string;
    expect(sent).toMatch(/^REF:\[/);
    expect(sent).toContain("统计订单金额");
    expect(sent).toContain('"orders"');
    ws.close();
  });

  it("tool_permission_response(allow)：请求推送前端、决策回传 resolve、决策可关联", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    const cmd = 'govio-cli observe load --name df_x --datasource s --sql "SELECT 1" 2>&1';
    const pending = permissionManager.requestPermission(cmd, "call-x4");
    const req = await col.waitFor((m) => m.type === "tool_permission_request");
    expect(req.command).toContain("observe load");
    expect(String(req.requestId)).toMatch(/^pd-/);

    ws.send(JSON.stringify({ type: "tool_permission_response", requestId: req.requestId, decision: "allow" }));
    const result = await pending;
    expect(result.decision).toBe("allow");
    expect(result.decisionId).toBe(req.requestId);
    // 决策进入索引（供 Manifest 回填 decisionId）
    expect(permissionManager.decisionIdForExecution(cmd, "call-x4")).toBe(result.decisionId);
    ws.close();
  });

  it("deny 分支：resolve 收到 deny + reason", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    const pending = permissionManager.requestPermission("govio-cli observe info --name secret --rows 50", "call-deny");
    const req = await col.waitFor((m) => m.type === "tool_permission_request");
    ws.send(JSON.stringify({
      type: "tool_permission_response",
      requestId: req.requestId,
      decision: "deny",
      reason: "用户拒绝执行该命令",
    }));
    const result = await pending;
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("用户拒绝执行该命令");
    ws.close();
  });

  it("edit 分支：editedCommand 透传，改后命令进决策索引", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    const original = 'govio-cli observe load --name df_e --datasource s --sql "SELECT * FROM t" -o o.parquet 2>&1';
    const edited = 'govio-cli observe load --name df_e --datasource s --sql "SELECT id FROM t LIMIT 100" -o o.parquet 2>&1';
    const pending = permissionManager.requestPermission(original, "call-edit");
    const req = await col.waitFor((m) => m.type === "tool_permission_request");
    ws.send(JSON.stringify({
      type: "tool_permission_response",
      requestId: req.requestId,
      decision: "edit",
      editedCommand: edited,
      reason: "只取必要列",
    }));
    const result = await pending;
    expect(result.decision).toBe("edit");
    expect(result.editedCommand).toBe(edited);
    // 改后命令关联本次决策（edit 不索引原命令）
    expect(permissionManager.decisionIdForExecution(edited)).toBe(result.decisionId);
    expect(permissionManager.decisionIdForExecution(original)).toBeNull();
    ws.close();
  });

  it("permission_accept_all：后续请求不打扰前端，但仍返回 decisionId（留痕路径）", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({ type: "permission_accept_all" }));
    await new Promise((r) => setTimeout(r, 50));
    const before = col.messages.filter((m) => m.type === "tool_permission_request").length;
    const result = await permissionManager.requestPermission('govio-cli observe load --name df_all --datasource s --sql "SELECT 1"', "call-all");
    expect(result.decision).toBe("allow");
    expect(result.decisionId).toMatch(/^pd-/);
    await new Promise((r) => setTimeout(r, 50));
    expect(col.messages.filter((m) => m.type === "tool_permission_request").length).toBe(before);
    ws.close();
  });

  it("边界：非法 JSON 消息返回 error；session_open 缺 path 返回 error", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send("{not valid json");
    const err1 = await col.waitFor((m) => m.type === "error");
    expect(err1.message).toBeTruthy();

    ws.send(JSON.stringify({ type: "session_open" }));
    const err2 = await col.waitFor((m) => m.type === "error" && String(m.message).includes("session_open"));
    expect(err2.message).toContain("requires path");
    ws.close();
  });

  it("边界：session_open 越界路径被拒（会话目录包含检查）", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({ type: "session_open", path: "C:/evil/outside.jsonl" }));
    const err = await col.waitFor((m) => m.type === "error" && String(m.message).includes("session_open"));
    expect(err.message).toContain("failed");
    ws.close();
  });

  it("abort：清队列 + denyPending，推送 queue_cleared", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({ type: "abort" }));
    const cleared = await col.waitFor((m) => m.type === "queue_cleared");
    expect(cleared.clearedSteering).toBe(0);
    expect(cleared.clearedFollowUp).toBe(0);
    ws.close();
  });

  it("canvas_save：不抛错、不回消息（静默落盘路径经 session file=undefined 跳过）", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({ type: "canvas_save", nodes: [{ id: "n1" }], edges: [] }));
    await new Promise((r) => setTimeout(r, 80));
    expect(col.messages.filter((m) => m.type === "error")).toHaveLength(0);
    ws.close();
  });

  // ── T2.1：图谱定义自动注入（makePrompt → REF/CTX 序列化） ──────────────

  it("prompt 注入：CTX 行含 qualifiedName/datasourceType，用户内容原样保留", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({
      type: "prompt",
      content: "查一下产品",
      referencedNodes: [{
        nodeId: "n-product",
        label: "dim_product",
        type: "sourceTable",
        data: JSON.stringify({
          full_table_name: "dim_product",
          qualifiedName: "chocolate.chocolate.dim_product",
          datasource: "chocolate",
          datasourceType: "duckdb",
          schema: "chocolate",
          fields: [],
        }),
      }],
    }));
    const fake = (agentModule as unknown as { __fakeSession: { prompt: ReturnType<typeof vi.fn> } }).__fakeSession;
    await vi.waitFor(() => expect(fake.prompt.mock.calls.length).toBeGreaterThan(0));
    const sent = fake.prompt.mock.calls.at(-1)![0] as string;
    expect(sent).toMatch(/^REF:\[/);
    expect(sent).toContain("CTX:");
    expect(sent).toContain("chocolate.chocolate.dim_product");
    expect(sent).toContain('"datasourceType":"duckdb"');
    expect(sent).toContain("查一下产品");
    ws.close();
  });

  it("T2.1 降级：图谱不可达时 prompt 照常派发（不阻断会话），CTX 仍含表事实并标记 degraded", async () => {
    graphMock.runGraphQuery.mockImplementation(async () => {
      throw new Error("spawn govio-cli ENOENT");
    });
    try {
      const { ws, col } = await connectWithCollector(port);
      await col.waitFor((m) => m.type === "session_ready");

      ws.send(JSON.stringify({
        type: "prompt",
        content: "降级也要能问",
        referencedNodes: [{
          nodeId: "n-product",
          label: "dim_product",
          type: "sourceTable",
          data: JSON.stringify({ qualifiedName: "chocolate.chocolate.dim_product", datasourceType: "duckdb", tableName: "dim_product", schema: "chocolate" }),
        }],
      }));
      const fake = (agentModule as unknown as { __fakeSession: { prompt: ReturnType<typeof vi.fn> } }).__fakeSession;
      await vi.waitFor(() => expect(fake.prompt.mock.calls.length).toBeGreaterThan(0));
      const sent = fake.prompt.mock.calls.at(-1)![0] as string;
      expect(sent).toContain("CTX:");
      expect(sent).toContain("chocolate.chocolate.dim_product");
      expect(sent).toContain('"graphStatus":"degraded"');
      expect(sent).toContain("降级也要能问");
      expect(col.messages.filter((m) => m.type === "error")).toHaveLength(0);
      ws.close();
    } finally {
      graphMock.runGraphQuery.mockImplementation(async () => [
        { id: "ME1", code: "m_sales_amount", name: "销售额", definition: "销售金额合计", metric_type: "atomic", formula: "", unit: "元" },
      ]);
    }
  });
});

describe("口径引用生命周期（流式排队不得提前清空）", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer());
  });
  afterAll(async () => {
    permissionManager.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 500).unref();
    });
  });

  it("流式中 prompt 走 steer 排队后，semanticRefs/caliberMetrics 仍保留（供后续 message_end 归因）", async () => {
    const { getSessionSemanticRefs, getSessionCaliberMetrics } = await import("../../server/semantic-context.js");
    const fake = (agentModule as unknown as {
      __fakeSession: { isStreaming: boolean; steer: ReturnType<typeof vi.fn> };
    }).__fakeSession;

    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    fake.isStreaming = true; // 模拟 agent 仍在输出：prompt 走 steer 队列
    ws.send(JSON.stringify({ type: "prompt", content: "算一下 2023 年各国家的销售额" }));
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalled());

    // 关键回归：steer 排队后 dispatch 的 finally 已执行，但引用不得被清空——
    // 否则延后触发的 message_end 取不到口径引用，caliberCheck 永远不产出。
    await vi.waitFor(() => {
      expect(getSessionSemanticRefs("sess-x4-mock")?.length).toBeGreaterThan(0);
    });
    expect(getSessionCaliberMetrics("sess-x4-mock")?.length).toBeGreaterThan(0);

    fake.isStreaming = false;
    ws.close();
  });
});

describe("口径引用生命周期：agent_end 清理", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer());
  });
  afterAll(async () => {
    permissionManager.clearAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 500).unref();
    });
  });

  it("本轮运行结束（agent_end）才清理，保证 steer 后续产出仍可归因", async () => {
    const { getSessionSemanticRefs } = await import("../../server/semantic-context.js");

    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");
    // 连接建立订阅后才取到本连接的订阅回调（取早了会拿到上一次已关闭连接的）
    const emit = (globalThis as Record<string, unknown>).__wsEmit as
      | ((e: { type: string }) => void)
      | undefined;
    expect(typeof emit).toBe("function");

    ws.send(JSON.stringify({ type: "prompt", content: "算一下 2023 年各国家的销售额" }));
    await vi.waitFor(() => expect(getSessionSemanticRefs("sess-x4-mock")?.length).toBeGreaterThan(0));

    // steer 属于同一轮运行：不清理
    ws.send(JSON.stringify({ type: "steer", content: "换个口径再算一次" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(getSessionSemanticRefs("sess-x4-mock")?.length).toBeGreaterThan(0);

    // agent_end：本轮结束 → 清理，下一轮未注入时不继承旧口径
    emit?.({ type: "agent_end" });
    await vi.waitFor(() => expect(getSessionSemanticRefs("sess-x4-mock")).toBeUndefined());
    ws.close();
  });
});
