# T3.7 交付文件清单

单次 commit，message 前缀 `T3.7: `。设计与取舍见 `design.md`，验证与断言对账见 `verification.md`。
**零新增 npm 依赖**（zip 解压用 T3.6 已引入的 `fflate`），`package.json` / `package-lock.json` 零改动。

## 新增（源码）

| 文件 | 行 | 摘要 |
|---|---|---|
| `server/session-import.ts` | 613 | 导入核心。`resolveBundlePath()` 读侧六道校验（非空/无 NUL/拒 UNC 与设备路径/`.zip` 扩展名/`lstat` 拒 symlink 与目录/体积上限）；`inspectBundleEntries()` 用 fflate `filter→false` 做**只读元数据的第一遍**（零解压）；`assertBundleEntryLimits()` 条目数/解压后体积/条目名白名单/重名/压缩方式闸门；`parseBundleManifest()` 清单形状与版本校验（含 sha256 形状、禁止自列）；`rewriteTranscriptHeader()` 只改 header 一行的 `id`/`cwd`/`parentSession` 并统计消息数与会话名；`newSessionFileName()` 沿用 `<ISO(冒号点换横杠)>_<uuid>.jsonl` 约定；`importSessionBundle()` 四阶段编排（读侧校验 → 元数据闸门 → 解压+清单双向对齐+逐文件 sha256 → 冲突探测+落盘，失败 `rollback`）；`readImportMeta()` 读来源标注；`BundleImportError` 带稳定 `code` |
| `src/commands/import-session.ts` | 120 | 前端命令模块。`importSessionBundle()` 发 `POST /api/session-import`（基址 `apiBaseFrom(origin) ?? ''`，X25 纪律）；`IMPORT_ERROR_TEXT` 把 20 个错误码逐条翻成人话；`SessionImportError`（带 `code`，区分 `network`/`http`）；`describeImportResult()` 生成「会话名 + 节点/边/对话/留痕数 + 缺什么数据 + 源 profile」一句话反馈（无会话名时说明列表按首条消息显示，不拿 uuid 充数） |

## 新增（测试，共 +75 例）

| 文件 | 例数 | 摘要 |
|---|---|---|
| `tests/integration/session-import.test.ts` | 53 | ①**往返一致性**（用 T3.6 真实链路 `collectSessionBundle` + `exportSessionBundle` 产出真 zip → 导入 → nodes/edges/Manifest/audit/injection 逐项一致；transcript 除 header 外逐字节相同；header 只改 id/cwd/parentSession；`listSessions()` 可见且 name/messageCount 正确；`.import.json` 与画布顶层 `importedFrom`；`forkFrom` 血缘保留；同包两次导入得两个会话；`report.html`/`manifests.json` 不落地；无画布包可导入；`storageProfile` 只透传引用名且假凭据/桶名零落地；`deleteSession` 级联删 `.import.json`）②**原子性**（sha256 篡改 / bytes 篡改 / 内容篡改 / 缺条目 / 夹带条目 / 缺 transcript / 版本不符 / format 不符 / 无 manifest / manifest 五种形状错 / transcript 非法 / canvas 与 manifests 形状错 / 目标已存在 / 写盘中途失败回滚 —— **每条都断言 sessions 目录零写入**）③**安全**（读侧路径 5 类拒绝、UNC 与设备路径 4 样本、相对路径与 `.ZIP` 大小写、不存在/目录/symlink、zip 体积超限、非 zip、元数据闸门纯函数（重名/压缩方式/解压后体积）、8 个 zip-slip 样本、清单内路径也过白名单）④**纯函数**（CRLF 与无尾换行保留、坏 header 拒绝、`session_info` 取最新且空白名清除、坏行不拖垮、文件名约定）⑤**HTTP**（200 + `no-store` + CORS 回显、OPTIONS 预检 204、非白名单 Origin 不回显、缺 path/空 path/非法 JSON → 400、body 超 8KB → 413、GET → 405、未知路径不接管、`/api/session-bundle` 行为未变、错误码→状态映射表驱动覆盖全部码、响应不泄漏包内容）⑥**前端模块**（基址由页面 origin 推导、无端口时退回相对路径、空路径不发请求、6 个错误码翻人话、后端 message 优先、网络不通、回执形状不符、结果文案四种形态） |
| `tests/ui/import-command.test.tsx` | 14 | 参数通道纯函数（`/import` 声明 args 而 `/export`·`/clear`·`/clear-canvas` 没有；`/export foo`、`/clear now`、`/skill:x y` 一律不截获；`/important`、`/imports` 不误判；大小写不敏感；余串含空格整体作单参数；首尾 trim；无参数为空串；非斜杠与空输入不解析）+ 接线（下拉选中 = 预填 `/import ` 且不执行；回车即导入并交出页面 origin 与路径、不发给 agent、清空输入框；成功反馈含会话名/节点数/对话数并调 `onSessionsChanged`；失败给人话且不刷新列表；缺参数给用法提示并预填、不打后端；导入中重复触发不并发）+ **既有命令零回归**（`/export` 下拉选中仍立即执行；`/export 帮我导出一下` 仍原样 `onSend`；普通消息照常发送） |
| `tests/ui/preview-degradation.test.tsx` | 8 | 真实 store + 真实 `FloatingPreviewPanel`：404 → 「数据不在本机」+ dfName + 「导入的会话包不含数据文件」+「重新加载」+ 后端原因；500 → 状态码 + 后端原因；fetch reject → 有提示且**无 unhandledRejection**；200 → `previewData` 落地且 `previewError` 为空；先失败后成功 → `updatePreviewPanelData` 清旧错；`setPreviewPanelError` 只影响目标面板；有错时渲染 `role="alert"` 且**不渲染空表与分页页脚**（头部仍显示 dfName）；无错时表格与页脚照常（零回归） |

