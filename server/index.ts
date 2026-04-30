import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import { handleParquetApi } from "./parquet-api.js";
import { agentSetup } from "./agent.js";
import type { Plugin } from "vite";

let httpServer: ReturnType<typeof createServer> | null = null;

export function wsPlugin(): Plugin {
  return {
    name: "ws-plugin",
    configureServer(server) {
      httpServer = createServer(async (req, res) => {
        if (await handleParquetApi(req, res)) return;
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
      setupWebSocket(httpServer);

      server.httpServer?.on("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          httpServer?.listen(address.port + 1, async () => {
            console.log(`[ws] WebSocket + API server on port ${address.port + 1}`);
            try {
              await agentSetup();
              console.log("[agent] Agent setup complete");
            } catch (err) {
              console.error("[agent] Agent setup failed:", err);
            }
          });
        }
      });
    },
  };
}
