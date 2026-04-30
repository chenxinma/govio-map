import { createAgentSession, SessionManager, createCodingTools, DefaultResourceLoader, type AgentSession } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import govioCanvasExtension from "./extensions/govio-canvas.js";


let session: AgentSession | null = null;
let govioGovioBaseDir: string | null = null;
let resLoader: DefaultResourceLoader | null = null;

export async function agentSetup() {
  resLoader = new DefaultResourceLoader({
    extensionFactories: [
      (pi) => { govioCanvasExtension(pi); },
    ],
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

  await resLoader.reload();

  const { skills: allSkills, diagnostics } = resLoader.getSkills();
  console.log(
    "Skills:",
    allSkills.map((s) => s.name),
  );
  if (diagnostics.length > 0) {
    console.log("Warnings:", diagnostics);
  }

  const _govio_skill = allSkills.filter(s => (s.name === "govio"))[0];
  if (_govio_skill) {
    govioGovioBaseDir = _govio_skill.baseDir
  }
  await runGovioCli("--help");
  console.log(">>> Server agent ready. <<<");
}

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;
  
  if (!resLoader) throw Error("Agent not ready.");
  await resLoader.reload();

  const agentDir = join(homedir(), ".pi", "agent");
  const cwd = process.cwd();
  
  const result = await createAgentSession({
    cwd,
    tools: createCodingTools(cwd),
    sessionManager: SessionManager.inMemory(),
    agentDir: agentDir,
    resourceLoader: resLoader,
  });

  session = result.session;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}

export async function runGovioCli(cmd: string): Promise<string> {
  const { execSync } = await import("child_process");
  const output = execSync(`uvx --from ${govioGovioBaseDir}/assets/govio-*.whl govio-cli ${cmd}`, {
    encoding: "utf-8",
    timeout: 15000,
  });
  console.debug(output);
  return output;
}