## 修改（源码）

| 文件 | ±  | 摘要 |
|---|---|---|
| `src/types/bundle.ts` | +126 | **只追加，未改任何 T3.6 既有导出**。新增导入侧契约：`IMPORT_META_VERSION`、`IMPORT_ERROR_CODES`（20 个稳定码）+ `ImportErrorCode`、`MAX_IMPORT_ZIP_BYTES`(64MB) / `MAX_IMPORT_UNCOMPRESSED_BYTES`(256MB) / `MAX_IMPORT_FILE_COUNT`(32)、`ImportedFrom`、`SessionImportResult`、`SessionImportMeta` |
| `server/bundle-api.ts` | +153/-44 | 文件头注释重写（两条通道的分工与安全边界、为什么导入是「前端给路径、服务端读文件」）；新增 `readJsonBody()`（8KB 流式上限）与 `importStatusFor()`（错误码→状态）；`handleBundleApi` 改为按 pathname 分派两条路由；新增 `POST /api/session-import`（含 **OPTIONS 预检 204**，`parquet-api.ts` 同款写法）；**`GET /api/session-bundle` 的逻辑逐行未动**（仅缩进层级随分派结构调整）；未改 `server/security.ts` |
| `src/commands/types.ts` | +22/-1 | `SlashCommand.args?: CommandArgsSpec`（缺省 = 不收参数 ⇒ 既有命令零变化）+ `handler(ctx, args)` 第二参 + `CommandContext.importSession(bundlePath)` |
| `src/commands/registry.ts` | +30 | 新增 `parseSlashCommand(input, commands)`：只认**声明了 `args`** 的命令，命令名与首个空白前的段**全等**（大小写不敏感），余串 trim 后作单个参数；`filterCommands` 未动 |
| `src/commands/useCommands.ts` | +2/-2 | `execute(command, args = "")` → `handler(ctx, args)`；缺省空串 ⇒ 既有 handler 签名与行为不变 |
| `src/commands/built-in.ts` | +18 | 新增 `import` 命令（`args: {placeholder:"bundle 路径", required:true}`，描述含用法）+ `handleImport`（空参数兜底给用法提示，不发给后端）；`/export`·`/clear`·`/clear-canvas` 未动 |
| `src/components/Chat/ChatInput.tsx` | +79/-26 | 新增可选 prop `onSessionsChanged`（缺省 no-op ⇒ 既有 UI 测试零改动）；`ExportNote`→`CommandNote`、`exporting`→`commandBusy`（导出与导入共用一套提示与并发闸门）、`showExportNote`→`showCommandNote`；新增 `runImportBundle()`（动态 import `import-session`，成功刷新会话列表）；`ctx` 增 `importSession`；`handleSelect` 对带参数命令改为**预填**；`handleSend` 先用 `parseSlashCommand` 截获带参数命令（缺参数给用法提示并预填），否则原样 `onSend` |
| `src/components/Chat/ChatPanel.tsx` | +1 | 给 `ChatInput` 传 `onSessionsChanged={fetchSessions}`（走既有 WS `session_list`，不新增消息类型） |
| `src/store/canvas-store.ts` | +31/-3 | `PreviewPanel.previewError?`；新 action `setPreviewPanelError()`；`openPreviewPanel` 的 `.catch()` 从「只 `console.error`」改为把原因挂上面板（404 给「数据不在本机 + 需重新加载」专用文案，其它给「预览失败：HTTP N（原因）」）；`updatePreviewPanelData` 成功时清 `previewError`。**未动**其中的「页面端口 +1」基址（X25 遗留 2，归口 T3.4） |
| `src/components/Canvas/FloatingPreviewPanel.tsx` | +13 | 有 `previewError` 时渲染 `role="alert"` 告警块并隐藏空表与分页页脚；无错时渲染完全不变 |
| `server/storage/paths.ts` | +11 | 新增 `importMetaPathFor(sessionFile)` = `<session>.jsonl.import.json`（sidecar 路径单一来源） |
| `server/session-history.ts` | +3/-1 | `deleteSession()` 挂上 `.import.json` 同生命周期删除（与 canvas/audit/injection/storage/share 一致） |

