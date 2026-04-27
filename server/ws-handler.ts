import { WebSocketServer, WebSocket } from "ws";
import { getOrCreateSession } from "./agent.js";
import { flushGovioNodes } from "./govio-node-queue.js";

interface WSMessage {
  type: "prompt" | "steer" | "followUp" | "abort";
  content?: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type: string }>;
}

export function setupWebSocket(server: import("http").Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket) => {
    try {
      const session = await getOrCreateSession();

      ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));

      const unsubscribe = session.subscribe((event) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        switch (event.type) {
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
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            for (const node of flushGovioNodes()) {
              ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
            }
            break;
          case "message_start":
            ws.send(JSON.stringify({ type: "message_start" }));
            break;
          case "message_end":
            ws.send(JSON.stringify({ type: "message_end" }));
            for (const node of flushGovioNodes()) {
              ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
            }
            break;
          case "agent_end":
            break;
        }
      });

      ws.on("message", async (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());

          switch (msg.type) {
            case "prompt":
              if (msg.content) {
                if (session.isStreaming) {
                  await session.steer(msg.content);
                } else {
                  await session.prompt(msg.content);
                }
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
