# X6 用户手册 — 验证记录

> 验证方式：手册逐节条目 → 代码/规格出处对照（下表），全部为写作前实际读取核实；
> 另附「未交付功能自查」（ROADMAP Phase 2/3 关键词零命中）与构建/lint 回归确认。

## 1. 条目 → 出处对照表

### §2 安装与启动

| 手册条目 | 出处 |
|----------|------|
| `npm install` / `npm run dev` | package.json `scripts.dev="vite"`；README「快速开始」 |
| 打开 http://localhost:5173/ ，后端端口 5174 自动启动 | README「3. 启动开发服务器」；server/backend.ts `startBackend(port=5174)`；server/index.ts（Vite 插件挂接） |
| govio-cli 启动时自动安装/升级，需 uv 与联网，最低版本 0.6.0，`govio-cli -V` 验证 | server/govio-installer.ts `MIN_GOVIO_CLI_VERSION="0.6.0"`、`ensureGovioCli()`（`uv tool install … govio`）、`runGovioCliVersion()`；server/agent.ts:150 调用 |
| `.env` 四家 API Key 可选 | README「2. 配置环境变量」（ANTHROPIC/OPENAI/GEMINI/MISTRAL_API_KEY） |
| Electron Windows 安装包 | package.json `scripts.build:electron`、`build.win.target=["nsis"]`、`build.productName="Govio Map"` |

### §3 首次配置

| 手册条目 | 出处 |
|----------|------|
| 首次启动弹「配置 DeepSeek API Key」窗 | src/components/ConfigModal.tsx（标题、KeyRound 图标、文案「默认使用 DeepSeek」）；触发链：server/backend.ts `isAgentConfigNeeded()` → ws-handler.ts:435 `config_required` → useChat.ts `setNeedsConfig(true)` → AppLayout.tsx 渲染 ConfigModal |
| 「保存并启动」/「取消」按钮；取消后输入框禁用 | ConfigModal.tsx（submit 按钮文案）；ChatInput.tsx placeholder `needsConfig ? "请先配置 LLM Provider（右上角设置）"` + `disabled={!isConnected || needsConfig}` |
| LLM 设置窗：Provider 名称/Base URL/API 类型/API Key/模型列表（模型 ID+显示名称）/「添加模型」/「添加 Provider」/删除（垃圾桶）/保存/取消 | src/components/SettingsModal.tsx（标题「LLM 设置」及全部表单项与按钮文案） |
| 保存条件：名称/BaseURL/API 类型非空 + 至少一个模型 ID | SettingsModal.tsx `canSave` |
| 保存即生效、后端重启会话、画布不受影响 | ws-handler.ts:418-424（`save_models_config` → `restartAgentSession` → `pushSessionState`）；ws-handler.ts:174-182；useChat.ts `session_ready` → 1.5s 后 `sendCanvasSnapshot`（画布绑到新会话，不被清空：新会话无 canvas sidecar 则无 `canvas_restore`） |
| 对话面板底部「模型」下拉切换 | ChatPanel.tsx model selector（`modelOptions`/`selectModel`）；useChat.ts `sendSetModel` → ws-handler `set_model` |

### §4 界面总览

| 手册条目 | 出处 |
|----------|------|
| 顶栏「数据源」按钮（数据库图标） | Header.tsx（title="数据源"，Database 图标 → DataSourcesModal） |
| 顶栏「设置」按钮（齿轮图标） | Header.tsx（title="设置"，Settings 图标 → SettingsModal） |
| 对话面板「展开」按钮 → 大浮层宽至 1200px，再点/Esc 收回 | ChatPanel.tsx（Maximize2/Minimize2，title「展开对话」/「收回侧栏 (Esc)」，`width: "min(90vw, 1200px)"`，Esc 监听） |
| 「历史会话」按钮（时钟图标） | ChatPanel.tsx（History 图标，title="历史会话"，toggleSessions → fetchSessions） |
| 连接指示灯：绿「已连接」/红「未连接」 | ChatPanel.tsx（`isConnected ? "bg-brand" : "bg-error"` + 文案） |
| 画布/对话间可拖拽分隔条 | AppLayout.tsx `<ResizeDivider onResize=…>`；Layout/ResizeDivider.tsx |
| 布局 ASCII 图（查找栏顶部中间、工具栏右上、缩放左下、小地图右下） | NodeFindBar.tsx（`top-3 left-1/2`）；CanvasToolbar.tsx（`top-3 right-3`）；Canvas.tsx `<Controls>`（ReactFlow 默认左下）`<MiniMap>`（默认右下） |

