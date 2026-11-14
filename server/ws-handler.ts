import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { getOrCreateSession, resetSession, openSessionFile, runGovioCli } from "./agent.js";
import { listSessions, deleteSession, saveCanvas, loadCanvas, buildTranscript, assertValidSessionPath } from "./session-history.js";
import { refreshCanvasFromRemote } from "./storage/canvas-storage.js";
import { consumeStagedFork, readStagedFork } from "./share.js";
import { buildInjectionContext, composePrompt, buildTraceEntry, recordInjectionTrace } from "./prompt-injection.js";
import { flushGovioNodes, emitFlushed, onGovioNodesFlushed, setCurrentReferencedNodes, clearCurrentReferencedNodes, type GovioNodeCreateEvent } from "./govio-node-queue.js";
import { setSessionSemanticRefs, setSessionCaliberMetrics, clearSessionSemanticRefs, toSemanticRefs } from "./semantic-context.js";
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
            // 口径引用生命周期终点：本轮 agent 运行结束（所有 message_end 已派发完）。
            // 不能在 steer/followUp 或 prompt dispatch 的 finally 里清：
            // - steer/followUp 属于**同一次运行**的补充指令，其后续 SQL 仍属于本轮注入上下文；
            // - prompt/steer 入队即 resolve，finally 早于 message_end（旧 bug）。
            // 清在此处可保证「未注入的新运行不继承上一轮口径」。
            clearSessionSemanticRefs(s.sessionId);
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

  async function pushSessionState(ws: WebSocket, session: SessionInstance) {
    sendMsg(ws, { type: "session_ready", sessionId: session.sessionId });
    try {
      const file = session.sessionManager.getSessionFile();
      if (!file) return;
      // T3.1：绑定 S3 的画布在打开前拉取远端最新（无绑定 = no-op；失败降级本地缓存，
      // 错误只进日志，不阻塞会话打开）。
      const refresh = await refreshCanvasFromRemote(file);
      if (refresh.error) console.warn(`[ws] canvas remote refresh failed: ${refresh.error}`);
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
            .finally(() => {
              clearCurrentReferencedNodes();
              // 不在此清 semanticRefs/caliberMetrics！流式中消息走 steer 排队，
              // session.prompt()/steer() 会**排队后立即 resolve**，message_end 还没发生；
              // 此处清理会让延后触发的 message_end 取不到口径引用（实测：
              // 注入 trace 有实体但 sqlQuery 节点 semanticRefs 恒为空）。
              // 改为「下一轮 makePrompt 覆盖」，并在不注入的 steer/followUp 分支清理。
            });
        }
        break;
      case "steer":
        if (msg.content) {
          // steer 属于本轮运行的补充指令（同一次注入上下文）→ **不清**口径引用，
          // 否则本轮后续产出的 SQL 会丢 semanticRefs（实测：steer 后 5s 生成的 SQL 无口径）。
          // 清理统一由 agent_end 负责。
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
          // followUp 同样不注入，但属本轮补充 → 不清口径引用（统一由 agent_end 处理）
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
      case "canvas_fork_apply": {
        // T3.2 fork 续写：把分享 fork 的暂存副本应用到当前（本地新）会话，
        // 画布级血缘 forkFrom 进 canvas.json 顶层；只读分享视图不走本通道，
        // 因此不存在写回源画布的路径。
        const file = ctx.session.sessionManager.getSessionFile();
        if (!file) {
          sendMsg(ws, { type: "error", message: "canvas_fork_apply requires an active session" });
          break;
        }
        if (!msg.forkId) {
          sendMsg(ws, { type: "error", message: "canvas_fork_apply requires forkId" });
          break;
        }
        const staged = readStagedFork(msg.forkId);
        if (!staged) {
          sendMsg(ws, { type: "error", message: `unknown or expired fork: ${msg.forkId}` });
          break;
        }
        try {
          saveCanvas(file, staged.canvas.nodes, staged.canvas.edges, { forkFrom: staged.forkFrom });
          consumeStagedFork(staged.forkId);
          sendMsg(ws, { type: "fork_applied", forkId: staged.forkId, forkFrom: staged.forkFrom });
          sendMsg(ws, { type: "canvas_restore", nodes: staged.canvas.nodes, edges: staged.canvas.edges });
        } catch (err) {
          sendMsg(ws, { type: "error", message: `canvas_fork_apply failed: ${err instanceof Error ? err.message : String(err)}` });
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
  // T2.2 语义引用归因：本轮注入的图谱实体暂存为「本会话最近一次注入上下文」，
  // message_end 建 sqlQuery 节点时取来写入 semanticRefs（空则不写键）。
  setSessionSemanticRefs(session.sessionId, toSemanticRefs(ctx.graphEntities));
  // T2.3 口径检测目标：仅问题点名的指标（表相关但未点名的拿去检测会误报黄灯）
  setSessionCaliberMetrics(session.sessionId, ctx.caliberMetrics ?? []);
  // 注入留痕：被注入节点 + 图谱实体 ID 列表随会话 sidecar 持久化（append-only）。
  // degraded 也留痕：纯问题命中场（无引用节点）注入失败若不留痕会静默丢失可诊断性
  //（BUGFIX-injection-graph-key：2026-11-08 会话中失败完全无痕）。
  if (sessionFile && (ctx.tables.length > 0 || ctx.graphEntities.length > 0 || ctx.graphStatus === "degraded")) {
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
