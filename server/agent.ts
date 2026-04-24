import { createAgentSession, SessionManager, createCodingTools, DefaultResourceLoader, type AgentSession } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";


let session: AgentSession | null = null;

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;

  const loader = new DefaultResourceLoader({
    skillsOverride: (current) => {
      const filteredSkills = current.skills.filter(
        (s) => s.name.includes("browser") || s.name.includes("search") || s.name.includes("govio") || s.name.includes("observe"),
      );
      return {
        skills: [...filteredSkills],
        diagnostics: current.diagnostics,
      };
    },
  });
  await loader.reload();

  const agentDir = join(homedir(), ".pi", "agent");
  const { skills: allSkills, diagnostics } = loader.getSkills();
  console.log(
    "Discovered skills:",
    allSkills.map((s) => s.name),
  );
  if (diagnostics.length > 0) {
    console.log("Warnings:", diagnostics);
  }

  const cwd = process.cwd();

  const result = await createAgentSession({
    cwd,
    tools: createCodingTools(cwd),
    sessionManager: SessionManager.inMemory(),
    agentDir: agentDir,
    resourceLoader: loader,
  });

  session = result.session;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}