### §5 画布与五类节点

| 手册条目 | 出处 |
|----------|------|
| 五类节点与颜色（紫/绿/橙/琥珀·紫/蓝） | docs/specs/02-nodes.md「颜色标识」表；src/types/index.ts 五种 NodeType；各 Node 组件 `border-l-node-*` |
| 数据源表：类型徽标（悬停显数据源名）、全限定名行 + 复制按钮（成功显对勾）、字段前 6 个 +「+N more fields」/「Collapse」、PK/FK 标签 | SourceTableNode.tsx（datasourceType 徽标 title、qualifiedName 行 + Copy/Check、`slice(0,6)`、展开按钮文案）；T2.0 design §2-3 |
| SQL 节点：「编辑」按钮开全屏编辑器；双击就地编辑（Ctrl+Enter 保存 / Esc 取消 / 失焦自动保存）；空 SQL 提示「双击编辑 SQL」；输出列标签 | SQLQueryNode.tsx（Maximize2「编辑」→ SQLModal、`handleDoubleClick`、`handleKeyDown`、`onBlur=handleSave`）；specs/02「SQLQueryNode 详情」 |
| SQL / DataFrame 节点「详情」按钮（有留痕才显示） | SQLQueryNode.tsx / DataFrameNode.tsx（`nodeData.manifest &&` 条件渲染 ScrollText「详情」） |
| DataFrame：「预览」悬浮面板（真实数据最多前 50 行、每页 10 行、可拖拽、X 关闭） | DataFrameNode.tsx「预览」→ canvas-store `openPreviewPanel`（`/api/preview?df=…&rows=50`）；FloatingPreviewPanel.tsx（`PAGE_SIZE=10`、标题栏拖拽、X）；server/parquet-api.ts `/api/preview` |
| DataFrame：列结构表超 10 列可展开/折叠；行×列/内存信息 | DataFrameNode.tsx（`slice(0,10)`、「+N more fields」/「Collapse」、entries/columns/memoryUsage） |
| DataFrame：漂移时头部「漂移」标签 + 卡片边框变警告色 | DataFrameNode.tsx（`hasDrift` → AlertTriangle「漂移」+ `border-warning/60`）；specs/02「一键复跑与漂移提示」 |
| 报告节点：类型色（diff 琥珀 / correlation 紫）、对比对象标签、Markdown 正文可滚动（max-h 400px）、「引用」/删除 | ReportNode.tsx；specs/02「ReportNode 详情」 |
| 图表节点：Plotly 渲染、「放大」按钮全屏（Esc 关闭）、「图表配置错误」降级文案、来源 DF 标签 | ChartNode.tsx（Maximize2「放大」→ ChartModal、hasError 文案）；ChartModal.tsx（Esc）；specs/02「ChartNode 详情」（bar/line/scatter/pie/doughnut）；src/types/index.ts ChartTrace（treemap 契约） |
| 所有节点底部「引用」+ 删除（垃圾桶） | 五个 Node 组件的 Quote「引用」/ Trash2 按钮 |
| 画布操作：拖拽吸附网格 15px、滚轮缩放 0.1–2、右侧圆点→左侧圆点连线、自动连线 | Canvas.tsx（`snapGrid=[15,15]`、minZoom/maxZoom、Handle 左 target/右 source）；specs/01「Canvas 配置」；canvas-store `createGovioNode`（引用关系自动建边） |
| 查找节点：按标题搜索、「N 个匹配」、Enter 循环定位居中、Esc/X 清除 | NodeFindBar.tsx（placeholder「查找节点…」、counter、`handleEnter` 循环 `centerOn`、Escape/清除按钮） |
| 小地图节点按类型着色 | Canvas.tsx MiniMap `nodeColor` switch |
| 工具栏「SQL」按钮新建空白 SQL 节点 | CanvasToolbar.tsx（title="创建 SQL 查询"）→ canvas-store `createManualSQLNode`（title "New Query"，空 SQL 自动进编辑态） |
| 工具栏「导出交付报告」：画布空时禁用、导出中转圈、完成提示条（文件名/体积/节点数） | CanvasToolbar.tsx（`disabled={exporting || nodeCount===0}`、Loader2、showNote 文案与 8s TTL、title 说明） |

