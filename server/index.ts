import type { Plugin } from "vite";
import { startBackend } from "./backend.js";

export function wsPlugin(): Plugin {
  return {
    name: "ws-plugin",
    configureServer(server) {
      server.httpServer?.on("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          startBackend(address.port + 1);
        }
      });
    },
  };
}
