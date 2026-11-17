# T3.6 交付文件清单

单次 commit，message 前缀 `T3.6: `。设计与取舍见 `design.md`，验证与断言对账见 `verification.md`。

## 新增（源码）

| 文件 | 摘要 |
|---|---|
| `src/types/bundle.ts` | 打包的**前后端共享契约**（与 `src/types/share.ts` 同款约定）：`BUNDLE_FORMAT` / `BUNDLE_VERSION` / 包内固定路径常量（`bundle.json`、`report.html`、`session.jsonl`、`canvas.json`、`manifests.json`、`audit.jsonl`、`injection.jsonl`）/ `BUNDLE_SUFFIX` / `bundleFileName(token)` / `isSafeBundlePath()`（包内路径白名单，两端共用）/ 类型 `BundleFileEntry`、`BundleExcludedParquet`、`SessionBundlePayload`、`BundleManifest`。 |
| `server/session-bundle.ts` | 服务端**只读**收集会话文件集：`collectSessionBundle(sessionPath, {now?, maxTotalBytes?})` 过 `assertValidSessionPath` → 读 transcript / `.canvas.json` / `.audit.jsonl` / `.injection.jsonl`，派生 `manifests.json`（复用 `share.ts` 的 `extractManifests`），逐文件算 sha256 + base64；缺失 sidecar 记进 `missing`；`excludedParquetOf()` 给 parquet 排除记账（count/bytes/names/absent，dfName 走安全白名单）；`.storage.json` 本体不入包，只取 `readStorageBinding()?.profile` 引用名；`MAX_BUNDLE_TOTAL_BYTES = 64MB` 超限抛 `BundleTooLargeError`，文件不存在抛 `BundleSessionNotFoundError`。 |
| `server/bundle-api.ts` | HTTP 路由 `handleBundleApi`：`GET /api/session-bundle`（当前会话，无会话 409）、`GET /api/session-bundle?session=<path>`（指定会话，越界 400 / 不存在 404）、非 GET 405、未知路径不接管；响应 `Cache-Control: no-store`；CORS 走既有 `corsHeadersFor`（**未改** `security.ts`）。 |

## 新增（测试，共 44 例）

| 文件 | 用例数 | 摘要 |
|---|---|---|
| `tests/integration/session-bundle.test.ts` | **23** | 服务端收集器 + 路由。真实 sidecar 落盘后收集：五类文件全入包且 base64/sha256 与磁盘原字节逐条对账、`manifests.json` 与 `extractManifests` 一致、包内路径全部过 `isSafeBundlePath`（含 8 个非法样本反向断言）、缺失 sidecar 进 `missing`、token = `deriveShareToken(sessionId)` 且两次恒定/不同会话不同/不要求开启分享、载荷形状与固定时钟下逐字节可复现、`.storage.json` 只留 profile 名且假凭据/桶名/区域 anywhere 不出现、无绑定时 `storageProfile` 键缺省、`.share.json` 与孤儿 `.injection.zip` 不入包、parquet 记账（存在/缺失/去重/非法 dfName 不触盘）、穿越与越界路径被拒、幽灵会话 `BundleSessionNotFoundError`、超限 `BundleTooLargeError`（bytes/limitBytes/path）、路由 409/200/400/404/405/不接管/no-store/CORS 回显与非白名单不回显/畸形 URL 不炸。 |
| `tests/integration/export-bundle.test.ts` | **16** | 前端组装（载荷由**真实** `collectSessionBundle` 产出 ⇒ 前后端契约同一份）。产物用 `unzipSync` 反解：条目集合与包名 `<token>.govio-bundle.zip`、`bundle.json` 全字段、逐文件 sha256/bytes 可独立复核且不列自身、服务端 sha256 原样透传而 `report.html` 由前端补算、`report.html` 的数据源是**包内 canvas.json**（并沿用服务端 `exportedAt` 与推导基址）、两次打包字节一致（可复现）、空画布与无画布 sidecar 两条 `reportOmitted` 分支、parquet 记账透传、凭据反向断言（整包任何字节都不含假凭据/桶名/区域/`storage-profiles.json`）、dev 端口 +1 与生产同源相对路径两种基址、409/404/400/413/500 五种错误的人话提示且零下载、载荷形状与非法包内路径 8 种全部拒绝、无 `crypto.subtle` 时明确报错不产坏包、`fetchAuditForBundle` 基址纪律与三种降级（HTTP 错 / 网络错 / 坏 JSON）。 |
| `tests/ui/export-command.test.tsx` | **5** | jsdom。`/export` 命令描述已是打包语义（不再是「保存成json」）、选中即调 `exportSessionBundle` 并交出 `window.location.origin`、成功反馈含文件名/体积/文件数/含交付报告、排除 parquet 与无报告时如实说明、失败给明确提示、打包中重复触发不并发第二次。 |

## 修改（源码）