### §6 对话取数基本流

| 手册条目 | 出处 |
|----------|------|
| Enter 发送 / Shift+Enter 换行 | ChatInput.tsx `onKeyDown`；placeholder 文案 |
| 流式回复：思考过程可折叠、工具胶囊（转圈/绿勾/红叉） | ChatMessage.tsx / specs/03「ChatMessage 组件」（折叠 Thinking、ToolPill 三态） |
| 插队发送（流式中输入并发送）、「停止」按钮中止 | ChatInput.tsx（isStreaming && value → title="插队发送"；Square title="停止"）；useChat.ts `send()`（streaming → `{type:"steer"}`）、`abort` |
| 「引用」→ 输入框标签（X 移除）→ 随消息发送；SQL 全文/DF 名/表结构作为上下文 | canvas-store `addReference`（sqlQuery→sql、dataFrame→dfName、sourceTable→表结构 JSON）；ChatInput.tsx 引用 chips + X；ChatPanel `handleSend`（附 referencedNodes 后清空）；README「引用节点到对话」 |
| 引用数据源表 → AI 用全限定表名避免试错 | specs/11「与画布节点的契约」（agent 表引用必须取 qualifiedName）；AGENTS.md SQL 生成纪律 1；T2.0 design §1（动机：盲猜表名三次试错） |
| 斜杠命令弹出/上下键/Enter/Esc | ChatInput.tsx `updateValue`+`onKeyDown`；CommandSuggestion.tsx；specs/08「斜杠命令交互」 |
| `/clear`「清理当前会话上下文」、`/clear-canvas`「清空画布节点与消息」、`/export` | src/commands/built-in.ts（handler：clearSession；clearCanvas+clearMessages；exportSession） |
| `/export` 下载 `govio-session-日期.json`（消息+画布） | specs/08「export-session.ts」（文件名模板、导出结构） |
| `/sql` `/analyze` `/release-df` `/导入元数据` 模板命令（选中填入输入框） | src/data/commands.json 四条；ChatInput `handleSelect`（custom → `updateValue(command.prompt)`） |
| `/skill:名称` 技能建议 | ChatInput.tsx `fetch("/api/skills")` → skillCommands；server/parquet-api.ts:88 `/api/skills` |
| 数据源面板：已配置数据源列表 + 上传图标预填「/导入元数据 数据源:xx schemas:」 | DataSourcesModal.tsx（title="导入元数据到知识图谱"、`govio:prefill-input` 事件 → ChatInput prefill 监听） |
| 数据源面板：已加载 DataFrame 表（名称/行数/列数）、「+」添加到画布、已上画布显对勾、刷新按钮 | DataSourcesModal.tsx（`handleAddToCanvas`、`dfNamesOnCanvas.has` → Check、RefreshCw title="刷新"）；数据来自 `observeInfo()`（useChat → `/ws observe_info`） |
| 「+」补的节点无留痕 → 无详情/复跑按钮 | DataSourcesModal `createGovioNode`（不传 manifest）；DataFrameNode.tsx（详情/复跑按钮以 `manifest`/`canRerun` 为条件） |

### §7 验证与交付

