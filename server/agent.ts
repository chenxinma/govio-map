import { createAgentSession, SessionManager, readOnlyTools, type AgentSession } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";

let session: AgentSession | null = null;

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;

  const agentDir = join(homedir(), ".pi", "agent");

  const result = await createAgentSession({
    tools: readOnlyTools,
    sessionManager: SessionManager.inMemory(),
    agentDir,
  });

  session = result.session;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}
