#!/usr/bin/env node
/**
 * 断言某个已发布版本带**provenance**（X32，发布后验证用）。
 *
 * 用法：
 *   curl -sSf https://registry.npmjs.org/-/npm/v1/attestations/govio-map@0.7.3 > att.json
 *   node .github/workflows/scripts/verify-provenance.mjs att.json
 *
 * 期望：publish attestation（npm 的 publish/v0.1）与 slsa provenance（slsa.dev/provenance/v1）。
 * 前者证明「这份包确实由可信发布通道上传」，后者记录构建来源（仓库/commit/workflow）。
 */
import { readFileSync } from 'node:fs';

const REQUIRED_PREDICATES = [
  'https://slsa.dev/provenance/v1',
  'https://github.com/npm/attestation/tree/main/specs/publish/v0.1',
];

const file = process.argv[2];
if (!file) {
  console.error('verify-provenance: 用法 node verify-provenance.mjs <attestations-json>');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`verify-provenance: 无法读取/解析 ${file}（${err instanceof Error ? err.message : String(err)}）`);
  process.exit(1);
}

const types = (data.attestations || []).map((a) => a.predicateType).filter(Boolean);
console.log(`— verify-provenance（attestations ${types.length} 条）—`);
for (const type of types) console.log(`  · ${type}`);

const missing = REQUIRED_PREDICATES.filter((type) => !types.includes(type));
if (missing.length === 0) {
  console.log('  ✓ provenance 齐全');
  process.exit(0);
}
console.error(`  ✗ 缺少 provenance 类型：${missing.join(' / ')}`);
process.exit(1);
