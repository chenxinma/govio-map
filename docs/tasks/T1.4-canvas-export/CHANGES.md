# T1.4 改动清单

分支 `feature/phase1-trusted-analysis`。共 19 个文件（4 新增代码/脚本 · 1 新增样例产物 · 3 新增文档 · 6 修改代码 · 1 修改配置 · 4 修改文档；各项相加为 19，此前总数误写为 17）。

**没有新增任何 npm 依赖**；WS 协议、store 结构、节点数据类型、审计写入侧全部零改动。

## 新增文件

### 代码

| 文件 | 摘要 |
|------|------|
| `src/utils/export-report.ts` | 交付导出主模块（约 1500 行，8 个分节）。**上半部分是纯函数**（可在 Node 里直接跑）：`buildDeliveryReportHtml(input)` 组装整份 HTML（不读时钟、不碰 DOM、不发请求，同输入 → 同输出）；`layoutLineage()` 最长路径分层 + `lineageSvg()` 内联 SVG（盒子可点击跳卡片、贝塞尔连线带箭头 marker、环用 visiting 集合断开、悬空边/自环丢弃并计数 `droppedEdges`）；`renderNodeCard()` 与五类节点的 body 渲染器（sourceTable 字段表含 PK/FK→引用、sqlQuery SQL 全文 + 输出列、dataFrame 漂移/一致/失败状态框 + 列结构表 + **全量复跑记录** + Manifest 摘要、report 自带极简 markdown 渲染 `renderReportMarkdown()`、chart 静态图片或配置摘要）；`renderAppendixA()`（Manifest 总表 + 每节点 `<details>` SQL 全文，`permissionDecisionId` 三态：链接 / 未过确认门 / 旧节点无此字段）；`renderAppendixB()`（确认记录表：时间·类型·决策·来源·decisionId·耗时·改前命令·改后命令·备注/闸门·关联节点，同 decisionId 的锚点只给第一条）；转义与格式化工具 `esc()` / `truncate()` / `groupDigits()`（手写千分位，保证跨环境逐字节可复现）/ `formatTimestamp()`；`tracePointCount()` 只数数组长度不取值。**下半部分是浏览器侧副作用**：`renderChartImages()`（离屏容器 + `Plotly.newPlot(staticPlot)` + `toImage` SVG→PNG 降级 + `finally` purge/remove）、`apiBase()`、`fetchAuditAppendix()`（任何失败收敛成 `available:false` + 原因，不阻断导出）、`parseAuditEntries()`（白名单解析器：坏行跳过、未知字段丢弃）、`collectPermissionDecisionIds()`、`reportFileName()`、`downloadHtml()`（Blob + `a[download]`，4s 后 revoke）、`exportCanvasDeliveryReport()`（入口：并行渲染图表与拉审计 → 组装 → 下载 → 返回 `ExportOutcome`）。类型：`ChartRenderResult`/`ChartRenderMap`、`AuditEntryView`、`AuditAppendix`、`DeliveryReportInput`、`ExportOutcome`、`LineageBox`/`LineageEdgeView`/`LineageLayout`；常量 `NODE_COLORS`/`NODE_LABELS`（与画布 MiniMap 同值）、`CHART_RENDER`(680×400)、`MAX_TABLE_ROWS`(200) |
| `src/utils/export-report-style.ts` | 交付报告的内联样式表常量 `REPORT_CSS`（约 156 行）。文件头写明两条硬约束：不引用任何外部资源（无 `@import`、无 Google Fonts、无 CDN，字体退到本机栈）、配色沿用 `src/index.css` 的 light「Green Deck」令牌。含报头/摘要统计/告警框（warn·err·info·ok）/血缘图与图例/卡片网格与徽标/kv 与表格/`pre.sql`/`details`/report 正文/页脚，以及 `@media print`（打印或另存 PDF 时单列、去掉滚动裁剪） |
| `src/utils/manifest-labels.ts` | Manifest 展示措辞的单一来源（约 35 行）：`MANIFEST_ORIGIN_LABELS`、`manifestOriginLabel()`、`manifestModelLabel()`（`provider / id → responseModel`，人工执行为 `—（人工执行）`）。节点「详情」面板与交付报告附录 A 共用，避免同一份留痕两种叫法；纯常量与纯函数，不依赖 React |

### 脚本与样例产物

| 文件 | 摘要 |
|------|------|
| `scripts/verify-export-report.ts` | 可复跑验证脚本（`npm run verify:export`，交付时约 620 行 / **116 项断言**，R1 审查后增至 124 项且默认不再改写受跟踪样例（需 `--write`），见 docs/tasks/REVIEW-R1-fixes.md；失败退出码 1）。构造含全部五类节点的样例画布（2 源表 / 1 sqlQuery / 4 dataFrame 覆盖漂移·失败·一致·无留痕 / 2 chart 覆盖成功·降级 / 1 diff 报告；9 条有效血缘边 + 1 悬空边 + 1 自环），直接调纯函数产出 HTML 并分八节断言。不调 govio-cli、不调模型、不读数据内容、不碰 `.govio/` |
| `docs/tasks/T1.4-canvas-export/sample-export.html` | 上述脚本产出的样例交付报告（约 44 KB，10 节点 / 9 连线）。导出时间固定且脚本钉住 TZ=Asia/Shanghai → 同时区下逐字节可复现，可双击在浏览器离线打开人工复核；R1 审查后由 `--write` 重新生成（审计来源改为 basename） |

### 文档

`docs/tasks/T1.4-canvas-export/design.md`（方案与取舍 + 11 项遗留问题）、`CHANGES.md`（本文件）、`verification.md`（验证命令与关键输出）。

## 修改文件

### 服务端

