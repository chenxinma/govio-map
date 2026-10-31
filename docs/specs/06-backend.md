# Backend 后端服务

## 概述

后端作为 Vite 插件运行，在 Vite dev server 启动时创建独立 HTTP+WebSocket 服务器（端口+1），提供 AI Agent 会话和画布通信能力。

## 文件结构

| 文件 | 职责 |
|------|------|
| `server/index.ts` | Vite 插件入口 |
| `server/backend.ts` | HTTP + WS 启动，agent 初始化流程 |
| `server/ws-handler.ts` | WebSocket 消息处理 |
| `server/agent.ts` | pi-coding-agent 会话管理（持久化） |
| `server/govio-node-queue.ts` | 节点事件批量队列 |
| `server/analysis-manifest.ts` | Analysis Manifest 构建与校验和计算（Phase 1 KR1） |
| `server/dataframe-rerun.ts` | DataFrame 一键复跑与漂移判定（Phase 1 KR2） |
| `server/govio-cli-exec.ts` | 数组参数方式调用 govio-cli（SQL 全文不经 shell 拆分） |
| `server/extensions/govio-canvas.ts` | Agent 扩展（工具注册 + 事件拦截 + treemap 解析） |
| `server/parquet-api.ts` | HTTP API（parquet 预览 / SQL 执行 / DataFrame 复跑） |
| `server/permission-manager.ts` | observe load 权限审批（确认门）+ 决策 ID / 审计写入（Phase 1 KR3） |
| `server/permission-audit.ts` | 权限确认审计留痕：`<session-file>.audit.jsonl` 追写 / 读回 / 删除（Phase 1 KR3） |
| `server/session-history.ts` | 会话列表/删除（含 canvas 与审计 sidecar）/画布 sidecar/transcript 分页 |
| `server/models-config.ts` | 多模型配置管理 (~/.pi/agent/models.json) |
| `server/govio-installer.ts` | govio-cli + skills 自动安装 |
| `server/cli.ts` | CLI 命令行入口 |

## index.ts - Vite 插件入口

### 插件名

`ws-plugin`

### 启动流程

1. `configureServer` 钩子触发
2. 等待 Vite server listening 事件
3. 在 `port+1` 调用 `startBackend()` 启动独立 HTTP + WS 服务器

## backend.ts - 后端启动

### startBackend(port)

1. 创建 HTTP Server，`/api/preview` 路由由 `handleParquetApi` 处理，其他 404
2. 调用 `setupWebSocket(httpServer)` 设置双端点 WebSocket
3. 检查 `ensureModelsConfig()` 是否存在 models.json
   - 存在 → 调用 `agentSetup()` 初始化 Agent
   - 不存在 → 设置 `agentConfigNeeded = true`，等待前端配置

### Electron 模式

Electron main 进程调用 `startBackend(5174)`，前端通过 `window.location.port + 1` 连接。`agent.ts` 中 `ensureElectronRunAsNode()` 确保子进程以 Node 模式运行而非 Electron。

## agent.ts - Agent 会话管理

### agentSetup()

1. 创建 `DefaultResourceLoader`，配置：
   - 扩展工厂：`govioCanvasExtension(pi)`
   - pi-subagents：项目 npm 依赖，通过 `additionalExtensionPaths` 加载
   - Skills 过滤：仅保留 browser/search/govio/eda/observe/pi-subagents/council-mode
   - 全局副本去重：过滤 `~/.pi/agent` 下的 pi-subagents 副本避免工具冲突
2. 调用 `resLoader.reload()` 加载资源
3. 调用 `ensureGovioCli()` 确保 govio-cli 可用（不存在则自动安装）
4. 调用 `downloadGovioSkills()` 下载技能包
5. 日志输出 ">>> Server agent ready. <<<"

### getOrCreateSession()

单例模式，返回 `AgentSession`：
- `cwd`: `process.cwd()`
- `sessionManager`: 首次调用 `SessionManager.continueRecent()` 恢复最近会话，后续 `SessionManager.create()` 新建
- 会话文件：`.govio/sessions/<ts>_<id>.jsonl`
- 画布 sidecar：`<session-file>.canvas.json`
- 权限审计 sidecar：`<session-file>.audit.jsonl`（见 `permission-audit.ts`）