| 文件 | 摘要 |
|---|---|
| `src/commands/export-session.ts` | **重写**（28 行 JSON 快照 → ~300 行打包导出）。旧 `exportSession(messages, nodes, edges)` 删除；新增 `exportSessionBundle(deps)`（拉文件集 → 用包内 canvas 生成 `report.html` → WebCrypto 补算 sha256 → 组装 `bundle.json` → fflate `zipSync`（mtime 固定为 `exportedAt`）→ `a[download]`）、`fetchAuditForBundle()`（自带基址，替代 `export-report.ts` 里端口 +1 硬编码那份）、`BundlePayloadError`、载荷形状与包内路径校验。全部外部依赖（fetch / hash / download / buildReport / now）可注入。 |
| `src/components/Chat/ChatInput.tsx` | `ctx.exportSession` 改为触发异步打包（**动态 import** `commands/export-session`，与 CanvasToolbar 对 `export-report` 的做法一致 ⇒ fflate 与报告模板不进主 bundle）；新增输入框上方一句话反馈条（打包中 / 成功 / 失败，8s TTL，与 CanvasToolbar 同款形态）与并发保护；删除只为旧实现存在的 `messages` / `nodes` / `edges` props。 |
| `src/components/Chat/ChatPanel.tsx` | 同步删掉传给 `ChatInput` 的 `messages` / `nodes` / `edges`（含非响应式的 `useCanvasStore.getState()` 取值）。 |
| `src/commands/built-in.ts` | `/export` 描述改为「打包导出当前会话为 zip（画布 + 对话 + 留痕 + 交付报告）」；handler 仍只调 `ctx.exportSession()`（加注释说明异步与反馈归 ChatInput）。 |
| `src/commands/types.ts` | `CommandContext.exportSession` 补文档注释（异步实现、反馈由调用方展示）；接口形状未变。 |
| `server/backend.ts` | 请求链新增第三棒：`handleParquetApi` → `handleShareApi` → **`handleBundleApi`** → 404 兜底。 |
| `server/storage/paths.ts` | 新增 `DATAFRAME_PARQUET_DIR` / `dataframeParquetDir()` / `dataframeParquetPathFor(dfName)`（dfName 安全白名单，非法名返回 `null` 不触盘），保持「路径规则单一来源」的既有纪律。 |
| `package.json` / `package-lock.json` | 新增依赖 **`fflate@^0.8.3`**（decisions ② 已批准）；lockfile 的 `version` 字段随之从 0.7.0 同步到 0.7.2（吸收既有漂移，见 design.md 遗留 8）。 |

## 修改（文档）

| 文件 | 摘要 |
|---|---|
| `docs/specs/06-backend.md` | 文件结构表补 `session-bundle.ts` / `bundle-api.ts`；`startBackend` 的路由链更正为三棒；新增「session-bundle.ts / bundle-api.ts - session 打包（`/export`，T3.6）」整节：路由表、载荷形状、打包清单（入包/排除）、5 条安全边界、前端组装流程与基址纪律。 |
| `docs/specs/08-commands.md` | 文件结构表、`CommandContext`（补 `clearSession` 与 `exportSession` 注释）、内置命令表 `/export` 一行；「export-session.ts」整节重写为 T3.6 语义（与只读分享的分工、产物表、包内布局、5 步流程、反馈与失败文案）。 |
| `docs/USER-MANUAL.md` | 6.4 斜杠命令表 `/export` 一行；新增 **7.6 会话打包导出（`/export`）**（包里有什么、四条要点：不可变留痕 / 不含数据内容但记账 / 不含凭据 / 仅浏览器下载）；7.4 与 7.5 里「`/export` 是 JSON 快照」的旧表述改为指向 7.6；FAQ 补 3 条（无活动会话 / 会话文件过大 / 非安全上下文）；术语表补「会话打包（bundle）」。 |
| `docs/tasks/T1.4-canvas-export/design.md` | 顶部加「与 T3.6 的关系」标注：按钮链路与 `export-report.ts` 一字未改、148 项断言零回归，T3.6 只把产物作为 `report.html` 入包并复用其纯函数（唯一不复用的是端口 +1 硬编码的 `fetchAuditAppendix`）。 |
| `docs/tasks/T3.2-sharing-fork/design.md` | 未改动（T3.5 已加过语义取代标注，本任务与它无关）。 |

## 未改动（范围纪律核对）

- `src/utils/export-report.ts`、`src/components/Canvas/CanvasToolbar.tsx`、`scripts/verify-export-report.ts`：**零改动**（`verify:export` 148 项一项未动）
- `server/share.ts`、`server/share-api.ts`、`server/security.ts`、`src/types/ws-protocol.ts`：零改动（只 **import** `share.ts` 的 `deriveShareToken` / `sessionIdFromFile` / `extractManifests`；`PROTOCOL_VERSION` 仍为 1）
- `/api/canvas-storage`、`server/storage/s3-*.ts`、`/ws` 与 `/canvas` 通道：零改动
- T3.6 不碰 T3.7 的导入链路（本仓库尚无导入实现）
- `docs/task-plan.json`：零改动（状态与 `verificationBaseline` 由主会话记账）