| 手册条目 | 出处 |
|----------|------|
| 复跑按钮存在条件：留痕固化了 SQL | DataFrameNode.tsx `canRerun(nodeData)`；utils/rerun.ts `canRerun = Boolean(data.manifest?.sql.trim())` |
| 复跑用留痕固化的 SQL/数据源（非当前输入），不影响已交付结果 | canvas-store `rerunDataFrame`（只传 nodeId）；server/dataframe-rerun.ts（临时 DF 名重跑、finally 释放）；T1.2 design |
| 四态：复跑中（转圈+按钮禁用「复跑中」）/复现一致（绿）/漂移（橙警告+差异摘要）/复跑失败（红+原因） | RerunStatus.tsx（headline 四分支）；DataFrameNode.tsx（`rerunning` → Loader2+「复跑中」+disabled）；specs/02 三态表；utils/rerun.ts `RERUN_OUTCOME_LABELS`（复现一致/漂移/复跑失败） |
| 「N 次」展开复跑记录（最新在前、上限 20、悬停看原值→新值/耗时/差异） | RerunStatus.tsx（`{history.length} 次` 展开、RecordRow title 明细）；utils/rerun.ts `MAX_RERUN_HISTORY=20` |
| 漂移不覆盖原结果；再次复跑一致警告自动消除 | specs/02「规则」（漂移 → Manifest 与展示行列都不改；一致后告警消除）；utils/rerun.ts `withRerunRecord`（identical 才刷新 executedAt） |
| 留痕字段表：来源/数据源/执行时间/行×列/校验和（结构哈希+SQL 哈希）/生成模型/会话/权限决策/SQL 全文 | ManifestDetails.tsx（Row 标签逐一对应）；src/types/manifest.ts；T1.1 design |
| 来源四种措辞：observe load / SQL 编辑器 / 助手消息 SQL / show dataframe | utils/manifest-labels.ts `MANIFEST_ORIGIN_LABELS` |
| 生成模型「—（人工执行）」 | manifest-labels.ts `manifestModelLabel` |
| 权限决策「未关联」显示 | ManifestDetails.tsx `manifest.permissionDecisionId ?? '未关联'` |
| 导出文件名 `govio-delivery-report-日期-时间.html`、单文件离线可开、双击即开 | T1.4 design §2/§9 |
| 报告章节：报告头（导出时间/版本/节点连线统计）、节点卡片快照、血缘图（点节点跳卡片）、附录 A（留痕总表+SQL 全文）、附录 B（权限确认记录） | T1.4 design §4（五类卡片）、§5（血缘 SVG + `#card-<id>` 锚点）、§6（附录 A 表列）、§7（附录 B 表列）；CanvasToolbar title「节点快照 + 血缘图 + Manifest 附录 + 权限确认记录」 |
| 不含数据行；图表静态图片、失败降级配置摘要并写明原因 | T1.4 design §8（previewData/trace 数组不导出）、§4 chart（staticPlot → data URL，降级写明原因） |
| 漂移节点在报告中有警示清单 +「原留痕未被覆盖」说明 | T1.4 design §4 dataFrame 小节 |
| 浏览器打印 → PDF | T1.4 design §1/§2（`@media print`、「打印到 PDF 已经可用」） |
| 附录 B「来源」区分用户/全局放行/超时/中止/重置 | T1.3 design §3（source 五取值）；server/permission-audit.ts |
| `/export` JSON 与交付报告分工「一个给机器、一个给人」 | T1.4 design §2 表 |

### §8 权限确认卡

| 手册条目 | 出处 |
|----------|------|
| 触发：AI 执行带 `-o`/`--output` 的取数命令；普通取数不弹 | docs/specs/10「触发条件」（OBSERVE_LOAD_RE ∧ OUTPUT_FLAG_RE）；server/extensions/govio-canvas.ts `shouldAskPermission` |
| 卡片：橙色「需要权限确认」+ 命令原文 | PermissionCard.tsx（ShieldAlert 文案、`<pre>{pending.command}`） |
| 四按钮：允许 / Accept All / 编辑 / 拒绝 | PermissionCard.tsx 四个按钮文案与图标 |
| 编辑 →「执行修改后命令」（未改动禁用）/「取消」 | PermissionCard.tsx（editing 态两按钮、`disabled={!draft.trim() || draft===command}`） |
| 各决策后果（允许执行/拒绝 AI 收到信息/编辑后 AI 改用新命令） | specs/10「架构」（allow 放行、deny block+reason、edit block+「用户修改为…」） |
| Accept All 本会话有效，清空/切换会话后恢复逐条确认 | specs/10「关键约束」（acceptAll 单例内存态，clearAll 关闭）；ws-handler.ts:315/344/177（clear/session_open/save_models_config 均 `permissionManager.clearAll()`） |
| 5 分钟超时自动拒绝 | specs/10（「pending 请求设 5 分钟超时自动 deny（source:"timeout"）」）；server/permission-manager.ts |
| 中止/清空/切换会话时未决卡自动拒绝 | specs/10（abort → deny「用户中止」）；permission-manager.ts:103-112（reset） |
| 每次确认（含放行期自动放行）写审计、附录 B 可查 | T1.3 design §3（放行也写完整两条，`source:"accept-all"`）；T1.4 design §7 |

