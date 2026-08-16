import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import { handleParquetApi } from "./parquet-api.js";
import { agentSetup } from "./agent.js";
import { ensureModelsConfig } from "./models-config.js";

let agentConfigNeeded = false;

export function isAgentConfigNeeded(): boolean {
  return agentConfigNeeded;
}

export async function completeAgentSetup(): Promise<void> {
  agentConfigNeeded = false;
  try {
    await agentSetup();
    console.log("[agent] Agent setup complete");
  } catch (err) {
    console.error("[agent] Agent setup failed:", err);
    throw err;
  }
}

/**
 * Start the standalone backend: HTTP API (/api/preview) + WebSocket (/ws, /canvas)
 * on a single port. Used by the Vite dev plugin (dev) and the Electron main
 * process (production) so both share identical backend behavior.
 */
export async function startBackend(port = 5174) {
  const httpServer = createServer(async (req, res) => {
    if (await handleParquetApi(req, res)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  setupWebSocket(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, resolve);
  });
  console.log(`[ws] WebSocket + API server on port ${port}`);

  try {
    const hasConfig = await ensureModelsConfig();
    if (hasConfig) {
      await agentSetup();
      console.log("[agent] Agent setup complete");
    } else {
      agentConfigNeeded = true;
      console.log("[agent] LLM config required; waiting for frontend setup");
    }
  } catch (err) {
    console.error("[agent] Agent setup failed:", err);
  }

  return httpServer;
}
