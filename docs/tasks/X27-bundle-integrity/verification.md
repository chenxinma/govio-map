# X27 verification

分支 `chenxinma/x27-bundle-integrity`（base main `d3e7f62`），2026-11-25 主会话本地执行。

## 门槛

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0（tsc -b + vite + esbuild） |
| `npm run lint` | exit 0（eslint 无告警） |
| `npm run verify` | exit 0，11 段全绿，`git status --porcelain` 仅本任务改动 |

脚本断言（Windows 全量）：`verify:manifest` 92 / `verify:rerun` 71 / `verify:audit` 119 / `verify:export` 148 /
`verify:source-table` 39 / `verify:semantic-lineage` 54 / `verify:caliber-conflict` 77 / `verify:cwd` 13（caseDrift 闸门在本机通过，无 SKIP）/
`verify:prompt-injection` 58 ⇒ **671**，与基线一致（零回归）。

vitest：`verify:integration` **33 文件 / 487 例**（基线 33/476，+11 全部来自本任务）；`verify:ui` **10 文件 / 90 例**（基线 10/87，+3）。

## 新增用例逐条

`tests/integration/export-bundle.test.ts`（+3）
1. `bundleSha256` = 下载 zip 字节的 sha256；旁文件名 `<包名>.sha256`，内容 `<hex>  <包名>\n`（可直接 `sha256sum -c`）；
2. 同一会话两次导出：整包 sha256 与 zip 字节都一致（mtime 固定在 `exportedAt`）；
3. 修改包内任意文件内容 → 整包 sha256 必变（证明保护的是 zip 字节，不是清单文本）。

`tests/integration/session-import.test.ts`（+5）
4. 相符 → 正常导入，会话目录新增文件集与既有路径一致；
5. 大写 / `sha256sum` 整行粘贴均被接受（`normalizeBundleChecksum`）；
6. 不符 → `outer-checksum-mismatch` 且 **sessions 目录快照逐项不变**（零写入）；
7. 格式非法 → 同码拒绝、零写入（不静默跳过校验）；
8. HTTP：`body.sha256` 正确 → 200 `ok:true`；错误 → 422 `outer-checksum-mismatch` 且零写入；不带 `sha256` → 行为不变。

`tests/ui/export-command.test.tsx`（+1）
9. `/export` 成功提示包含整包 sha256 与旁文件名（可复制形态）。

`tests/ui/import-command.test.tsx`（+2）
10. `/import D:/my downloads/x.zip <64 hex>` → `bundlePath` 保留空格、`expectedSha256` 正确透传；
11. 不带校验和 → `expectedSha256` 为 `undefined`（旧用法零变化）。

## 人工可复现

```bash
# 单元/集成
npx vitest run tests/integration/export-bundle.test.ts tests/integration/session-import.test.ts \
  tests/ui/export-command.test.tsx tests/ui/import-command.test.tsx

# 端到端（浏览器）
npm run dev
#  1) 在任意会话执行 /export → 输入框上方显示「整包 sha256：<hex>」，浏览器下载 zip 与 .sha256 两个文件
#  2) sha256sum -c <token>.govio-bundle.zip.sha256 → OK
#  3) /import <zip 路径> <hex> → 正常导入；把 hex 改掉一位 → 拒绝且 .govio/sessions/ 无新增文件
```

## 未覆盖 / 待合并后做

- `verificationBaseline`（`docs/task-plan.json`）待 PR 合并后在主会话记账时同步：`verify:integration` 487、`verify:ui` 90；
- ubuntu CI 断言口径（664）不涉及本任务新增用例（全部为 vitest），无平台差异。
