import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type AgentSession, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import govioCanvasExtension from "./extensions/govio-canvas.js";
import { ensureGovioCli, downloadGovioSkills } from "./govio-installer.js";
import { getSessionDir } from "./session-history.js";


let session: AgentSession | null = null;
let resLoader: DefaultResourceLoader | null = null;
// First session creation after server start resumes the most recent persisted
// session; every later creation (after /clear, switch, config save) starts a new file.
let resumedOnce = false;

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

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

/**
 * pi-subagents 靠 argv[1] / 环境变量证明“本会话由哪个 Pi 持有”。嵌入式运行时下
 * argv[1] 是 node/vite/electron 入口，无法证明归属，pi-subagents 会告警并停用动态
 * 工具激活。这里解析内嵌 pi-coding-agent 的包根，写入官方 override 环境变量声明
 * 宿主 Pi（子 agent 进程继承该变量，归属一致，告警消除）。
 */
function declareHostPiPackageRoot(): void {
  let dir = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME)));
  for (let i = 0; i < 10; i++) {
    try {
      if (JSON.parse(readFileSync(resolvePath(dir, "package.json"), "utf-8")).name === PI_PACKAGE_NAME) {
        process.env[PI_PACKAGE_ROOT_ENV] = dir;
        return;
      }
    } catch {
      // 该层没有可读的 package.json，继续向上查找包根
    }
    dir = dirname(dir);
  }
}

export async function agentSetup() {
  // Resolve cwd at call time so the Electron main process can chdir()
  // before the agent boots (module-level evaluation would be too early).
  const cwd = process.cwd();
  ensureElectronRunAsNode();
  declareHostPiPackageRoot();

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

export async function getOrCreateSession(forceNew = false): Promise<AgentSession> {
  if (session) return session;
  if (!resLoader) throw Error("Agent not ready.");

  const cwd = process.cwd();
  const dir = getSessionDir();
  const useRecent = !resumedOnce && !forceNew;
  resumedOnce = true;
  const sessionManager = useRecent
    ? SessionManager.continueRecent(cwd, dir)
    : SessionManager.create(cwd, dir);

  const { session: newSession } = await createAgentSession({
    cwd,
    resourceLoader: resLoader,
    sessionManager,
  });

  session = newSession;
  return session;
}

/** Switch to a persisted historical session file and continue from it. */
export async function openSessionFile(path: string): Promise<AgentSession> {
  if (!resLoader) throw Error("Agent not ready.");
  resetSession();
  resumedOnce = true;

  const cwd = process.cwd();
  const sessionManager = SessionManager.open(path, getSessionDir(), cwd);

  const { session: newSession } = await createAgentSession({
    cwd,
    resourceLoader: resLoader,
    sessionManager,
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