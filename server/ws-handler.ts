import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { getOrCreateSession, resetSession, openSessionFile, runGovioCli } from "./agent.js";
import { listSessions, deleteSession, saveCanvas, loadCanvas, buildTranscript, assertValidSessionPath } from "./session-history.js";
import { buildInjectionContext, composePrompt, buildTraceEntry, recordInjectionTrace } from "./prompt-injection.js";
import { flushGovioNodes, emitFlushed, onGovioNodesFlushed, setCurrentReferencedNodes, clearCurrentReferencedNodes, type GovioNodeCreateEvent } from "./govio-node-queue.js";
import { permissionManager } from "./permission-manager.js";
import { isAgentConfigNeeded, completeAgentSetup } from "./backend.js";
import { readModelsConfig, writeModelsConfig, createDefaultModelsConfig, maskModelsConfig } from "./models-config.js";
import { isAllowedUpgrade } from "./security.js";
import { parseWSClientMessage, type WSClientMessage, type WSClientMessageOf, type WSServerMessage } from "../src/types/ws-protocol.js";

type SessionInstance = Awaited<ReturnType<typeof getOrCreateSession>>;

export function setupWebSocket(server: import("http").Server) {
  // Cap incoming frame size: canvas_save payloads are the largest legit message.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);

    // Reject cross-site WebSocket hijacking: browsers attach the page's Origin,
    // and only the local frontend is allowed to drive the agent.
    if (!isAllowedUpgrade(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else if (pathname === "/canvas") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleCanvasConnection(ws);
      });
    } else {
      socket.destroy();
    }
  });

  function subscribeToSession(s: SessionInstance, ws: WebSocket) {
    const unsubSession = s.subscribe((event) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        switch (event.type) {
          case "agent_start":
            console.log("[ws] Agent session started");
            sendMsg(ws, { type: "agent_start" });
            break;
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              sendMsg(ws, { type: "text_delta", content: event.assistantMessageEvent.delta });
            } else if (event.assistantMessageEvent.type === "thinking_delta") {
              sendMsg(ws, { type: "thinking_delta", content: event.assistantMessageEvent.delta });
            }
            break;
          case "tool_execution_start":
            // args 原样随事件体 JSON 序列化（不嵌套字符串，避免转义问题），
            // 前端 ToolRow 展开可见具体命令（bash 为 command，其它为 args JSON）。
            sendMsg(ws, { type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
            break;
          case "tool_execution_end":
            console.log(`[ws] Tool execution end: ${event.toolName} success=${!event.isError}`);
            console.debug(`[ws] Tool execution result (${event.toolName}):`, event.result);
            sendMsg(ws, { type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, success: !event.isError });
            emitFlushed(flushGovioNodes());
            break;
          case "message_start":
            if (event.message.role === "assistant") {
              sendMsg(ws, { type: "message_start" });
            }
            break;
          case "message_end":
            if (event.message.role === "assistant") {
              sendMsg(ws, { type: "message_end" });
              emitFlushed(flushGovioNodes());
            }
            break;
          case "agent_end":
            console.log("[ws] Agent session ended");
            sendMsg(ws, { type: "agent_end" });
            break;
          case "queue_update":
            // Steering / follow-up queue changed (a message was queued or
            // delivered). Lets the frontend show pending steering bubbles.
            sendMsg(ws, {
              type: "queue_update",
              pendingSteering: event.steering.length,
              pendingFollowUp: event.followUp.length,
            });
            break;
        }
      } catch (err) {
        console.error("[ws] Subscribe callback error:", err);
      }
    });

    const unsubPermission = permissionManager.onRequest((req) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        sendMsg(ws, {
          type: "tool_permission_request",
          requestId: req.requestId,
          command: req.command,
        });
      } catch (err) {
        console.error("[ws] Permission push error:", err);
      }
    });

    return () => {
      unsubSession();
      unsubPermission();
    };
  }

  async function sendModelsConfig(ws: WebSocket): Promise<void> {
    try {
      const config = await readModelsConfig();
      // Never ship real API keys to the frontend; masked placeholders are
      // merged back from disk on save (see models-config.ts).
      sendMsg(ws, { type: "models_config", config: maskModelsConfig(config) });
    } catch (err) {
      sendMsg(ws, {
        type: "error",
        message: `Failed to read models config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleSaveModelsConfig(ws: WebSocket, msg: WSClientMessageOf<"save_models_config">): Promise<void> {
    try {
      if (msg.apiKey) {
        // First-time setup path: frontend only supplies an API key.
        await createDefaultModelsConfig(msg.apiKey);
      } else if (msg.config) {
        await writeModelsConfig(msg.config);
      } else {
        sendMsg(ws, { type: "error", message: "save_models_config requires apiKey or config" });
        return;
      }

      sendMsg(ws, { type: "config_saved" });
    } catch (err) {
      sendMsg(ws, {
        type: "error",
        message: `Failed to save models config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function pushSessionState(ws: WebSocket, session: SessionInstance) {
    sendMsg(ws, { type: "session_ready", sessionId: session.sessionId });
    try {
      const file = session.sessionManager.getSessionFile();
      if (!file) return;
      const canvas = loadCanvas(file);
      if (canvas) {
        sendMsg(ws, { type: "canvas_restore", nodes: canvas.nodes, edges: canvas.edges });
      }
      const page = buildTranscript(session.sessionManager.getBranch());
      sendMsg(ws, { type: "session_messages_result", ...page, replace: true });
    } catch (err) {
      console.error("[ws] pushSessionState error:", err);
    }
  }

  async function restartAgentSession(): Promise<SessionInstance> {
    // 保存模型配置触发的会话重启与 clear/session_open 同等待遇：
    // 放行模式、挂起请求与决策索引都随旧会话失效。
    permissionManager.clearAll();
    if (isAgentConfigNeeded()) {
      await completeAgentSetup();
    } else {
      resetSession();
    }
    return getOrCreateSession();
  }

  function handleNormalMessage(
    msg: WSClientMessage,
    ws: WebSocket,
    ctx: { session: SessionInstance; unsubscribe: () => void }
  ) {
    const { session, unsubscribe } = ctx;

    switch (msg.type) {
      case "prompt":
        if (msg.content) {
          setCurrentReferencedNodes(msg.referencedNodes);
          // 注入（表限定名 + 图谱实体）需异步查图谱；makePrompt 内部永不 throw，
          // 图谱失败降级为现状行为（不阻断会话）。流式判定推迟到派发时刻。
          void (async () => {
            const prompt = await makePrompt(msg, session);
            if (session.isStreaming) {
              await session.steer(prompt);
            } else {
              await session.prompt(prompt);
            }
          })()
            .catch((err) => {
              console.error("[ws] prompt dispatch failed:", err);
            })
            .finally(clearCurrentReferencedNodes);
        }
        break;
      case "steer":
        if (msg.content) {
          // Steering message: inject into the currently running agent so it
          // takes effect before the next LLM call (after the current tool calls
          // finish). The clientMsgId lets the frontend mark its local bubble as
          // delivered once the queue accepts the message.
          const clientMsgId = msg.clientMsgId;
          session
            .steer(msg.content)
            .then((disposition) => {
              sendMsg(ws, {
                type: "steer_queued",
                clientMsgId,
                disposition,
                pendingSteering: session.getSteeringMessages().length,
                pendingFollowUp: session.getFollowUpMessages().length,
              });
            })
            .catch((err) => {
              sendMsg(ws, {
                type: "error",
                message: `steer failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
        }
        break;
      case "followUp":
        if (msg.content) {
          const clientMsgId = msg.clientMsgId;
          session
            .followUp(msg.content)
            .then((disposition) => {
              sendMsg(ws, {
                type: "followUp_queued",
                clientMsgId,
                disposition,
                pendingSteering: session.getSteeringMessages().length,
                pendingFollowUp: session.getFollowUpMessages().length,
              });
            })
            .catch((err) => {
              sendMsg(ws, {
                type: "error",
                message: `followUp failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
        }
        break;
      case "abort": {
        const cleared = session.clearQueue();
        session.abort();
        permissionManager.denyPending("用户中止");
        sendMsg(ws, {
          type: "queue_cleared",
          clearedSteering: cleared.steering.length,
          clearedFollowUp: cleared.followUp.length,
        });
        break;
      }
      case "observe_list": {
        runGovioCli("observe list")
          .then((output) => {
            const dataframes = JSON.parse(output);
            sendMsg(ws, { type: "observe_list_result", dataframes });
          })
          .catch((listErr) => {
            sendMsg(ws, {
              type: "error",
              message: `observe list failed: ${listErr instanceof Error ? listErr.message : String(listErr)}`,
            });
          });
        break;
      }
      case "observe_info": {
        runGovioCli("observe info", true)
          .then((output) => {
            const info = JSON.parse(output);
            sendMsg(ws, { type: "observe_info_result", info });
          })
          .catch((infoErr) => {
            sendMsg(ws, {
              type: "error",
              message: `observe info failed: ${infoErr instanceof Error ? infoErr.message : String(infoErr)}`,
            });
          });
        break;
      }
      case "set_model": {
        const { provider, modelId } = msg;
        if (!provider || !modelId) {
          sendMsg(ws, { type: "error", message: "set_model requires provider and modelId" });
          break;
        }
        const model = ctx.session.modelRuntime.getModel(provider, modelId);
        if (!model) {
          sendMsg(ws, { type: "error", message: `Model not found: ${provider}/${modelId}` });
          break;
        }
        ctx.session.setModel(model)
          .then(() => {
            sendMsg(ws, { type: "model_set", provider, modelId });
          })
          .catch((modelErr) => {
            sendMsg(ws, {
              type: "error",
              message: `set_model failed: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`,
            });
          });
        break;
      }
      case "clear": {
        unsubscribe();
        permissionManager.clearAll();
        resetSession();
        getOrCreateSession().then((newSession) => {
          ctx.session = newSession;
          ctx.unsubscribe = subscribeToSession(newSession, ws);
          pushSessionState(ws, newSession);
        });
        break;
      }
      case "session_list": {
        listSessions()
          .then((sessions) => sendMsg(ws, { type: "session_list_result", sessions }))
          .catch((err) => sendMsg(ws, { type: "error", message: `session_list failed: ${err}` }));
        break;
      }
      case "session_open": {
        if (!msg.path) {
          sendMsg(ws, { type: "error", message: "session_open requires path" });
          break;
        }
        let targetPath: string;
        try {
          // Same containment check as session_delete: clients may only open
          // session files inside the session directory.
          targetPath = assertValidSessionPath(msg.path);
        } catch (err) {
          sendMsg(ws, { type: "error", message: `session_open failed: ${err}` });
          break;
        }
        if (ctx.session.sessionManager.getSessionFile() === targetPath) {
          pushSessionState(ws, ctx.session);
          break;
        }
        try { ctx.session.abort(); } catch { /* not streaming */ }
        unsubscribe();
        permissionManager.clearAll();
        openSessionFile(targetPath)
          .then((newSession) => {
            ctx.session = newSession;
            ctx.unsubscribe = subscribeToSession(newSession, ws);
            pushSessionState(ws, newSession);
          })
          .catch((err) => {
            sendMsg(ws, { type: "error", message: `session_open failed: ${err}` });
            // Fall back to a fresh session so the chat stays usable.
            getOrCreateSession().then((newSession) => {
              ctx.session = newSession;
              ctx.unsubscribe = subscribeToSession(newSession, ws);
              pushSessionState(ws, newSession);
            });
          });
        break;
      }
      case "session_messages": {
        const file = ctx.session.sessionManager.getSessionFile();
        if (!file) {
          sendMsg(ws, { type: "session_messages_result", messages: [], hasMore: false, oldestEntryId: null, replace: false });
          break;
        }
        const page = buildTranscript(ctx.session.sessionManager.getBranch(), { beforeEntryId: msg.beforeEntryId });
        sendMsg(ws, { type: "session_messages_result", ...page, replace: false });
        break;
      }
      case "session_delete": {
        if (!msg.path) {
          sendMsg(ws, { type: "error", message: "session_delete requires path" });
          break;
        }
        if (msg.path === ctx.session.sessionManager.getSessionFile()) {
          sendMsg(ws, { type: "error", message: "cannot delete the active session" });
          break;
        }
        try {
          deleteSession(msg.path);
          sendMsg(ws, { type: "session_deleted", path: msg.path });
        } catch (err) {
          sendMsg(ws, { type: "error", message: `session_delete failed: ${err}` });
        }
        break;
      }
      case "canvas_save": {
        const file = ctx.session.sessionManager.getSessionFile();
        if (file) {
          try {
            saveCanvas(file, msg.nodes ?? [], msg.edges ?? []);
          } catch (err) {
            console.error("[ws] canvas_save failed:", err);
          }
        }
        break;
      }
      case "tool_permission_response": {
        if (msg.requestId && msg.decision) {
          permissionManager.resolve(msg.requestId, {
            decision: msg.decision,
            editedCommand: msg.editedCommand,
            reason: msg.reason,
          });
        }
        break;
      }
      case "permission_accept_all": {
        permissionManager.setAcceptAll(true);
        break;
      }
      case "get_models_config": {
        sendModelsConfig(ws);
        break;
      }
      case "save_models_config": {
        handleSaveModelsConfig(ws, msg).then(() => {
          unsubscribe();
          restartAgentSession().then((newSession) => {
            ctx.session = newSession;
            ctx.unsubscribe = subscribeToSession(newSession, ws);
            pushSessionState(ws, newSession);
          });
        });
        break;
      }
      default:
        assertNever(msg);
    }
  }

  wss.on("connection", async (ws: WebSocket) => {
    try {
      if (isAgentConfigNeeded()) {
        sendMsg(ws, { type: "config_required" });

        ws.on("message", async (data: Buffer) => {
          try {
            const parsed = parseWSClientMessage(data.toString());
            if (!parsed.ok) {
              sendMsg(ws, { type: "error", message: parsed.error });
              return;
            }
            const msg = parsed.message;
            switch (msg.type) {
              case "get_models_config":
                await sendModelsConfig(ws);
                break;
              case "save_models_config": {
                await handleSaveModelsConfig(ws, msg);
                const session = await restartAgentSession();
                const unsubscribe = subscribeToSession(session, ws);
                pushSessionState(ws, session);

                const ctx = { session, unsubscribe };
                ws.removeAllListeners("message");
                ws.on("message", (data: Buffer) => {
                  try {
                    const parsed = parseWSClientMessage(data.toString());
                    if (!parsed.ok) {
                      sendMsg(ws, { type: "error", message: parsed.error });
                      return;
                    }
                    handleNormalMessage(parsed.message, ws, ctx);
                  } catch (err) {
                    sendMsg(ws, { type: "error", message: String(err) });
                  }
                });
                ws.on("close", () => {
                  unsubscribe();
                });
                break;
              }
            }
          } catch (err) {
            sendMsg(ws, { type: "error", message: String(err) });
          }
        });
        return;
      }

      const session = await getOrCreateSession();
      const unsubscribe = subscribeToSession(session, ws);
      pushSessionState(ws, session);

      const ctx = { session, unsubscribe };

      ws.on("message", (data: Buffer) => {
        try {
          const parsed = parseWSClientMessage(data.toString());
          if (!parsed.ok) {
            sendMsg(ws, { type: "error", message: parsed.error });
            return;
          }
          handleNormalMessage(parsed.message, ws, ctx);
        } catch (err) {
          sendMsg(ws, { type: "error", message: String(err) });
        }
      });

      ws.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      sendMsg(ws, { type: "error", message: `Session init failed: ${err}` });
      ws.close();
    }
  });

  return wss;
}

/**
 * /ws 出站消息统一出口：编译期对齐 WSServerMessage 契约（X2）。
 * JSON.stringify 输出与改造前逐字节一致；/canvas 通道不走本出口。
 */
function sendMsg(ws: WebSocket, msg: WSServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/** 编译期穷尽校验：WSClientMessage 新增消息类型必须在 handleNormalMessage 落 case，否则构建失败 */
function assertNever(x: never): never {
  throw new Error(`unexpected client message: ${JSON.stringify(x)}`);
}

async function makePrompt(msg: WSClientMessageOf<"prompt">, session: SessionInstance): Promise<string> {
  const sessionFile = session.sessionManager.getSessionFile() ?? null;
  // ① 表事实：消息内 ref.data + canvas sidecar 节点数据（含 T2.0 标注字段）合并
  // ② 图谱实体：govio-cli query，失败降级（graphStatus=degraded）
  const ctx = await buildInjectionContext({
    content: msg.content ?? "",
    referencedNodes: msg.referencedNodes,
    canvasNodes: sessionFile ? loadCanvas(sessionFile)?.nodes : undefined,
  });
  const prompt = composePrompt({ content: msg.content ?? "", referencedNodes: msg.referencedNodes }, ctx);
  // 注入留痕：被注入节点 + 图谱实体 ID 列表随会话 sidecar 持久化（append-only）
  if (sessionFile && (ctx.tables.length > 0 || ctx.graphEntities.length > 0)) {
    recordInjectionTrace(
      sessionFile,
      buildTraceEntry(ctx, { sessionId: session.sessionId, sessionFile, content: msg.content ?? "" }),
    );
  }
  console.debug("[ws] prompt: " + prompt);
  return prompt;
}

async function handleCanvasConnection(ws: WebSocket) {
  try {
    const session = await getOrCreateSession();

    ws.send(JSON.stringify({ type: "canvas_ready", sessionId: session.sessionId }));

    const unsubscribe = onGovioNodesFlushed((events: GovioNodeCreateEvent[]) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const node of events) {
          ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
        }
      } catch (err) {
        console.error("[canvas-ws] Flush callback error:", err);
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: `Canvas session init failed: ${err}` }));
    ws.close();
  }
}
