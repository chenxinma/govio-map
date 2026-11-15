/**
 * X2 契约测试：/ws 协议版本化 schema（types/ws-protocol.ts）。
 *
 * 覆盖（对齐 acceptance「契约测试纳入 verify 聚合：合法收发 + 非法/未知消息拒绝路径」）：
 *  1. 契约注册表：版本字段、$id 命名、消息类型全集（与样本清单双向对齐，防漂移）
 *  2. 合法收发：客户端 17 类 / 服务端 26 类样本全部匹配 schema
 *  3. 拒绝路径：parseWSClientMessage 对非法 JSON / 非对象 / 未知 type / 形状非法的拒绝，
 *     以及附加字段容忍（兼容策略 3）
 *  4. 端到端：真实 setupWebSocket + ws 客户端（mock pi session，复用 X4 链路① harness），
 *     未知/非法入站被拒回 error、合法入站不被拒、服务端实发消息逐条匹配 schema
 *  5. 无重复定义回归防护：ws-handler.ts / useChat.ts 不得重建内联消息类型
 *
 * 本文件纳入 `npm run verify`（verify:integration = vitest run）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket as WsClient } from "ws";
import { Value } from "typebox/value";

// ── mock 依赖：与 tests/integration/ws-handler.test.ts 同构（pi session / agent / 模型配置）──

vi.mock("../../server/agent.js", () => {
  const fakeSession = {
    sessionId: "sess-x2-mock",
    isStreaming: false,
    subscribe: () => () => {},
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

vi.mock("../../server/models-config.js", () => ({
  __esModule: true,
  readModelsConfig: vi.fn(async () => ({ providers: {} })),
  writeModelsConfig: vi.fn(async () => {}),
  createDefaultModelsConfig: vi.fn(async () => {}),
  maskModelsConfig: (c: unknown) => c,
}));

import { setupWebSocket } from "../../server/ws-handler.js";
import { permissionManager } from "../../server/permission-manager.js";
import {
  PROTOCOL_VERSION,
  PROTOCOL_ID_PREFIX,
  WS_PROTOCOL,
  WSClientMessageSchema,
  WSServerMessageSchema,
  parseWSClientMessage,
  type WSClientMessage,
  type WSServerMessage,
} from "../../src/types/ws-protocol.js";

// ── 合法样本（编译期即对齐契约：字面量赋值给联合类型）───────────────────────────

const clientSamples: WSClientMessage[] = [
  { type: "prompt", content: "统计订单金额", referencedNodes: [{ nodeId: "gov-1", label: "orders", type: "sourceTable", data: "SELECT * FROM orders" }], clientMsgId: "msg-1" },
  { type: "steer", content: "换个维度", clientMsgId: "msg-2" },
  { type: "followUp", content: "继续", clientMsgId: "msg-3" },
  { type: "abort" },
  { type: "observe_list" },
  { type: "observe_info" },
  { type: "clear" },
  { type: "tool_permission_response", requestId: "pd-1", decision: "edit", editedCommand: "govio-cli observe info --rows 10", reason: "只取必要行" },
  { type: "permission_accept_all" },
  { type: "get_models_config" },
  { type: "save_models_config", apiKey: "sk-test" },
  { type: "set_model", provider: "anthropic", modelId: "claude-x" },
  { type: "session_list" },
  { type: "session_open", path: "C:/app/.govio/sessions/s.jsonl" },
  { type: "session_messages", beforeEntryId: "entry-1" },
  { type: "session_delete", path: "C:/app/.govio/sessions/s.jsonl" },
  { type: "canvas_save", nodes: [{ id: "n1" }], edges: [{ id: "e1" }] },
  { type: "canvas_fork_apply", forkId: "0123456789abcdef0123456789abcdef" },
];

const serverSamples: WSServerMessage[] = [
  { type: "session_ready", sessionId: "sess-1" },
  { type: "canvas_restore", nodes: [{ id: "n1" }], edges: [] },
  { type: "session_messages_result", messages: [{ id: "m1", role: "user", content: "hi", referencedNodes: [{ nodeId: "n1", label: "orders", type: "sourceTable", data: null }] }], hasMore: false, oldestEntryId: null, replace: true },
  { type: "session_list_result", sessions: [{ id: "s1", path: "p", name: null, preview: "hi", messageCount: 3, modified: "2026-01-01T00:00:00.000Z" }] },
  { type: "session_deleted", path: "p" },
  { type: "agent_start" },
  { type: "agent_end" },
  { type: "message_start" },
  { type: "message_end" },
  { type: "text_delta", content: "SELECT 1" },
  { type: "thinking_delta", content: "用户想看趋势" },
  { type: "tool_start", toolName: "bash", toolCallId: "tc-1", args: { command: "govio-cli observe list" } },
  { type: "tool_end", toolName: "bash", toolCallId: "tc-1", success: true },
  { type: "queue_update", pendingSteering: 1, pendingFollowUp: 0 },
  { type: "steer_queued", clientMsgId: "msg-1", disposition: "steered", pendingSteering: 0, pendingFollowUp: 0 },
  { type: "followUp_queued", clientMsgId: "msg-2", disposition: "queued", pendingSteering: 0, pendingFollowUp: 1 },
  { type: "queue_cleared", clearedSteering: 1, clearedFollowUp: 0 },
  { type: "tool_permission_request", requestId: "pd-1", command: "govio-cli observe load -o x.parquet" },
  { type: "observe_list_result", dataframes: [{ name: "df1", rows: 10, columns: 2 }] },
  { type: "observe_info_result", info: { datasources: ["chocolate"], dataframes: { dataframes: [{ name: "df1", rows: 10, columns: 2, column_info: [{ name: "id", dtype: "INTEGER" }] }] } } },
  { type: "models_config", config: { providers: { anthropic: { baseUrl: "https://x", api: "anthropic-messages", apiKey: "sk-masked", models: [{ id: "claude-x", name: "Claude X" }] } } } },
  { type: "config_saved" },
  { type: "config_required" },
  { type: "model_set", provider: "anthropic", modelId: "claude-x" },
  { type: "fork_applied", forkId: "0123456789abcdef0123456789abcdef", forkFrom: { kind: "share", shareId: "0123456789abcdef0123456789abcdef", canvasId: "2026-11-14T00-00-00-000Z_sess-x", sessionName: null, sharedAt: "2026-11-14T00:00:00.000Z", forkedAt: "2026-11-14T01:00:00.000Z" } },
  { type: "error", message: "boom" },
];

// ── 测试工具 ────────────────────────────────────────────────────────────────

interface WireMsg { type: string; [k: string]: unknown }

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
    ws.on("error", () => {});
  }
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

function connectWithCollector(port: number): Promise<{ ws: WsClient; col: Collector }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${port}/ws`);
    const col = new Collector();
    col.attach(ws);
    ws.on("open", () => resolve({ ws, col }));
    ws.on("error", reject);
  });
}

// ── 1. 契约注册表 ───────────────────────────────────────────────────────────

describe("契约注册表：版本化 schema 与消息全集", () => {
  it("PROTOCOL_VERSION 与注册表 version 字段一致（版本化 schema 落地）", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(WS_PROTOCOL.version).toBe(1);
    expect(PROTOCOL_ID_PREFIX).toBe("govio-ws/v1");
  });

  it("每条消息 schema 携带 $id（govio-ws/v1/<type>）与 version 字段", () => {
    for (const [type, schema] of Object.entries(WS_PROTOCOL.client)) {
      expect((schema as { $id?: string }).$id).toBe(`${PROTOCOL_ID_PREFIX}/${type}`);
      expect((schema as { version?: number }).version).toBe(PROTOCOL_VERSION);
    }
    for (const [type, schema] of Object.entries(WS_PROTOCOL.server)) {
      expect((schema as { $id?: string }).$id).toBe(`${PROTOCOL_ID_PREFIX}/${type}`);
      expect((schema as { version?: number }).version).toBe(PROTOCOL_VERSION);
    }
  });

  it("客户端消息全集 18 类、服务端 26 类，与合法样本清单双向对齐（漂移防护）", () => {
    const clientTypes = Object.keys(WS_PROTOCOL.client).sort();
    const serverTypes = Object.keys(WS_PROTOCOL.server).sort();
    expect(clientTypes).toEqual([...new Set(clientSamples.map((s) => s.type))].sort());
    expect(serverTypes).toEqual([...new Set(serverSamples.map((s) => s.type))].sort());
    expect(clientTypes.length).toBe(18);
    expect(serverTypes.length).toBe(26);
  });
});

// ── 2. 合法收发匹配 schema ──────────────────────────────────────────────────

describe("合法消息匹配 schema（收发两端）", () => {
  it("客户端 18 类样本全部通过 WSClientMessageSchema（含联合与各成员）", () => {
    for (const sample of clientSamples) {
      expect(Value.Check(WSClientMessageSchema, sample), `${sample.type} 应通过联合校验`).toBe(true);
      const member = WS_PROTOCOL.client[sample.type];
      expect(Value.Check(member, sample), `${sample.type} 应通过成员校验`).toBe(true);
    }
  });

  it("服务端 25 类样本全部通过 WSServerMessageSchema（含联合与各成员）", () => {
    for (const sample of serverSamples) {
      expect(Value.Check(WSServerMessageSchema, sample), `${sample.type} 应通过联合校验`).toBe(true);
      const member = WS_PROTOCOL.server[sample.type];
      expect(Value.Check(member, sample), `${sample.type} 应通过成员校验`).toBe(true);
    }
  });

  it("兼容策略 3：附加字段不拒（旧端容忍新消息加字段）", () => {
    const withExtras = { type: "prompt", content: "hi", futureField: 42, extra: { deep: true } };
    expect(Value.Check(WSClientMessageSchema, withExtras)).toBe(true);
    expect(parseWSClientMessage(JSON.stringify(withExtras)).ok).toBe(true);
    const serverWithExtras = { type: "error", message: "x", futureField: 1 };
    expect(Value.Check(WSServerMessageSchema, serverWithExtras)).toBe(true);
  });

  it("兼容策略 4：字段缺省不拒（业务必填仍由 handler guard 拦截）", () => {
    expect(parseWSClientMessage(JSON.stringify({ type: "prompt" })).ok).toBe(true);
    expect(parseWSClientMessage(JSON.stringify({ type: "session_open" })).ok).toBe(true);
  });
});

// ── 3. 拒绝路径（解析层） ───────────────────────────────────────────────────

describe("parseWSClientMessage 拒绝路径", () => {
  it("非法 JSON：error 文案为 String(err)（与改造前回包逐字节一致）", () => {
    const r = parseWSClientMessage("{not valid json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.startsWith("SyntaxError:")).toBe(true);
  });

  it("非对象 JSON（数字/字符串/数组）被拒", () => {
    for (const raw of ["5", '"str"', "[]", "null"]) {
      const r = parseWSClientMessage(raw);
      expect(r.ok, `${raw} 应被拒`).toBe(false);
      if (!r.ok) expect(r.error).toContain("unknown message type");
    }
  });

  it("未知消息 type 被拒并点名 type", () => {
    const r = parseWSClientMessage(JSON.stringify({ type: "bogus_message", foo: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown message type: bogus_message");
  });

  it("缺 type 被拒", () => {
    const r = parseWSClientMessage(JSON.stringify({ content: "hi" }));
    expect(r.ok).toBe(false);
  });

  it("形状非法（字段类型不符）被拒：content 数字 / decision 非法字面量 / referencedNodes 非数组", () => {
    const cases = [
      { type: "prompt", content: 123 },
      { type: "tool_permission_response", requestId: "pd-1", decision: "maybe" },
      { type: "prompt", content: "hi", referencedNodes: "not-an-array" },
      { type: "canvas_save", nodes: "not-an-array" },
      { type: "session_messages", beforeEntryId: 42 },
    ];
    for (const c of cases) {
      const r = parseWSClientMessage(JSON.stringify(c));
      expect(r.ok, `${JSON.stringify(c)} 应被拒`).toBe(false);
      if (!r.ok) expect(r.error).toContain("invalid message");
    }
  });

  it("合法消息解析原样返回", () => {
    const r = parseWSClientMessage(JSON.stringify({ type: "prompt", content: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual({ type: "prompt", content: "hi" });
  });
});

// ── 4. 端到端：真实 ws 通道 ─────────────────────────────────────────────────

describe("端到端：入站拒绝路径 + 服务端实发消息匹配 schema", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    setupWebSocket(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
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

  it("未知消息 type → 回 error「unknown message type」，连接不断", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");
    ws.send(JSON.stringify({ type: "totally_new_message" }));
    const err = await col.waitFor((m) => m.type === "error");
    expect(err.message).toBe("unknown message type: totally_new_message");
    // 连接仍可用：合法消息继续被处理
    ws.send(JSON.stringify({ type: "abort" }));
    await col.waitFor((m) => m.type === "queue_cleared");
    ws.close();
  });

  it("形状非法 → 回 error「invalid message」", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");
    ws.send(JSON.stringify({ type: "set_model", provider: 42, modelId: true }));
    const err = await col.waitFor((m) => m.type === "error");
    expect(err.message).toContain("invalid message");
    expect(err.message).toContain("set_model");
    ws.close();
  });

  it("非法 JSON → 回 error（String(err) 原文案保留）", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");
    ws.send("{not valid json");
    const err = await col.waitFor((m) => m.type === "error");
    expect(String(err.message).startsWith("SyntaxError:")).toBe(true);
    ws.close();
  });

  it("合法消息不被拒：prompt 进 session.prompt、canvas_save 静默、steer 回 steer_queued", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    ws.send(JSON.stringify({ type: "prompt", content: "统计订单", extraFutureField: 1 }));
    ws.send(JSON.stringify({ type: "canvas_save", nodes: [{ id: "n1" }], edges: [] }));
    ws.send(JSON.stringify({ type: "steer", content: "加个维度", clientMsgId: "msg-9" }));

    const queued = await col.waitFor((m) => m.type === "steer_queued");
    expect(queued.clientMsgId).toBe("msg-9");
    await vi.waitFor(() => {
      const rejected = col.messages.filter((m) => m.type === "error");
      expect(rejected).toHaveLength(0);
    });
    ws.close();
  });

  it("服务端实发的每条消息都匹配 WSServerMessageSchema（合法收发实证）", async () => {
    const { ws, col } = await connectWithCollector(port);
    await col.waitFor((m) => m.type === "session_ready");

    // 驱动多条真实链路：配置拉取 / 权限请求 / abort / 模型切换回执 / 未知消息 error
    ws.send(JSON.stringify({ type: "get_models_config" }));
    ws.send(JSON.stringify({ type: "permission_accept_all" }));
    permissionManager.requestPermission("govio-cli observe info --rows 1", "call-x2");
    ws.send(JSON.stringify({ type: "abort" }));
    ws.send(JSON.stringify({ type: "set_model", provider: "mock", modelId: "mock-model" }));
    ws.send(JSON.stringify({ type: "bogus_for_error_path" }));

    await col.waitFor((m) => m.type === "queue_cleared");
    await col.waitFor((m) => m.type === "model_set");
    await col.waitFor((m) => m.type === "error");
    await new Promise((r) => setTimeout(r, 50));

    const observed = col.messages.filter((m) => !m.type.startsWith("__"));
    expect(observed.length).toBeGreaterThanOrEqual(6);
    for (const m of observed) {
      expect(Value.Check(WSServerMessageSchema, m), `实发消息应匹配 schema: ${JSON.stringify(m)}`).toBe(true);
    }
    const types = new Set(observed.map((m) => m.type));
    for (const t of ["session_ready", "models_config", "queue_cleared", "model_set", "error"]) {
      expect(types.has(t), `实发链路应覆盖 ${t}`).toBe(true);
    }
    ws.close();
  });
});

// ── 5. 无重复定义回归防护 ───────────────────────────────────────────────────

describe("无重复定义：内联消息类型不得重建", () => {
  it("ws-handler.ts 不再内联 WSMessage、useChat.ts 不再内联 WSEvent，双端经契约单一来源", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const wsHandler = readFileSync(resolve(here, "../../server/ws-handler.ts"), "utf-8");
    const useChat = readFileSync(resolve(here, "../../src/hooks/useChat.ts"), "utf-8");
    expect(wsHandler).not.toContain("interface WSMessage");
    expect(useChat).not.toContain("interface WSEvent");
    expect(wsHandler).toContain("parseWSClientMessage(");
    expect(wsHandler).toContain("sendMsg(ws, ");
    expect(useChat).toContain("sendClientMessage(ws, ");
  });
});
