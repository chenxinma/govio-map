# X27 CHANGES

分支：`chenxinma/x27-bundle-integrity`（base: main）

## 代码

| 文件 | 变更 |
|---|---|
| `src/types/bundle.ts` | 新增 `bundleChecksumFileName()`、`formatBundleChecksum()`、`normalizeBundleChecksum()`；`IMPORT_ERROR_CODES` 增加 `outer-checksum-mismatch` |
| `src/commands/export-session.ts` | `zipSync` 后对整包字节算 `bundleSha256`；新增 `downloadTextFile` 默认实现与 `downloadText` 注入点；下载 `<包名>.sha256` 旁文件；`ExportBundleOutcome` 增 `bundleSha256` / `checksumFileName` |
| `src/commands/import-session.ts` | `ImportBundleDeps.expectedSha256`；本地先用 `normalizeBundleChecksum` 收敛格式（非法直接报错、不发请求）；请求体按有无校验和分别构造；`IMPORT_ERROR_TEXT` 补 `outer-checksum-mismatch` |
| `src/commands/types.ts` | `importSession(bundlePath, expectedSha256?)` |
| `src/commands/built-in.ts` | `/import` 参数拆分：最后一段为 64 位 hex 时作为校验和、其余整段为路径；用法与描述文案更新 |
| `src/components/Chat/ChatInput.tsx` | `/export` 成功提示追加「整包 sha256 + 旁文件名」；`/import` 带校验和时提示「将强制比对」 |
| `server/session-import.ts` | `expectedBundleSha256`：读包后、**解包前**比对，不符/格式非法 → `outer-checksum-mismatch`（零写入） |
| `server/bundle-api.ts` | `POST /api/session-import` body 可选 `sha256` 透传 |

## 文档

| 文件 | 变更 |
|---|---|
| `docs/specs/06-backend.md` | 路由 body 增加 `sha256?`；错误码表增加 `outer-checksum-mismatch`（422） |
| `docs/specs/08-commands.md` | CommandContext 签名、命令表、`/export` 流程第 6 步（外层完整性）、反馈文案、`/import` 参数拆分 |
| `docs/USER-MANUAL.md` | 7.6 新增「整包校验和与旁文件」小节；7.7 增加带 sha256 的导入示例与交接表第 3 步；安全小节与拒因清单同步 |
| `docs/tasks/X27-bundle-integrity/design.md` | 裁决表、实现说明、影响面、遗留问题 |

## 测试

| 文件 | 新增用例 |
|---|---|
| `tests/integration/export-bundle.test.ts` | +3：bundleSha256/旁文件契约、同会话两次导出哈希一致、包内改动改变整包哈希；harness 增 `textDownloads` |
| `tests/integration/session-import.test.ts` | +5：相符正常导入、大写/整行容忍、不符拒绝零写入、格式非法拒绝零写入、HTTP 带/不带 sha256 |
| `tests/ui/export-command.test.tsx` | +1：反馈显示整包 sha256 与旁文件名（另为既有 mock 补齐新字段） |
| `tests/ui/import-command.test.tsx` | +2：含空格路径 + sha256 的参数拆分、不带校验和时 `expectedSha256` 为 undefined（另断言描述含 `[整包 sha256]`） |