## 修改（文档）

| 文件 | ± | 摘要 |
|---|---|---|
| `docs/specs/06-backend.md` | +91/-4 | 文件结构表补 `session-import.ts` 与 `bundle-api.ts` 的新路由；`startBackend` 的 handler 职责更新；新增「session-import.ts / bundle-api.ts - session 导入（`/import`，T3.7）」整节：路由表、**20 条错误码表（HTTP × code × 含义）**、校验顺序与原子性五条、落地形态表（含哪些包内文件不落地及理由）、为什么必须改写 header、前端链路与 `PROTOCOL_VERSION` 未变的结论 |
| `docs/specs/08-commands.md` | +61/-3 | 文件结构表补 `import-session.ts`；类型定义补 `args`/`CommandArgsSpec`/`importSession`；新增「参数通道（T3.7）」小节（方案约束与匹配规则）；内置命令表补 `/import`；`parseSlashCommand` 说明；`execute(command, args?)`；新增「import-session.ts」整节（分工、用户裁决、反馈文案、导入会话的三类降级语义） |
| `docs/USER-MANUAL.md` | +64 | 6.4 命令表补 `/import <路径>` 与「带参数的命令」说明；新增 **7.7 会话打包导入（`/import`）——导出→导入的交接流程**（命令示例、五步交接表、「导入后什么能用/不能用」两张表、安全与确定性五条、常见拒绝原因）；§9 会话管理补「导入别人的会话」；FAQ 补 5 条（预览「数据不在本机」、`/import` 找不到包、校验和不符/夹带、列表里找不到、导入会话能否继续用）；术语表补「导入会话」 |

## 未改动（范围纪律核对）

- `scripts/verify-export-report.ts`、`src/utils/export-report.ts`、`src/components/Canvas/CanvasToolbar.tsx`：**零改动**（`verify:export` 148 项零回归）
- `server/share.ts`、`server/share-api.ts`、`src/components/Share/**`：零改动（T3.5 分享活视图语义未受影响）
- `src/types/ws-protocol.ts`：零改动 ⇒ `PROTOCOL_VERSION` 仍为 **1**
- `/api/canvas-storage`、`server/storage/s3-*.ts`、`server/security.ts`：零改动
- `docs/task-plan.json`：零改动（状态与 `verificationBaseline` 由主会话记账）
- `package.json` / `package-lock.json`：零改动（零新增依赖）
