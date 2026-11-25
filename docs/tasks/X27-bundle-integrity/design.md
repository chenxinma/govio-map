# X27 session bundle 外层完整性校验

状态：done（待 PR 合并后由主会话置 accepted）

## 背景

T3.6 的包用 `bundle.json` 记录逐文件 sha256，但 `bundle.json` 无法列出自己的校验和（自引用不可算）。
因此「清单与包内文件自洽」并不能证明「整包来自声称的导出方」——同时重写 `bundle.json` 与包内文件即可绕过。
T3.7 decisions ⑥ 因此选择了「不加外层签名 + 清单外文件即整包拒绝」，把这条剩余风险挂到本任务。

## 裁决（本条 decisions）

用户 2026-11-17 只要求「先纳入计划」，未裁决落点；2026-11-25 主会话按「最小可用 + 可回收」原则裁决如下（用户可改）：

| 决策 | 取值 | 理由 |
|---|---|---|
| 落点 | **两者都做**：UI 显示整包 sha256（可复制）+ 额外下载 `.sha256` 旁文件 | 两者实现成本几乎相同；旁文件让 `sha256sum -c` 可用，UI 值让口头/IM 传达可用 |
| 校验和算法 | 对**最终 zip 字节**算 SHA-256（`exportSessionBundle` 已有的 `hashBytes` 注入点） | 保护对象是「手里这份 zip」，不是清单内容；包内任何文件变化都会改变该值 |
| 旁文件格式 | `<64 hex>  <包文件名>\n`（sha256sum 兼容，两空格） | 与 `sha256sum -c` 直接兼容，不引入自定义格式 |
| 导入侧是否自动比对 | **仅在显式给出时**比对（`/import <path> [sha256]` → `POST { path, sha256 }`） | decisions ⑤「读宽写严」：不改变既有调用方（无 sha256 时行为逐字不变），同时给出可操作的核对路径 |
| 参数形态 | 最后一个空白分隔段像 64 位 hex 才当校验和，其余整段算路径；容忍大写与 `sha256sum` 整行粘贴 | 路径可含空格（既有能力不能退化） |
| 错误码 | 新增 `outer-checksum-mismatch`（HTTP 422） | 与 `checksum-mismatch`（清单内逐文件）区分开，便于用户/日志判断是哪一层出问题 |
| 非对称签名 | **不做**，遗留归 T3.3 | 需要源实例私钥 + 接收方公钥的分发与轮换，属密钥管理，单独立项更合适 |

## 实现

**导出侧（`src/commands/export-session.ts`）**
- `zipSync` 之后 `bundleSha256 = await hashBytes(zipped)`（与 `report.html` 的 sha256 同一个注入点，测试可替身）；
- 追加下载旁文件 `bundleChecksumFileName(fileName)`，内容 `formatBundleChecksum()`；
- `ExportBundleOutcome` 新增 `bundleSha256` / `checksumFileName`；
- 新增 `downloadText` 注入点（默认 `text/plain` Blob 下载；非浏览器环境 no-op，避免 node 集成测试炸 `document`）。

**导入侧（`server/session-import.ts` / `server/bundle-api.ts` / `src/commands/import-session.ts`）**
- `ImportSessionBundleOptions.expectedBundleSha256`：读包之后、**解包之前**比对（`normalizeBundleChecksum` 收敛格式）；
  不符或格式非法 → `BundleImportError("outer-checksum-mismatch")`，仍满足 decisions ④「校验全绿前零写入」；
- 路由接受可选 `sha256` 字段（省略时行为与 X27 之前逐字一致）；
- 前端命令层先本地校验格式（不发垃圾请求），并在进度提示里注明「将强制比对」。

**纯函数与文案**
- `src/types/bundle.ts`：`bundleChecksumFileName()` / `formatBundleChecksum()` / `normalizeBundleChecksum()`，
  以及错误码 `outer-checksum-mismatch`；
- `src/commands/import-session.ts`：`IMPORT_ERROR_TEXT` 补该码的人话文案。

**UI 反馈**
- `/export` 成功提示追加第二行「整包 sha256：<hex>」与旁文件名；
- `/import` 带校验和时进度提示注明将强制比对。

## 影响面

| 文件 | 变更 |
|---|---|
| `src/types/bundle.ts` | 3 个新纯函数 + 1 个错误码 |
| `src/commands/export-session.ts` | 整包 sha256、旁文件下载、`downloadText` 注入点 |
| `src/commands/import-session.ts` | `expectedSha256` 入参与本地格式校验、错误文案 |
| `src/commands/types.ts` | `importSession(bundlePath, expectedSha256?)` |
| `src/commands/built-in.ts` | `/import` 参数拆分（最后一段为 hex 时当校验和）+ 用法/描述文案 |
| `src/components/Chat/ChatInput.tsx` | 导出反馈显示 sha256/旁文件；导入提示带「将强制比对」 |
| `server/session-import.ts` | 解包前外层校验和闸门 |
| `server/bundle-api.ts` | body 可选 `sha256` 透传 |
| `docs/specs/06-backend.md` / `08-commands.md` / `docs/USER-MANUAL.md` | 路由参数、错误码、命令签名、交接流程 |
| 测试 | `tests/integration/export-bundle.test.ts`（+3）、`tests/integration/session-import.test.ts`（+5）、`tests/ui/export-command.test.tsx`（+1）、`tests/ui/import-command.test.tsx`（+2） |

## 遗留问题

1. **纯 sha256 防伪造无效**：攻击者若同时替换 zip 与旁文件/告知值，导入侧无法察觉。要防这一层需源实例
   私钥签名 + 接收方公钥（密钥生成/分发/轮换），建议与 T3.3（多用户隔离/SSO）一并设计，已在本条 decisions 记录。
2. **旁文件不自动发现**：当前不自动去找同目录同名 `.sha256`（避免「悄悄改变既有导入行为」），需用户显式带上。
   若后续觉得太麻烦，可加一个显式开关（如 `/import --verify-sidecar <path>`）。
3. **`bundle.json` 仍不列自己**：外层校验和是旁路补充，包内清单的自引用缺口依旧存在（设计使然，已记 T3.6 遗留 2）。
4. 导出时多一次 WebCrypto 摘要（zip 通常 1–3MB，实测无感）；未做进度上报。
