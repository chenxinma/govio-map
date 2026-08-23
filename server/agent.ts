import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type AgentSession, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import govioCanvasExtension from "./extensions/govio-canvas.js";
import { ensureGovioCli, downloadGovioSkills } from "./govio-installer.js";


let session: AgentSession | null = null;
let resLoader: DefaultResourceLoader | null = null;

/**
 * pi-subagents 以 npm 依赖安装在项目 node_modules 中（版本随 package.json 管理）。
 * 通过 additionalExtensionPaths 指向包目录，pi 会读取其 package.json 的 "pi" manifest，
 * 自动加载 extensions (index.ts) / skills / prompts 全部资源（jiti 加载 TS 源码，
 * 并把 @earendil-works/pi-coding-agent 等依赖 alias 到当前内嵌的 pi 运行时）。
 */
const PI_SUBAGENTS_PACKAGE_DIR = "pi-subagents";

/**
 * 判断某个扩展/skill 路径是否来自“另一份” pi-subagents 拷贝。
 * 用户全局 ~/.pi/agent/settings.json 的 packages 里可能也装了 pi-subagents
 * （由 pi CLI 管理，DefaultResourceLoader 会自动发现并加载它），
 * 需要过滤掉以避免工具重复注册 / 名称冲突。
 */
function isOtherSubagentsCopy(resourcePath: string | undefined, projectSubagentsDir: string): boolean {
  if (!resourcePath) return false;
  const norm = resourcePath.replaceAll("\\", "/").toLowerCase();
  if (!norm.includes("pi-subagents")) return false;
  return !norm.startsWith(projectSubagentsDir.replaceAll("\\", "/").toLowerCase());
}

/**
 * pi-subagents 子进程通过 import.meta.resolve("@earendil-works/pi-coding-agent")
 * 定位内嵌 pi 的 dist/cli.js，然后以 `process.execPath <cli.js>` 启动子 agent。
 * 在 Electron 生产环境中 process.execPath 是 electron 可执行文件，直接 spawn
 * 会拉起完整的 Electron 实例而非 Node 子进程，因此需要 ELECTRON_RUN_AS_NODE=1。
 * 该变量仅对 Electron 可执行文件有意义，对纯 Node 无副作用，且会被子进程继承，
 * 嵌套 subagent 也能正确运行。
 */
function ensureElectronRunAsNode(): void {
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    process.env.ELECTRON_RUN_AS_NODE = "1";
  }
}

export async function agentSetup() {
  // Resolve cwd at call time so the Electron main process can chdir()
  // before the agent boots (module-level evaluation would be too early).
  const cwd = process.cwd();
  ensureElectronRunAsNode();

  const projectSubagentsDir = resolvePath(cwd, "node_modules", PI_SUBAGENTS_PACKAGE_DIR);
  const hasProjectSubagents = existsSync(projectSubagentsDir);

  resLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    // 加载 npm 安装的 pi-subagents（包目录形式，按 pi manifest 加载全部资源）。
    // 未安装时跳过，此时若用户全局装有 pi-subagents，仍会走全局副本（保底可用）。
    ...(hasProjectSubagents ? { additionalExtensionPaths: [projectSubagentsDir] } : {}),
    extensionFactories: [
      (pi) => { govioCanvasExtension(pi); },
    ],
    extensionsOverride: (base: LoadExtensionsResult) =>
      hasProjectSubagents
        ? {
            ...base,
            // 全局 ~/.pi/agent packages 发现的 pi-subagents 副本会让 subagent 工具重复注册，过滤掉
            extensions: base.extensions.filter((e) => !isOtherSubagentsCopy(e.path, projectSubagentsDir)),
            errors: base.errors.filter((e) => !isOtherSubagentsCopy(e.path, projectSubagentsDir)),
          }
        : base,
    skillsOverride: (current) => {
      const keep = (name: string) =>
        name.includes("browser") ||
        name.includes("search") ||
        name.includes("govio") ||
        name.includes("eda") ||
        name.includes("observe") ||
        name === "pi-subagents" ||
        name === "council-mode";
      return {
        // 项目 npm 副本优先；未安装项目副本时保留全局副本的 pi-subagents skill
        skills: current.skills.filter(
          (s) =>
            keep(s.name) &&
            (!hasProjectSubagents || !isOtherSubagentsCopy(s.filePath, projectSubagentsDir)),
        ),
        // 清理两份拷贝同名 skill 产生的 collision 诊断噪音
        diagnostics: current.diagnostics.filter(
          (d) => !(hasProjectSubagents && d.type === "collision" && (d as { collision?: { winnerPath?: string } }).collision?.winnerPath?.includes("pi-subagents")),
        ),
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
  await ensureGovioCli();
  await downloadGovioSkills();
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

export async function runGovioCli(cmd: string, quiet = false): Promise<string> {
  const { execFile } = await import("child_process");
  const args = cmd.split(/\s+/);
  return new Promise((resolve, reject) => {
    execFile("govio-cli", args, { encoding: "utf-8", timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[govio-cli] ${cmd} failed:`, stderr || error.message);
        reject(error);
      } else {
        if (!quiet) console.debug(stdout);
        resolve(stdout);
      }
    });
  });
}