import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import { handleParquetApi } from "./parquet-api.js";
import { agentSetup } from "./agent.js";
import { ensureModelsConfig } from "./models-config.js";
import { LOOPBACK_HOST } from "./security.js";
import { prewarmInjectionGraphCache } from "./prompt-injection.js";

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
 * on a single port. Used by the Vite dev plugin (dev) and server/serve.ts
 * (npx production launch) so both share identical backend behavior.
 */
export async function startBackend(port = 5174) {
  const httpServer = createServer(async (req, res) => {
    if (await handleParquetApi(req, res)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  setupWebSocket(httpServer);

  await new Promise<void>((resolve) => {
    // Bind to loopback only: the backend drives an AI agent with shell access
    // and must never be reachable from the LAN.
    httpServer.listen(port, LOOPBACK_HOST, resolve);
  });
  console.log(`[ws] WebSocket + API server on ${LOOPBACK_HOST}:${port}`);

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

  // 图谱注入缓存预热（后台、不阻塞；失败静默）：否则首次 prompt 要承担
  // 3~4 条 govio-cli 冷启动（2.5~4.3s/条），负载下集体撞超时 → 图谱实体缺失。
  prewarmInjectionGraphCache();

  return httpServer;
}
