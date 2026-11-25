#!/usr/bin/env node
/**
 * 断言 `npm pack --dry-run --json` 的产物清单符合发布口径（X31）。
 *
 * 用法（在仓库根目录，已 build）：
 *   npm pack --dry-run --json | node .github/workflows/scripts/verify-pack-contents.mjs
 *
 * 为什么需要它：`.agents/skills/**` 被 .gitignore 忽略，CI 的 fresh checkout 里没有 skills，
 * 必须在发布前从 govio release 的 govio-skills.zip 预置；如果预置步骤悄悄失效，
 * `npm publish` 不会报错，只会产出一个缺 skills 的包（启动后 seeding 不到技能）。
 * 这个脚本把「包内必须有什么、绝不能有什么」变成硬断言。
 *
 * 退出码：0 = 合规；1 = 不合规（打印逐条问题）。
 * 非门禁但必须显式执行：本脚本只在 publish workflow 里跑，不进 ci.yml。
 */
const raw = await new Promise((resolve, reject) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
  });
  process.stdin.on("end", () => resolve(buf));
  process.stdin.on("error", reject);
});

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("verify-pack-contents: 无法解析 npm pack --json 输出（stdin 不是 JSON）");
  process.exit(1);
}

const pack = Array.isArray(parsed) ? parsed[0] : parsed;
if (!pack || !Array.isArray(pack.files)) {
  console.error("verify-pack-contents: npm pack 输出缺 files 清单（npm 版本变化？）");
  process.exit(1);
}

const files = pack.files.map((f) => String(f.path).replaceAll("\\", "/"));
const has = (p) => files.includes(p);
const anyUnder = (prefix) => files.filter((p) => p.startsWith(prefix));
const problems = [];
const notes = [];

/** 必须存在（缺一个就发布失败）。 */
const REQUIRED_FILES = [
  "package.json",
  "LICENSE",
  "README.md",
  "dist/index.html",
  "dist-server/cli.mjs",
  ".pi/APPEND_SYSTEM.md",
  ".agents/skills/govio/SKILL.md",
];
for (const file of REQUIRED_FILES) {
  if (!has(file)) problems.push(`缺少必需文件：${file}`);
}

/** 包内 skills 至少 6 个 govio-* 技能目录（govio / govio-eda / govio-meta / govio-observe / govio-query / govio-reconcile）。 */
const skillDirs = new Set(
  files
    .filter((p) => p.startsWith(".agents/skills/") && p.endsWith("/SKILL.md"))
    .map((p) => p.split("/")[2])
);
for (const required of ["govio", "govio-eda", "govio-meta", "govio-observe", "govio-query", "govio-reconcile"]) {
  if (!skillDirs.has(required)) problems.push(`包内缺少技能目录：.agents/skills/${required}/SKILL.md`);
}
notes.push(`包内技能目录：${[...skillDirs].sort().join(", ") || "(无)"}`);

/** 绝不能出现（环境快照、源码、依赖、凭据、构建垃圾）。 */
const FORBIDDEN_PREFIXES = [
  [".agents/skills/govio/assets/", "图谱快照 assets 不得随包分发（会覆盖目标环境的 live 快照）"],
  ["node_modules/", "node_modules 不得随包"],
  ["src/", "源码不进包（运行时只用 dist / dist-server）"],
  ["tests/", "测试不进包"],
  ["server/", "服务端源码已 bundle 进 dist-server，源码不进包"],
  ["scripts/", "验证脚本不进包"],
];
for (const [prefix, reason] of FORBIDDEN_PREFIXES) {
  const hit = anyUnder(prefix);
  if (hit.length) problems.push(`${reason}：出现 ${hit.length} 个文件，例如 ${hit[0]}`);
}

/** 凭据 / 本地状态一律不得入包。 */
const FORBIDDEN_ANYWHERE = [/(^|\/)\.env(\..*)?$/, /(^|\/)\.govio\//, /(^|\/)\.claude\//, /(^|\/)\.codex\//, /(^|\/)\.ssh\//];
for (const pattern of FORBIDDEN_ANYWHERE) {
  const hit = files.filter((p) => pattern.test(p));
  if (hit.length) problems.push(`疑似凭据/本地状态入包（${pattern}）：${hit.slice(0, 3).join(", ")}`);
}

/** 体积与文件数合理性（防止误把 data/ 或构建缓存打进来）。 */
const totals = pack.entryCount ?? files.length;
const MAX_FILES = 400;
if (totals > MAX_FILES) problems.push(`包内文件数 ${totals} 超过上限 ${MAX_FILES}（疑似打进了不该进包的目录）`);
const MAX_BYTES = 20 * 1024 * 1024;
if (typeof pack.size === "number" && pack.size > MAX_BYTES) {
  problems.push(`包体积 ${(pack.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${MAX_BYTES / 1024 / 1024} MB`);
}

notes.push(`包名 ${pack.filename ?? "?"}，${totals} 个文件，${typeof pack.size === "number" ? `${(pack.size / 1024).toFixed(0)} KB` : "体积未知"}`);

console.log("— verify-pack-contents —");
for (const note of notes) console.log(`  · ${note}`);
if (problems.length === 0) {
  console.log("  ✓ 产物清单符合发布口径");
  process.exit(0);
}
console.error(`  ✗ ${problems.length} 处不合规：`);
for (const problem of problems) console.error(`    - ${problem}`);
process.exit(1);
