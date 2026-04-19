import { createAgentSession, SessionManager, readOnlyTools, type AgentSession } from "@mariozechner/pi-coding-agent";

let session: AgentSession | null = null;

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;

  const result = await createAgentSession({
    tools: readOnlyTools,
    sessionManager: SessionManager.inMemory(),
  });

  session = result.session;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}
