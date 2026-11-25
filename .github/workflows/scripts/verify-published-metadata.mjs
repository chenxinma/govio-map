#!/usr/bin/env node
/**
 * 断言 registry 上某个版本的**元信息完整性**（X32，发布后验证用）。
 *
 * 用法：
 *   npm view govio-map@0.7.3 --json --registry=https://registry.npmjs.org > meta.json
 *   node .github/workflows/scripts/verify-published-metadata.mjs meta.json
 *
 * 背景：0.7.2 首次正式发布时 license/description/author/... 全空（package.json 只填了 name/version），
 * 而 npm 的 version 元数据发布后不可变。这个断言把「元信息必须齐全」变成发布后必过的一关。
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('verify-published-metadata: 用法 node verify-published-metadata.mjs <npm-view-json>');
  process.exit(1);
}

let meta;
try {
  meta = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`verify-published-metadata: 无法读取/解析 ${file}（${err instanceof Error ? err.message : String(err)}）`);
  process.exit(1);
}

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const checks = [
  ['license', meta.license],
  ['description', meta.description],
  ['author', meta.author && (meta.author.name || meta.author)],
  ['repository', meta.repository && (meta.repository.url || meta.repository)],
  ['homepage', meta.homepage],
  ['keywords', meta.keywords],
  ['dist.integrity', meta.dist && meta.dist.integrity],
];

const missing = [];
console.log(`— verify-published-metadata（govio-map@${meta.version ?? '?'}）—`);
for (const [label, value] of checks) {
  const empty = isEmpty(value);
  console.log(`  · ${label} = ${empty ? '(空)' : JSON.stringify(value)}`);
  if (empty) missing.push(label);
}

if (missing.length === 0) {
  console.log('  ✓ 元信息齐全');
  process.exit(0);
}
console.error(`  ✗ 元信息缺失 ${missing.length} 项：${missing.join(', ')}`);
process.exit(1);