模块加载时调用 `setAuditSessionResolver()`，把「当前会话 ID + transcript 文件路径」供给审计模块（会话单例在本模块，反向依赖会形成循环导入）。

### openSessionFile(path)

切换到指定历史会话文件，重置当前 session 后以 `SessionManager.open()` 继续。

### runGovioCli(cmd)

通过 `child_process.execFile` 异步执行 `govio-cli <cmd>`，15 秒超时。

## govio-node-queue.ts - 节点事件队列

### 设计模式

批量事件队列：Agent 执行期间积累节点事件，在 `tool_execution_end` 和 `message_end` 时批量刷新发送。

### 导出

| 导出 | 类型 | 说明 |
|------|------|------|
| GovioNodeType | type | "sqlQuery" / "dataFrame" / "report" / "sourceTable" |
| GovioNodeCreateEvent | interface | 节点创建事件（含所有节点类型的可选字段） |
| setCurrentReferencedNodes | fn | 设置当前引用节点（线程级） |
| clearCurrentReferencedNodes | fn | 清空引用 |
| pushGovioNode | fn | 入队一个节点事件，自动附加当前引用节点 |
| flushGovioNodes | fn | 排空队列，返回所有事件 |
| emitFlushed | fn | 触发 "flushed" 事件 |
| onGovioNodesFlushed | fn | 订阅 flush 事件，返回 unsubscribe |

### GovioNodeCreateEvent 字段

| 字段 | 适用类型 | 说明 |
|------|---------|------|
| nodeType | 全部 | 节点类型（含 chart） |
| title | 全部 | 标题 |
| sql | sqlQuery | SQL 语句 |
| outputColumns | sqlQuery | 输出列 |
| dfName | dataFrame | DataFrame 名称 |
| sourceName | dataFrame | 数据源名 |
| totalRows | dataFrame | 行数 |
| totalColumns | dataFrame | 列数 |
| memoryUsage | dataFrame | 内存占用 |
| columns | dataFrame | 列信息数组 |
| reportType | report | "diff" / "correlation" |
| content | report | 报告内容 |
| sourceRefs | report/dataFrame | 数据源引用（自动连线） |
| tableName | sourceTable | 表名 |
| database | sourceTable | 数据库名 |
| fields | sourceTable | 字段列表 |
| config | chart | Plotly figure {type, data[], layout?} |
| sourceDf | chart | 数据源 DataFrame 名称 |
| manifest | dataFrame/sqlQuery | 分析留痕 Analysis Manifest（类型见 `src/types/manifest.ts`，服务端填充后写入 `node.data.manifest`） |
| referencedNodes | 全部 | 引用节点（自动附加） |

## govio-canvas.ts - Agent 扩展

### 注册工具: govio_create_source_table

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tableName | string | 是 | 物理表名 |
| database | string | 否 | 数据库名 |
| fields | Array<{name, type, description?, references?}> | 是 | 字段定义：`name`=物理列名(column_name)、`type`=数据类型(data_type)、`description`=描述名称(name)，三者均取自 govio 物理表字段结构查询结果，节点上同时展示 |

执行后调用 `pushGovioNode({nodeType: "sourceTable", ...})`。

### 注册工具: govio_show_chart

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 图表标题 |
| sourceDf | string | 否 | 数据源 DataFrame 名称 |
| config.data | Array<Trace> | 是 | Plotly traces |
| config.layout | object | 否 | Plotly layout |

支持的 trace 类型：bar, line, scatter, pie, doughnut, treemap。

执行前调用 `resolveChartConfig()`：
- line → scatter (mode=lines+markers)
- doughnut → pie (hole=0.6)
- treemap → 服务端通过 `resolveTreemapTrace()` 从 ObserveStore 获取数据并构建层级
- 设置紧凑 margin 默认值

执行后调用 `pushGovioNode({nodeType: "chart", ...})`。

### 注册工具: govio_show_dataframe

将已加载的 ObserveStore DataFrame 展示为可预览的 DataFrame 节点。通过 `govio-cli observe info --name <dfName> --rows 0` 获取 schema（不拉取数据行）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| dfName | string | 是 | DataFrame 名称 |
| title | string | 否 | 节点标题 |
| sourceName | string | 否 | 数据源标签 |