### §9 会话管理

| 手册条目 | 出处 |
|----------|------|
| 消息自动持久化；画布随会话保存（变化后约 1 秒落盘） | useChat.ts（`sendCanvasSnapshot` + 1000ms 防抖订阅）；server/session-history.ts（`.canvas.json` sidecar，见 T1.3 design §2 文件布局） |
| 重开会话时消息与画布一起恢复 | ws-handler.ts `pushSessionState`（transcript + `canvas_restore`）；useChat.ts `canvas_restore` → `hydrateSession` |
| 浏览器刷新画布不丢 | canvas-store.ts persist（`name:'govio-canvas-state'`，partialize nodes/edges/referencedNodes） |
| 历史会话列表（名称/时间/消息数）、点击切换、悬停垃圾桶删除 | ChatPanel.tsx sessions dropdown（`s.name || s.preview || "(空会话)"`、toLocaleString+messageCount、Trash2 title="删除会话"、onClick openSession） |
| 删除会话连带删画布快照与审计记录 | T1.3 design §2（deleteSession 删 transcript + canvas sidecar + audit sidecar）；server/session-history.ts |
| 「加载更早消息」向上翻页 | ChatPanel.tsx（hasMoreHistory 按钮）；useChat.ts `loadMoreHistory`（`session_messages` + beforeEntryId）；ws-handler 分页 |
| `/clear` 重置 AI 上下文并清空消息；`/clear-canvas` 清空画布与消息 | built-in.ts + useChat.ts `clearSession`（ws `{type:"clear"}` → resetSession + getOrCreateSession）+ canvas-store `clearCanvas` |
| 切换/清空会话结束 Accept All 并自动拒绝未决确认 | ws-handler.ts:315-317、344-346（`permissionManager.clearAll()`）；permission-manager.ts:103-112 |

### §10 SQL 编辑器

| 手册条目 | 出处 |
|----------|------|
| 入口：SQL 节点「编辑」按钮；工具栏「SQL」新建后编辑 | SQLQueryNode.tsx（showModal）；CanvasToolbar.tsx |
| 语法高亮/行号/自动补全（画布表名/DF 名/列名） | SQLModal.tsx（CodeMirror + `sql()` + `createSQLCompletion(allSources)`、basicSetup lineNumbers）；Nodes/sql-completions.ts `getCompletionSources(nodes)` |
| Format 按钮 / Ctrl+Shift+F | SQLModal.tsx（`handleFormat`、title「格式化 SQL (Ctrl+Shift+F)」、keydown 监听） |
| 数据源下拉：memory（使用已加载的 DataFrame）/ 外部数据源（从数据库抽取） | SQLModal.tsx（`['memory', ...datasources]`、提示文案两句原文）；`/api/sql-editor-init`（parquet-api.ts:67） |
| 「执行」：成功提示「DataFrame "xx" 加载成功，节点已创建」、自动建节点并与当前 SQL 节点连线 | SQLModal.tsx `handleExecute`（成功文案原文）→ `/api/execute-sql`（parquet-api.ts:95）；SQLQueryNode.tsx `onExecuteSuccess`（找 dfName 节点建边） |
| 失败在下方显示错误信息 | SQLModal.tsx `executeResult type:'error'` 渲染 |
| 保存 Ctrl+Enter / 取消 Esc / 「保存」「取消」按钮 | SQLModal.tsx（keydown 监听 + 底部按钮 + 提示文案「Ctrl+Enter 保存 · ESC 取消」） |
| 编辑器执行不触发权限确认卡；留痕来源「SQL 编辑器」、模型「—（人工执行）」 | T1.3 design §8-3（/api/execute-sql 不过确认门，permissionDecisionId 恒 null）；manifest-labels.ts（'sql-editor': 'SQL 编辑器'；无 model → '—（人工执行）'） |

