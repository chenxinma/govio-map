/**
 * 「发布产物」口径的单一事实源（X32）。
 *
 * 两个调用方共用这套规则，避免「打包前断言」与「发布后验证」两套标准漂移：
 *  - `verify-pack-contents.mjs`：发布**前**读 `npm pack --dry-run --json`；
 *  - `verify-published-package.mjs`：发布**后**读已上线 tarball 的条目列表（`tar -tzf`）。
 *
 * 规则只依赖「包内相对路径列表」，与来源（本地打包 / registry tarball）无关。
 */

/** 必须存在于包内（缺一条即不合规）。 */
export const REQUIRED_FILES = [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/index.html",
  "dist-server/cli.mjs",
  ".pi/APPEND_SYSTEM.md",
  ".agents/skills/govio/SKILL.md",
];

/** 必须各自带 SKILL.md 的 govio 技能目录。 */
export const REQUIRED_SKILLS = [
  "govio",
  "govio-eda",
  "govio-meta",
  "govio-observe",
  "govio-query",
  "govio-reconcile",
];

/** 绝不能出现的前缀（[前缀, 原因]）。 */
export const FORBIDDEN_PREFIXES = [
  [".agents/skills/govio/assets/", "图谱快照 assets 不得随包分发（会覆盖目标环境的 live 快照）"],
  ["node_modules/", "node_modules 不得随包"],
  ["src/", "源码不进包（运行时只用 dist / dist-server）"],
  ["tests/", "测试不进包"],
  ["server/", "服务端源码已 bundle 进 dist-server，源码不进包"],
  ["scripts/", "验证脚本不进包"],
];

/** 任何位置都不得出现的路径模式。 */
export const FORBIDDEN_ANYWHERE = [
  [/(^|\/)\.env(\..*)?$/, "凭据（.env）"],
  [/(^|\/)\.govio\//, "本地运行状态（.govio/）"],
  [/(^|\/)\.claude\//, "本地助手状态（.claude/）"],
  [/(^|\/)\.codex\//, "本地助手状态（.codex/）"],
  [/(^|\/)\.ssh\//, "凭据（.ssh/）"],
];

/** 合理性上限（防误把 data/ 或构建缓存打进来）。 */
export const MAX_FILES = 400;
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * 对一份包内路径清单评级。
 *
 * @param {string[]} paths 包内相对路径（正斜杠，已去掉 tar 的 `package/` 前缀）
 * @param {{ size?: number, entryCount?: number }} [meta] 体积与条目数（可选；用于上限判定）
 * @returns {{ problems: string[], notes: string[] }}
 */
export function evaluatePack(paths, meta = {}) {
  const files = paths.map((p) => String(p).replaceAll("\\", "/"));
  const has = (p) => files.includes(p);
  const anyUnder = (prefix) => files.filter((p) => p.startsWith(prefix));
  const problems = [];
  const notes = [];

  for (const file of REQUIRED_FILES) {
    if (!has(file)) problems.push(`缺少必需文件：${file}`);
  }

  const skillDirs = new Set(
    files
      .filter((p) => p.startsWith(".agents/skills/") && p.endsWith("/SKILL.md"))
      .map((p) => p.split("/")[2])
  );
  for (const required of REQUIRED_SKILLS) {
    if (!skillDirs.has(required)) problems.push(`包内缺少技能目录：.agents/skills/${required}/SKILL.md`);
  }
  notes.push(`包内技能目录：${[...skillDirs].sort().join(", ") || "(无)"}`);

  for (const [prefix, reason] of FORBIDDEN_PREFIXES) {
    const hit = anyUnder(prefix);
    if (hit.length) problems.push(`${reason}：出现 ${hit.length} 个文件，例如 ${hit[0]}`);
  }

  for (const [pattern, label] of FORBIDDEN_ANYWHERE) {
    const hit = files.filter((p) => pattern.test(p));
    if (hit.length) problems.push(`疑似${label}入包：${hit.slice(0, 3).join(", ")}`);
  }

  const total = meta.entryCount ?? files.length;
  if (total > MAX_FILES) {
    problems.push(`包内文件数 ${total} 超过上限 ${MAX_FILES}（疑似打进了不该进包的目录）`);
  }
  if (typeof meta.size === "number" && meta.size > MAX_BYTES) {
    problems.push(`包体积 ${(meta.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_BYTES / 1024 / 1024} MB`);
  }
  notes.push(
    `共 ${total} 个文件${typeof meta.size === "number" ? `，zip ${(meta.size / 1024).toFixed(0)} KB` : ""}`
  );

  return { problems, notes };
}
