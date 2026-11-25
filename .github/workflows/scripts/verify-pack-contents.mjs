#!/usr/bin/env node
/**
 * 发布**前**的产物清单断言（X32 起规则搬进 `pack-rules.mjs`，与发布后验证共用）。
 *
 * 用法（仓库根目录，已 build）：
 *   npm pack --dry-run --json | node .github/workflows/scripts/verify-pack-contents.mjs
 *
 * 为什么需要它：`.agents/skills/**` 被 .gitignore 忽略，CI 的 fresh checkout 里没有 skills，
 * 必须在发布前从 govio release 的 govio-skills.zip 预置；如果预置步骤悄悄失效，
 * `npm publish` 不会报错，只会产出一个缺 skills 的包。这个脚本把「必须有什么、绝不能有什么」变成硬断言。
 *
 * 退出码：0 = 合规；1 = 不合规（打印逐条问题）。
 */
import { evaluatePack } from "./pack-rules.mjs";

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

const paths = pack.files.map((f) => String(f.path).replaceAll("\\", "/"));
const { problems, notes } = evaluatePack(paths, { size: pack.size, entryCount: pack.entryCount });

console.log("— verify-pack-contents（发布前）—");
console.log(`  · 包名 ${pack.filename ?? "?"}`);
for (const note of notes) console.log(`  · ${note}`);
if (problems.length === 0) {
  console.log("  ✓ 产物清单符合发布口径");
  process.exit(0);
}
console.error(`  ✗ ${problems.length} 处不合规：`);
for (const problem of problems) console.error(`    - ${problem}`);
process.exit(1);
