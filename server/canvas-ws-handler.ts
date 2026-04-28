import { WebSocketServer, WebSocket } from "ws";
import { getOrCreateSession } from "./agent.js";
import { onGovioNodesFlushed, type GovioNodeCreateEvent } from "./govio-node-queue.js";

export function setupCanvasWebSocket(server: import("http").Server) {
  const wss = new WebSocketServer({ server, path: "/canvas" });

  wss.on("connection", async (ws: WebSocket) => {
    try {
      const session = await getOrCreateSession();

      ws.send(JSON.stringify({ type: "canvas_ready", sessionId: session.sessionId }));

      const unsubscribe = onGovioNodesFlushed((events: GovioNodeCreateEvent[]) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const node of events) {
          ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
        }
      });

      ws.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Canvas session init failed: ${err}` }));
      ws.close();
    }
  });

  return wss;
}