### 拦截 tool_result 事件

监听 bash 工具的执行结果，当命令包含 `govio-cli observe` 时：

| 子命令 | 处理函数 | 生成节点 |
|--------|---------|---------|
| load | handleLoadResult | DataFrame（解析 rows/columns/column_info） |
| compare | handleCompareResult | Report (diff)（格式化 schema + data 对比） |
| explore | handleExploreResult | Report (correlation)（格式化列相似度/外键关系表） |
| release | (暂未实现) | - |

### 拦截 message_end 事件

从助手消息中提取 SQL 代码块：
1. 匹配 ` ```sql ... ``` `（排除 `MATCH` 开头的 Cypher 语句）
2. 提取 `SELECT` 列和 `FROM` 表名
3. 提取 DataFrame 名称（匹配 "命名"/"df_" 模式，或自动递增 `df_query_N`）
4. 对每个 SQL 块 `pushGovioNode({nodeType: "sqlQuery", ...})`

## parquet-api.ts - HTTP API

### 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/preview` | GET | 读 parquet 返回预览数据行 |
| `/api/sql-editor-init` | GET | SQL 编辑器的数据源与 DataFrame 列表 |
| `/api/skills` | GET | pi 已加载的 skill 列表 |
| `/api/execute-sql` | POST | SQL 编辑器人工执行（`observe load`）并建节点 |
| `/api/rerun-dataframe` | POST | 按 Manifest 固化的 SQL 复跑 DataFrame 并对比漂移（Phase 1 KR2） |
| `/api/permission-audit` | GET | 只读返回**当前会话**的权限确认记录（Phase 1 KR4 交付报告附录 B） |

所有路由都由 `handleParquetApi` 处理（dev 的 Vite 插件与 Electron 生产模式共用）；dev 下前端经 Vite 的 `/api` 代理，Electron 下前端直接请求 `localhost:{port+1}`。

### GET /api/preview

#### 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| df | string | 必填 | DataFrame 名称（对应 .parquet 文件） |
| rows | number | 10 | 返回行数上限 |

#### 流程

1. 解析路径：`.govio/observe/dataframes/{df}.parquet`
2. 检查文件存在性
3. 使用 `hyparquet` 读取 parquet 对象（rowEnd 限制）
4. JSON 序列化：bigint 转 string，非原生对象转 `[ClassName]`
5. 设置 Content-Length，返回 JSON

#### 错误处理

- 缺少 df 参数 → 400
- 文件不存在 → 404
- 读取失败 → 500

### GET /api/permission-audit

查询参数：`decisionIds=<id,id,...>`（**必填**，逗号分隔；缺失或过滤后为空 → 400，不提供「缺省全量返回当前会话命令历史」的能力）。服务端最多取前 200 个 ID 参与过滤（保证请求行落在 Node 16KiB 头限制内），发生截断时响应带 `truncated: true`。

| 响应 | 含义 |
|------|------|
| 200 `{ sessionId, sessionFile, total, requested, truncated?, entries }` | `total` = 会话内记录总数；`requested` = 实际请求的 ID 数（截断前）；`truncated` 仅在请求 ID 数超过 200 时出现且为 true；`entries` = 过滤后带出的记录（`PermissionAuditEntry[]` 原样） |
| 400 | `decisionIds` 缺失或解析后为空 |
| 409 | 当前没有已落盘的会话（`getSessionFile()` 为空），读不到审计 sidecar |
| 500 | 未预期异常 |

安全边界（三条，见路由处注释）：**只读**（只调 `readPermissionAudit()`，不写不删不执行命令、不读数据内容）；**只限当前会话**（`sessionFile` 取自服务端会话单例，请求里没有任何路径参数，因此不存在目录穿越或越权读其他会话）；**只过滤不加工**（`decisionIds` 只决定返回哪些条目）。

唯一消费者是交付导出（`src/utils/export-report.ts` 的 `fetchAuditAppendix()`）：按画布节点 Manifest 的 `permissionDecisionId` 过滤，渲染成附录 B；发生截断时报告附录 B 必须如实告知「仅带出前 200 个 decisionId」，且只渲染 `sessionFile` 的 basename（不外泄操作者本机绝对路径）。前端把返回值当不可信输入，用白名单解析器 `parseAuditEntries()` 收敛成 `AuditEntryView`（坏行跳过、未知字段丢弃）。CORS 姿态与其余 `/api/*` 一致（`*`），收紧属 X1 安全基线。