### §11 FAQ

| 手册条目 | 出处 |
|----------|------|
| 「未连接到服务器…」+ 输入框禁用 | ChatInput.tsx placeholder（`!isConnected`）；README（「后端未连接时输入框禁用并提示"未连接到服务器"」） |
| govio-cli 缺失且自动安装失败 → 看启动日志、装 uv/手动装、重启 | govio-installer.ts（uv 安装路径）；backend.ts（agentSetup 失败仅 console.error）；ws-handler.ts:473（`getOrCreateSession` 抛 "Agent not ready." → 前端收不到 `session_ready` → 指示灯保持「未连接」） |
| 「请先配置 LLM Provider（右上角设置）」 | ChatInput.tsx placeholder（needsConfig） |
| SQL 执行错误（Catalog/Binder/does not exist）→ 引用数据源表节点；"Did you mean" 提示直接发给 AI | AGENTS.md「SQL 生成纪律」1/3；specs/11「实证案例」（chocolate 三次试错对照表）；docs/tasks/BUGFIX-load-parse.md |
| 加载失败不建 DataFrame 节点 | server/extensions/govio-canvas.ts:128-135、471-473（success:false 不可信载荷不建节点） |
| 复跑报「该节点没有分析留痕（Manifest），无法复跑」等文案 | server/dataframe-rerun.ts `rerunBlockReason` 四条原文 |
| 附录 B「未获取到审计记录」+ 原因，不阻断导出 | T1.4 design §7（四种诚实形态、失败不阻断、绝不静默省略） |
| 「图表配置错误」 | ChartNode.tsx hasError 文案 |
| 预览空白（DF 已释放） | `/api/preview` 读 `.govio/observe/dataframes/*.parquet`（README、specs/01）；`/release-df` 命令（commands.json）释放后文件不存在 |

### §12 术语表

各术语均对应上文已核实条目：数据源（DataSourcesModal / observe 配置）、DataFrame（specs/02）、血缘（specs/00「可视化血缘编排」）、全限定名（SourceTableNode + specs/11）、分析留痕/Manifest（ManifestDetails + T1.1）、复跑/漂移（RerunStatus + T1.2）、校验和（manifest checksum + ManifestDetails title 文案「结构哈希含列名与 dtype，不含数据内容」）、确认门（specs/10）、交付报告（T1.4）。

## 2. 未交付功能自查（ROADMAP Phase 2/3 关键词零命中）

对手册全文执行 `grep`，以下关键词 **0 命中**（命令与结果见 CHANGES.md 验证记录）：

```
口径命中 / 语义血缘 / 口径溯源 / 冲突检测 / 团队存储 / 只读分享 / fork /
SSO / 多用户 / Docker / 定时调度 / 告警 / 协同编辑 / 自动更新 / 安装包签名 /
Prompt 约束 / 图谱注入
```

另按语义自查：手册不含任何「计划/即将/未来版本」表述；`/导入元数据` 与数据源面板上传按钮
是**已实现入口**（commands.json + DataSourcesModal 预填），仅描述按钮行为，不描述图谱约束
口径等 Phase 2 能力；「打印 → PDF」为 T1.4 design 明示的既有可用路径，非原生 PDF 导出承诺。

## 3. 面向非开发者自查

`grep` 手册全文：无 `src/`、`server/`、`.ts`/`.tsx`、组件/hook/store 名、WebSocket/JSONL/
sidecar 等实现词（命令见 CHANGES.md）。保留的专有名词仅限用户可见或安装必需：
govio-cli、uv、npm、Node.js、DeepSeek、Plotly、Electron、Manifest（括注）、observe load /
show dataframe（「详情」面板来源字段的用户可见原文）、`/api` 一律未出现。

## 4. 构建回归

纯文档任务，未改任何代码文件：

- `npm run build`：通过（详见 CHANGES.md）
- `npm run lint`：0 error
- markdown：标题层级 h1→h2→h3 连续，18 张表格列数对齐（人工复核）