| 文件 | 改动 |
|------|------|
| `server/parquet-api.ts` | +46 行，只加不改：① 新增只读路由 `GET /api/permission-audit?decisionIds=...`（放在 `/api/rerun-dataframe` 之后、`/api/preview` 之前，复用既有的 OPTIONS 预检与 `CORS_HEADERS`），调 `readPermissionAudit(sessionFile)` 按 `decisionIds` 过滤后返回 `{ sessionId, sessionFile, total, requested, entries }`；拿不到会话文件 → 409，异常 → 500；② 路由处注释写明**三条安全边界**（只读；只限当前会话——`sessionFile` 取自服务端会话单例、请求里没有任何路径参数，因此无目录穿越/越权；只过滤不加工）；③ 新增常量 `MAX_AUDIT_DECISION_IDS = 500` 与 `readPermissionAudit` 导入。既有路由（preview / sql-editor-init / skills / execute-sql / rerun-dataframe）逻辑一行未动 |

### 前端

| 文件 | 改动 |
|------|------|
| `src/components/Canvas/CanvasToolbar.tsx` | 加「导出交付报告」入口（+97/-14）：① 外层改为纵向 flex（按钮胶囊在上、提示条在下），原「SQL」按钮的样式与行为逐字未变；② 新按钮 `FileDown` 图标，**动态 `import('../../utils/export-report')`**（HTML 模板与样式不进主 bundle），从 `useCanvasStore.getState()` 取当下 `nodes`/`edges`，传 `appVersion: __APP_VERSION__`；③ `nodeCount === 0` 或导出中时禁用（`title` 分别说明「画布为空」与导出内容），导出中转 `Loader2` 图标；④ 成功/失败都用提示条显示 8s（`NOTE_TTL_MS`），成功含文件名·体积·节点数·图表静态渲染数，失败含原因；定时器在卸载时清理。不订阅 nodes 数组本身（只订阅 `nodes.length`），避免画布每次变更都重渲染工具栏 |
| `src/types/plotly.d.ts` | +12 行：给 `plotly.js-dist-min` 的模块声明补 `newPlot()` 与 `toImage()`（原本只声明了 `react` / `purge`）。按项目惯例只声明用到的表面，不引 `@types/plotly.js` |
| `src/utils/rerun.ts` | +12 行：新增 `RERUN_OUTCOME_LABELS`（复现一致 / 漂移 / 复跑失败）作为结论措辞的单一来源，导入 `RerunOutcome` 类型。**既有导出与逻辑（`MAX_RERUN_HISTORY` / `latestRerun` / `hasDrift` / `canRerun` / `withRerunRecord` / `formatRerunTime`）一行未改** |
| `src/components/Nodes/RerunStatus.tsx` | 3 行：`OUTCOME_META` 的 label 改从 `RERUN_OUTCOME_LABELS` 取（图标与颜色仍留在组件里），展示文本逐字不变 |
| `src/components/Nodes/ManifestDetails.tsx` | -21/+8：删掉本地的 `ORIGIN_LABELS` 与 `modelLabel()`，改用 `manifestOriginLabel()` / `manifestModelLabel()`；展示文本逐字不变（含「权限决策」行仍是 `permissionDecisionId ?? '未关联'`，本任务未改 T1.1/T1.3 的既有措辞） |

### 配置与文档

| 文件 | 改动 |
|------|------|
| `package.json` | 新增脚本 `"verify:export": "tsx scripts/verify-export-report.ts"`（复用既有 `tsx`，无新依赖） |
| `docs/specs/06-backend.md` | 路由表补 `/api/permission-audit` 一行；新增「GET /api/permission-audit」一节（参数、响应码表、三条安全边界、唯一消费者与白名单解析、CORS 现状与收紧归属） |
| `docs/specs/01-canvas.md` | 文件结构表补 `export-report.ts` / `export-report-style.ts`；CanvasToolbar 一节改为当前真实的两个按钮（SQL + 导出交付报告）并写出四步导出流程；把与现状不符的「恢复」按钮标注为历史设计（`restoreCanvas()` 目前无调用方，属既有状态、非本任务改动） |
| `docs/specs/02-nodes.md` | 文件结构表补 `src/utils/manifest-labels.ts`，`src/utils/rerun.ts` 一行补上 `RERUN_OUTCOME_LABELS` |
| `docs/task-plan.json` | T1.4 `status` 按状态协议 `pending → in_progress → done` + `history` 追加两条 + 顶层 `updatedAt` 刷新（未自置 accepted） |

## 未改动但相关的既有行为（确认无回归）

- **WS 协议零变更**：`src/hooks/useChat.ts`、`server/ws-handler.ts`、`server/govio-node-queue.ts` 未动。导出只读 HTTP + 前端 store，不新增任何 WS 消息类型。
- **store 零变更**：`src/store/canvas-store.ts` 未动，没有为导出新增 action/字段/持久化项；工具栏直接 `useCanvasStore.getState()` 读当下快照，导出结果不写回 store（因此也不会触发 `canvas_save`）。
- **审计写入侧零变更**：`server/permission-audit.ts` / `server/permission-manager.ts` 未动，只多了一个**只读**消费者；导出过程不产生新的审计条目、不触发确认门、不进 transcript。
- **T1.1/T1.2 的数据模型零变更**：`src/types/manifest.ts` / `src/types/rerun.ts` 未动；导出只读取 `node.data.manifest` 与 `node.data.rerunHistory`，不写任何留痕（`manifest.executedAt` 的刷新仍只由 T1.2 复跑链路负责）。
- **既有 `/export` 命令（JSON 快照）保留**：`src/commands/export-session.ts` 未动，与新交付报告并存（一个给机器、一个给人）。
- 验证脚本 `verify:manifest`（52）/ `verify:rerun`（62）/ `verify:audit`（86）全部照旧通过。
