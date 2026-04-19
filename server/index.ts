import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import type { Plugin } from "vite";

let httpServer: ReturnType<typeof createServer> | null = null;

export function wsPlugin(): Plugin {
  return {
    name: "ws-plugin",
    configureServer(server) {
      httpServer = createServer();
      setupWebSocket(httpServer);

      server.httpServer?.on("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          httpServer?.listen(address.port + 1, () => {
            console.log(`[ws] WebSocket server on port ${address.port + 1}`);
          });
        }
      });
    },
  };
}