### POST /api/rerun-dataframe

请求体：`{ nodeId }`（**仅此一个字段**）。

| 响应 | 含义 |
|------|------|
| 200 `{ record }` | 复跑执行完成，`record` 为 `RerunRecord`（`outcome` 为 identical / drift / error），前端追加到 `node.data.rerunHistory` |
| 400 | 缺 `nodeId` |
| 409 | 当前会话的 canvas sidecar 里找不到该节点的 Manifest（画布未保存或会话不匹配） |
| 500 | 未预期异常 |

流程：
1. `readManifestFromCanvas(nodeId)`：`getSession().sessionManager.getSessionFile()` → `loadCanvas()` → 按 nodeId 取 `data.manifest`。复跑的 SQL **只认服务端持久化的留痕**，不接受前端传入，避免「复跑」退化成「重跑当前输入」
2. `rerunDataFrame(manifest, { sessionId })`（`server/dataframe-rerun.ts`）执行并对比
3. 不可复跑 / CLI 失败 也返回 200 + `outcome: 'error'` 的记录（复跑失败也要留痕）；只有「找不到留痕」这类请求级错误走 4xx

### CORS

完全开放（Allow-Origin: *），支持 GET/OPTIONS。

## dataframe-rerun.ts - DataFrame 复跑与漂移判定

复跑是**验证动作**，不是重新取数：

1. 用 Manifest 固化的 `sql` + `datasource` 执行 `observe load`，但写入临时名 `rerun_tmp_<dfName>_<ts><rand>`，**不覆盖已交付的同名 DataFrame**（否则节点留痕与 ObserveStore 里的实际数据不一致，漂移时还会销毁业务方已拿到的结果）
2. 用 T1.1 同一套 `computeChecksum` 对比原 Manifest；不读任何数据内容，只用 `observe load` 输出的 `rows` / `columns` / `column_info`
3. 无论成败都在 `finally` 里 `observe release` 临时 DataFrame，避免残留被 `restoreCanvas`（`observe list`）补成画布节点；释放失败只告警，记录里带 `tempDfName` 可手工清理

### 导出函数

| 函数 | 职责 |
|------|------|
| `rerunBlockReason(manifest)` | 复跑前置校验（SQL / 数据源 / dfName 必须为非空字符串；dfName 不限字符集，临时名由 `tempDfNameFor` 归一化），返回不可复跑原因或 null |
| `tempDfNameFor(dfName, now)` | 归一化成 CLI 安全的临时 DataFrame 名 |
| `buildRerunLoadArgs(manifest, tempName)` | 组装 `observe load` 数组参数（`datasource === 'memory'` 走 `--memory`） |
| `parseLoadOutput(stdout)` | 解析 load/info 输出（兼容 `column_info.name` 与 `schema.column`），截断/`success: false` 返回 null |
| `compareRerunResult(manifest, result)` | 判定 identical / drift 并生成中文差异摘要 |
| `manifestSnapshot(manifest)` | 原 Manifest 的对比基线快照（记录的 `before`） |
| `rerunDataFrame(manifest, options)` | 完整复跑（永不抛错，失败转 `outcome: 'error'` 记录）；`options.runCli` / `now` 可注入，供验证脚本使用 |

### 漂移判定优先级

1. 双方都有校验和 → 比 `schemaHash`（覆盖行数、列数、列名、dtype、列顺序）
2. 原留痕无校验和但有行数 → 退化到行数/列数对比（不能因为「哈希缺失」就报漂移）
3. 原留痕连行数也没有 → `diff.baselineIncomplete = true`，按漂移处理（宁可告警，也不给假的「复现一致」绿灯）

`sqlHash` 不参与判定：复跑用的就是 Manifest 里那份 SQL，重算必然相同。

### 超时

`observe load` 120s（重查询比 SQL 编辑器的 30s 更宽），`observe release` 15s；均由 `govio-cli-exec.ts` 的 `runGovioCliWithArgs(args, timeoutMs)` 控制。

