import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { getOrCreateSession, resetSession, runGovioCli } from "./agent.js";
import { flushGovioNodes, emitFlushed, onGovioNodesFlushed, setCurrentReferencedNodes, clearCurrentReferencedNodes, type GovioNodeCreateEvent } from "./govio-node-queue.js";
import { permissionManager, type PermissionDecision } from "./permission-manager.js";
import { isAgentConfigNeeded, completeAgentSetup } from "./backend.js";
import { readModelsConfig, writeModelsConfig, createDefaultModelsConfig } from "./models-config.js";
import type { ModelsConfig } from "../src/types/models-config.js";

interface WSMessage {
  type: "prompt" | "steer" | "followUp" | "abort" | "observe_list" | "observe_info" | "clear" | "tool_permission_response" | "permission_accept_all" | "get_models_config" | "save_models_config" | "set_model";
  content?: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type: string; data?: string }>;
  requestId?: string;
  decision?: PermissionDecision;
  editedCommand?: string;
  reason?: string;
  config?: ModelsConfig;
  apiKey?: string;
  provider?: string;
  modelId?: string;
}

type SessionInstance = Awaited<ReturnType<typeof getOrCreateSession>>;

export function setupWebSocket(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);

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
            ws.send(JSON.stringify({ type: "agent_start" }));
            break;
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              ws.send(JSON.stringify({ type: "text_delta", content: event.assistantMessageEvent.delta }));
            } else if (event.assistantMessageEvent.type === "thinking_delta") {
              ws.send(JSON.stringify({ type: "thinking_delta", content: event.assistantMessageEvent.delta }));
            }
            break;
          case "tool_execution_start":
            ws.send(JSON.stringify({ type: "tool_start", toolName: event.toolName }));
            break;
          case "tool_execution_end":
            console.log(`[ws] Tool execution end: ${event.toolName} success=${!event.isError}`);
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            emitFlushed(flushGovioNodes());
            break;
          case "message_start":
            if (event.message.role === "assistant") {
              ws.send(JSON.stringify({ type: "message_start" }));
            }
            break;
          case "message_end":
            if (event.message.role === "assistant") {
              ws.send(JSON.stringify({ type: "message_end" }));
              emitFlushed(flushGovioNodes());
            }
            break;
          case "agent_end":
            console.log("[ws] Agent session ended");
            ws.send(JSON.stringify({ type: "agent_end" }));
            break;
        }
      } catch (err) {
        console.error("[ws] Subscribe callback error:", err);
      }
    });

    const unsubPermission = permissionManager.onRequest((req) => {
      try {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "tool_permission_request",
          requestId: req.requestId,
          command: req.command,
        }));
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
      ws.send(JSON.stringify({ type: "models_config", config }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        message: `Failed to read models config: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }

  async function handleSaveModelsConfig(ws: WebSocket, msg: WSMessage): Promise<void> {
    try {
      if (msg.apiKey) {
        // First-time setup path: frontend only supplies an API key.
        await createDefaultModelsConfig(msg.apiKey);
      } else if (msg.config) {
        await writeModelsConfig(msg.config);
      } else {
        ws.send(JSON.stringify({ type: "error", message: "save_models_config requires apiKey or config" }));
        return;
      }

      ws.send(JSON.stringify({ type: "config_saved" }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: "error",
        message: `Failed to save models config: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }

  async function restartAgentSession(): Promise<SessionInstance> {
    if (isAgentConfigNeeded()) {
      await completeAgentSetup();
    } else {
      resetSession();
    }
    return getOrCreateSession();
  }

  function handleNormalMessage(
    msg: WSMessage,
    ws: WebSocket,
    ctx: { session: SessionInstance; unsubscribe: () => void }
  ) {
    const { session, unsubscribe } = ctx;

    switch (msg.type) {
      case "prompt":
        if (msg.content) {
          setCurrentReferencedNodes(msg.referencedNodes);
          const prompt = makePrompt(msg);
          if (session.isStreaming) {
            session.steer(prompt).finally(clearCurrentReferencedNodes);
          } else {
            session.prompt(prompt).finally(clearCurrentReferencedNodes);
          }
        }
        break;
      case "steer":
        if (msg.content) session.steer(msg.content);
        break;
      case "followUp":
        if (msg.content) session.followUp(msg.content);
        break;
      case "abort":
        session.abort();
        permissionManager.denyPending("用户中止");
        break;
      case "observe_list": {
        runGovioCli("observe list")
          .then((output) => {
            const dataframes = JSON.parse(output);
            ws.send(JSON.stringify({ type: "observe_list_result", dataframes }));
          })
          .catch((listErr) => {
            ws.send(JSON.stringify({
              type: "error",
              message: `observe list failed: ${listErr instanceof Error ? listErr.message : String(listErr)}`,
            }));
          });
        break;
      }
      case "observe_info": {
        runGovioCli("observe info", true)
          .then((output) => {
            const info = JSON.parse(output);
            ws.send(JSON.stringify({ type: "observe_info_result", info }));
          })
          .catch((infoErr) => {
            ws.send(JSON.stringify({
              type: "error",
              message: `observe info failed: ${infoErr instanceof Error ? infoErr.message : String(infoErr)}`,
            }));
          });
        break;
      }
      case "set_model": {
        const { provider, modelId } = msg;
        if (!provider || !modelId) {
          ws.send(JSON.stringify({ type: "error", message: "set_model requires provider and modelId" }));
          break;
        }
        const model = ctx.session.modelRuntime.getModel(provider, modelId);
        if (!model) {
          ws.send(JSON.stringify({ type: "error", message: `Model not found: ${provider}/${modelId}` }));
          break;
        }
        ctx.session.setModel(model)
          .then(() => {
            ws.send(JSON.stringify({ type: "model_set", provider, modelId }));
          })
          .catch((modelErr) => {
            ws.send(JSON.stringify({
              type: "error",
              message: `set_model failed: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`,
            }));
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
          ws.send(JSON.stringify({ type: "session_ready", sessionId: newSession.sessionId }));
        });
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
            ws.send(JSON.stringify({ type: "session_ready", sessionId: newSession.sessionId }));
          });
        });
        break;
      }
    }
  }

  wss.on("connection", async (ws: WebSocket) => {
    try {
      if (isAgentConfigNeeded()) {
        ws.send(JSON.stringify({ type: "config_required" }));

        ws.on("message", async (data: Buffer) => {
          try {
            const msg: WSMessage = JSON.parse(data.toString());
            switch (msg.type) {
              case "get_models_config":
                await sendModelsConfig(ws);
                break;
              case "save_models_config": {
                await handleSaveModelsConfig(ws, msg);
                const session = await restartAgentSession();
                const unsubscribe = subscribeToSession(session, ws);
                ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));

                const ctx = { session, unsubscribe };
                ws.removeAllListeners("message");
                ws.on("message", (data: Buffer) => {
                  try {
                    const msg: WSMessage = JSON.parse(data.toString());
                    handleNormalMessage(msg, ws, ctx);
                  } catch (err) {
                    ws.send(JSON.stringify({ type: "error", message: String(err) }));
                  }
                });
                ws.on("close", () => {
                  unsubscribe();
                });
                break;
              }
            }
          } catch (err) {
            ws.send(JSON.stringify({ type: "error", message: String(err) }));
          }
        });
        return;
      }

      const session = await getOrCreateSession();
      const unsubscribe = subscribeToSession(session, ws);
      ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));

      const ctx = { session, unsubscribe };

      ws.on("message", (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());
          handleNormalMessage(msg, ws, ctx);
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        }
      });

      ws.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Session init failed: ${err}` }));
      ws.close();
    }
  });

  return wss;
}

function makePrompt(msg: WSMessage): string {
  let prompt = "";
  if (msg.referencedNodes) {
    prompt += "REF:[";
    for (const ref of msg.referencedNodes) {
      const s = `{"${ref.label}": "${ref.data}"},`;
      prompt += s;
    }
    prompt += "]\n";
  }
  prompt += msg.content;
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
