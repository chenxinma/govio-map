import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type AgentSession } from "@earendil-works/pi-coding-agent";
import govioCanvasExtension from "./extensions/govio-canvas.js";


let session: AgentSession | null = null;
let resLoader: DefaultResourceLoader | null = null;

export async function agentSetup() {
  // Resolve cwd at call time so the Electron main process can chdir()
  // before the agent boots (module-level evaluation would be too early).
  const cwd = process.cwd();
  resLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: [
      (pi) => { govioCanvasExtension(pi); },
    ],
    skillsOverride: (current) => {
      const filteredSkills = current.skills.filter(
        (s) =>
          s.name.includes("browser") ||
          s.name.includes("search") ||
          s.name.includes("govio") ||
          s.name.includes("eda") ||
          s.name.includes("observe"),
      );
      return {
        skills: filteredSkills,
        diagnostics: current.diagnostics,
      };
    },
  });

  await resLoader.reload();

  const { skills: allSkills, diagnostics } = resLoader.getSkills();
  console.log(
    "Skills:",
    allSkills.map((s) => s.name),
  );
  if (diagnostics.length > 0) {
    console.log("Warnings:", diagnostics);
  }
  await runGovioCli("-V");
  console.log(">>> Server agent ready. <<<");
}

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;
  if (!resLoader) throw Error("Agent not ready.");

  const { session: newSession } = await createAgentSession({
    cwd: process.cwd(),
    resourceLoader: resLoader,
    sessionManager: SessionManager.inMemory(),
  });

  session = newSession;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}

export function resetSession() {
  session?.dispose();
  session = null;
}

export async function runGovioCli(cmd: string): Promise<string> {
  const { execSync } = await import("child_process");
  const output = execSync(`govio-cli ${cmd}`, {
    encoding: "utf-8",
    timeout: 15000,
  });
  console.debug(output);
  return output;
}