复跑不经 agent（不消耗模型、不进 transcript），也不经 permission-manager（与现有 `/api/execute-sql` 一致）；因此复跑产生的对比记录没有 `decisionId`，审计只覆盖 agent 发起的取数（T1.3 已落地，详见 `permission-audit.ts` 一节）。

### 验证

`npm run verify:rerun`（mock runner）/ `npm run verify:rerun -- --real`（额外走真实 govio-cli + `sales` 数据源），见 `docs/tasks/T1.2-dataframe-rerun-drift/verification.md`。

## permission-audit.ts - 权限确认审计留痕

把「这个数是谁批准的」落成可质证的记录（Phase 1 KR3）。设计约束：**只追加不回改**、**写失败不阻断确认流**、**不记数据内容**。

### 存储

| 项 | 值 |
|------|------|
| 路径 | `<session-file>.audit.jsonl`（`auditPathFor()`），与 `.canvas.json` 同目录同生命周期 |
| 格式 | JSONL，一行一条记录（命令含换行也不拆行，JSON 转义保证） |
| 删除 | `session-history.deleteSession()` 调 `deletePermissionAudit()`；幂等，文件不存在返回 false |
| 会话归属 | `setAuditSessionResolver()` 注入（`agent.ts` 注册）；拿不到会话文件时条目丢弃并告警 |

### 记录类型

| `type` | 时机 | 关键字段 |
|--------|------|----------|
| `permission_request` | 确认门被触发（含放行模式下的自动确认） | `command` 原文、`gate`（`ask`/`accept-all`）、`followsDecisionId?` |
| `permission_decision` | 决策落定 | `decision`、`command`（改前）、`editedCommand?`（改后）、`reason?`、`source`、`elapsedMs` |
| `permission_mode` | Accept All 开关真正变更 | `acceptAll`、`reason`、`pendingAffected` |

共有字段：`v`（结构版本 = `PERMISSION_AUDIT_VERSION`）、`at`、`decisionId`、`sessionId`、`sessionFile`。`source` 取值：`user` / `accept-all` / `timeout` / `abort` / `reset`。

### 导出

| 导出 | 职责 |
|------|------|
| `auditPathFor(sessionFile)` | 审计 sidecar 路径 |
| `setAuditSessionResolver(fn)` / `currentAuditSession()` | 注册 / 读取当前会话归属（验证脚本可指向临时目录） |
| `appendPermissionAudit(input)` | 追写一条，补齐 `v`/`sessionId`/`sessionFile`；失败返回 `null` 而不抛错 |
| `parsePermissionAuditLine(line)` | 单行解析；坏行/空行返回 null |
| `readPermissionAudit(sessionFile)` | 读回全部记录（文件不存在返回空数组） |
| `deletePermissionAudit(sessionFile)` | 删除 sidecar |

### 与 Manifest 的关联

`permission-manager` 为每次确认生成 `decisionId`（= 前端回传的 `requestId`），并把「会导致执行」的决策（allow 的原命令 / edit 的改后命令）存入索引；`govio-canvas.ts` 在 `observe load` 的 `tool_result` 里用 `decisionIdForExecution(cmd, event.toolCallId)` 取值（toolCallId 精确匹配、命令文本兜底），写进 `node.data.manifest.permissionDecisionId`。反查：节点「详情」面板的决策 ID → 该会话 `.audit.jsonl` 按 `decisionId` 检索。

### 验证

`npm run verify:audit`（97 项断言，不调 govio-cli / 不调模型；交付时 86 项，R1 后 96、R2 后 97，见 docs/tasks/REVIEW-R1-fixes.md 与 REVIEW-R2-fixes.md），见 `docs/tasks/T1.3-permission-audit-trail/verification.md`。

## cli.ts - 命令行入口

通过 `npm run ask -- -m "你的问题"` 调用。

| 参数 | 说明 |
|------|------|
| -m, --message | 必填，提示内容 |
| -n, --new | 可选，新开会话（默认续接最近一次会话历史） |
| -r, --raw | 可选，输出原始 AgentEvent JSON |
| -o, --output | 可选，输出写入文件 |

输出格式：NDJSON（每行一个 JSON 对象），包含 text_delta、thinking_delta、tool_start/end、message_start/end 等事件。
