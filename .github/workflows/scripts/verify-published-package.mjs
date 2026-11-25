#!/usr/bin/env node
/**
 * 发布**后**对已上线 tarball 的产物断言（X32）。与 `verify-pack-contents.mjs` 共用
 * `pack-rules.mjs` 的口径，保证「发布前断言」与「发布后验证」不会各说各话。
 *
 * 用法：
 *   curl -sSL -o pkg.tgz https://registry.npmjs.org/govio-map/-/govio-map-<ver>.tgz
 *   tar -tzf pkg.tgz | sed 's|^package/||' | node .github/workflows/scripts/verify-published-package.mjs
 *
 * stdin：每行一个包内路径（tar 默认带 `package/` 前缀，脚本也会兜底剥掉）。
 * 退出码：0 = 合规；1 = 不合规。
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

const paths = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.replace(/^package\//, ""))
  // tar 会把目录也列出来（以 / 结尾），它们不参与文件级规则
  .filter((line) => !line.endsWith("/"));

if (paths.length === 0) {
  console.error("verify-published-package: stdin 为空（tar 列表没传进来？）");
  process.exit(1);
}

const { problems, notes } = evaluatePack(paths);

console.log("— verify-published-package（发布后，registry tarball）—");
for (const note of notes) console.log(`  · ${note}`);
if (problems.length === 0) {
  console.log("  ✓ 已上线包内容符合发布口径");
  process.exit(0);
}
console.error(`  ✗ ${problems.length} 处不合规：`);
for (const problem of problems) console.error(`    - ${problem}`);
process.exit(1);
