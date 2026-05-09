import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { getOrCreateSession, resetSession, runGovioCli } from "./agent.js";
import { flushGovioNodes, emitFlushed, onGovioNodesFlushed, setCurrentReferencedNodes, clearCurrentReferencedNodes, type GovioNodeCreateEvent } from "./govio-node-queue.js";

interface WSMessage {
  type: "prompt" | "steer" | "followUp" | "abort" | "observe_list" | "clear";
  content?: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type: string; data?: string }>;
}

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

  function subscribeToSession(s: Awaited<ReturnType<typeof getOrCreateSession>>, ws: WebSocket) {
    return s.subscribe((event) => {
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
  }

  wss.on("connection", async (ws: WebSocket) => {
    try {
      let session = await getOrCreateSession();
      let unsubscribe = subscribeToSession(session, ws);
      ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));

      ws.on("message", async (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());

          switch (msg.type) {
            case "prompt":
              if (msg.content) {
                setCurrentReferencedNodes(msg.referencedNodes);
                const prompt = makePrompt(msg);
                if (session.isStreaming) {
                  await session.steer(prompt);
                } else {
                  await session.prompt(prompt);
                }
                clearCurrentReferencedNodes();
              }
              break;
            case "steer":
              if (msg.content) await session.steer(msg.content);
              break;
            case "followUp":
              if (msg.content) await session.followUp(msg.content);
              break;
            case "abort":
              await session.abort();
              break;
            case "observe_list": {
              try {
                const output = await runGovioCli("observe list");
                const dataframes = JSON.parse(output);
                ws.send(JSON.stringify({ type: "observe_list_result", dataframes }));
              } catch (listErr) {
                ws.send(JSON.stringify({
                  type: "error",
                  message: `observe list failed: ${listErr instanceof Error ? listErr.message : String(listErr)}`,
                }));
              }
              break;
            }
            case "clear": {
              unsubscribe();
              resetSession();
              const newSession = await getOrCreateSession();
              session = newSession;
              unsubscribe = subscribeToSession(newSession, ws);
              ws.send(JSON.stringify({ type: "session_ready", sessionId: newSession.sessionId }));
              break;
            }
          }
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

function makePrompt(msg:WSMessage):string {
  let prompt = "";
  if (msg.referencedNodes) {
    prompt += "REF:[";
    for(const ref of msg.referencedNodes) {
      const s = `{"${ref.label}": "${ref.data}"},`
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
