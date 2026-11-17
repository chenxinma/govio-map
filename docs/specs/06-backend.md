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
| `server/table-relations.ts` | sourceTable 表间语义关系获取（图谱 RELATES_TO 主路径 + 字段级 references 降级，X10） |
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
| tableRelations | sourceTable | 表间语义关系（X10）：`Array<{targetTable, relationshipType, description?, sourceColumns?, targetColumns?, targetQualifiedName?}>`，由 `server/table-relations.ts` 解析（图谱 RELATES_TO 主路径 / 字段级 references 降级），前端据此建表间语义血缘边，并在节点内小节 / 边 label / 导出报告三处展示关系详情（X13，展示口径唯一来源 `src/utils/table-relations-ui.ts`；**X15 起三处只展示字段关联（列映射），不再展示 `relationshipType`，但服务端仍照原样解析并下发该字段供留痕**）；拿不到不写键。**X17 档 A**：图谱路径的关系由取数层 `withGraphQualifiedNames` 补 `targetQualifiedName`（= `b.full_table_name AS target` 原值，行没给 target 列不建键），字段级降级路径不建键；前端匹配第①级用它与节点 `qualifiedName` 做全等优先（大小写归一，命中即止），未命中退回变体兜底——旧事件/旧 sidecar 无该键时行为与 X10 完全一致 |
| tableRelationsSource | sourceTable | 关系来源留痕（X10）：`graph` / `fields`，仅在 tableRelations 非空时写键 |
| tableRelationsError | sourceTable | 图谱查询降级原因（X10）：仅 status=degraded 时写键，随 canvas sidecar 持久化以供审计 |
| referencedNodes | 全部 | 引用节点（自动附加） |

## govio-canvas.ts - Agent 扩展

### 注册工具: govio_create_source_table

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tableName | string | 是 | 物理表名 |
| database | string | 否 | 数据库名 |
| fields | Array<{name, type, description?, references?}> | 是 | 字段定义：`name`=物理列名(column_name)、`type`=数据类型(data_type)、`description`=描述名称(name)，三者均取自 govio 物理表字段结构查询结果，节点上同时展示 |
| datasource / datasourceType / schema / qualifiedName | string | 否 | 数据源标注（T2.0）：取值来源分层（图谱 → 数据源声明/config.yaml → 省略），规则见 `docs/specs/11-datasource-schema-conventions.md` |

执行后调用 `pushGovioNode({nodeType: "sourceTable", ...})`。

**表间关系无参数**（X10）：`execute` 内先 `await resolveTableRelations({tableName, qualifiedName, schema, fields, runQuery: deps.runGraphQuery})`——
图谱 `(:PhysicalTable)-[:RELATES_TO]->(:PhysicalTable)` 为主路径（表键双形匹配、列形状容错字符串/数组），
图谱不可用/超时/无结果时降级为字段级 `fields[].references`。该函数**永不 throw**，降级只写
`tableRelationsError` 留痕并 `console.warn`，绝不阻断节点创建；工具回执附 `relations: N (graph|fields)`。

**X17 档 A 不改查询**：`buildRelatesToCypher` 早已 `RETURN b.full_table_name AS target`，本增量只是把该原值
经 `withGraphQualifiedNames` 落成关系上的可选键 `targetQualifiedName`（零新增图谱查询）；落键发生在
`resolveTableRelations` 而非 `relationsFromGraphRows` 本体，后者输出形状保持不变（既有 27 例不修改即通过）。

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

不是「完全开放」：`server/security.ts` 的 `corsHeadersFor` 只**回显本地白名单 Origin**
（`http(s)://localhost|127.0.0.1|[::1]`，任意端口），非白名单/无 Origin 时不下发
`Access-Control-Allow-Origin`。放行方法 `GET, POST, DELETE, OPTIONS`（DELETE 供 T3.5「撤销分享」），
放行请求头 `Content-Type, If-None-Match`（后者供活视图轮询的条件请求），并
`Access-Control-Expose-Headers: ETag`（让跳源页面能读到活视图的 ETag 响应头）。
CORS 预检（OPTIONS）由 `handleParquetApi` 首位分支统一回 204。

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

## storage/ - 画布团队存储抽象（T3.1）

`server/session-history.ts` 的画布 sidecar 从「写死本地文件」抽象为可插拔后端；默认无配置即纯本地，行为与旧实现逐字节一致。

### 模块与契约

- `backend.ts`：`CanvasStorageBackend`（`read/write/remove/list`，write 支持 `ifMatch` 乐观锁，冲突抛 `StorageConflictError`）。
  主键是 `canvasId`（会话文件基名去 `.jsonl`），白名单正则拒绝穿越/分隔符——与 `assertValidSessionPath` 等价安全边界。
- `local-backend.ts`：`LocalCanvasBackend`，etag = 内容 sha256 前 16 位。
- `config.ts`：S3 profiles 配置文件（`GOVIO_S3_PROFILES_FILE` 覆写，缺省 `.govio/storage-profiles.json`）。
  **凭据只存环境变量名**（accessKeyIdEnv/secretAccessKeyEnv/sessionTokenEnv），运行时才从 `process.env` 取值；
  凭据不落画布 JSON、绑定 sidecar、分享记录、日志与分享链接（集成测试全工件深度断言）。
- `s3-client.ts` / `s3-backend.ts`：零依赖 SigV4 REST 客户端与 `S3CanvasBackend`；
  key 布局 `<prefix>/<canvasId>/canvas.json`（+ `shares/<shareId>.json`）。多端绑定同一 profile+canvasId 即共享画布。
- `canvas-storage.ts`：逐画布绑定 sidecar `<session>.storage.json`（`{backend:"s3", profile, canvasId, lastSyncedHash, remoteEtag}`）
  与同步门面。

### 写入模型与并发

- `saveCanvas` 同步写本地后 fire-and-forget 上传（内容 hash 未变跳过）；会话打开（`pushSessionState`）先
  `await refreshCanvasFromRemote` 拉对端更新（失败降级本地缓存，不阻塞交互）。
- 冲突策略：If-Match 探测并发 → 冲突时**最后写入胜出 + warn 留痕**；本地有未同步改动时 refresh 不强覆盖（返回 conflict）。
- `deleteSession` 级联：远端工件尽力删除 + 本地绑定 sidecar 删除 + 分享开关 sidecar（`.jsonl.share.json`，T3.5）删除。

## share.ts / share-api.ts - 只读分享「画布活视图」与 fork 续写（T3.5，取代 T3.2 快照语义）

分享不再是快照，而是**基于会话指纹 token 的画布活视图**：同一个链接恒定，内容随源画布实时变化
（前端 3s 轮询）。T3.2 的 `.govio/shares/*.json` 快照机制已**废弃删除**（不迁移、不做只读兼容，
旧随机 token 解析不到 → 404）。详见 `docs/tasks/T3.5-live-share-view/design.md`。

### 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/share-state` | GET | **当前会话**的分享开关状态 `{enabled, token, enabledAt}`；无活动会话 → 409 |
| `/api/shares` | POST | **开启**当前会话分享（**幂等**：重复调用返回同一 token）；无活动会话 → 409 |
| `/api/shares` | DELETE | **撤销**分享（删掉开关 sidecar，链接立即失效）；幂等 |
| `/api/shares/<token>` | GET | **当前**画布活视图载荷（不写任何快照文件）；带 `ETag`，`If-None-Match` 命中 → **304** 无 body；token 未开启/不存在/形状非法 → **404 `{error:"share-not-found"}`**（不区分「无此会话」与「已关闭」，不泄露存在性） |
| `/api/shares/<token>/fork` | POST | 从**当前活画布** fork 出可写副本（保留），暂存 `.govio/forks/<forkId>.json` |
| `/api/canvas-storage` | GET/POST | 逐画布 S3 绑定查询/配置（T3.1；不属分享链路，响应不含凭据） |
| ~~`/api/shares/<token>/rerun`~~ | ~~POST~~ | **T3.5 删除**：只读页禁止复跑（复跑会对服务端当前会话产生执行副作用），活视图语义下动手一律走 fork |

### token 与分享开关

- **token 派生**：`sha256("govio-share-v1:" + sessionId)` 前 32 位小写 hex（`sessionId` = 会话文件 basename
  去 `.jsonl`）。域分隔前缀防跨用途碰撞；形状与 T3.2 一致，`src/main.tsx` 的分享路由正则 `[a-f0-9]{32}`
  无需改动。同一会话链接**恒定**。
- **解析**：hash 不可逆 ⇒ 服务端只能「枚举 `.govio/sessions/*.jsonl` → 只保留分享已开启的 → 逐个算指纹 → 匹配」。
  sessionId→token 的派生索引按「sessions 目录路径 + 目录 mtime」缓存；`enabled` 一律**现读 sidecar** 确认，
  保证撤销立即生效（不被缓存拖住）。
- **开关 sidecar**：`<session>.jsonl.share.json` = `{version:1, enabled, enabledAt, token}`（路径函数
  `shareStatePathFor` 在 `server/storage/paths.ts` 保持单一来源）。**默认关**（无 sidecar 即未开启）；
  开关天然就是访问控制，撤销就是删除 sidecar（无需黑名单）；随 `deleteSession` 同生命周期删除。
  **仅本地**，不随 T3.1 同步到 S3。

### 活视图载荷与轮询契约

```jsonc
// GET /api/shares/<token> → 200
{ "readonly": true, "version": 1, "etag": "<画布内容 sha256 前 32 位>",
  "token": "...", "canvasId": "...", "sessionName": "...", "updatedAt": "<canvas sidecar mtime>",
  "canvas": { "nodes": [], "edges": [] }, "forkFrom": { "kind": "share" },
  "manifests": [ { "nodeId": "gov-2", "nodeTitle": "...", "nodeType": "sqlQuery", "manifest": {} } ] }
```

- 响应头：`ETag: "<etag>"` + `Cache-Control: no-store`（活视图绝不进浏览器 HTTP 缓存）。`etag` 同时进 body：
  跨源时读响应头要靠 `Access-Control-Expose-Headers`，body 里的值前端无条件可读。
- 轮询（`src/utils/share-poll.ts`）：基准 **3s**；带 `If-None-Match`，**304 / 指纹未变不回调 `onPayload`**
  （它是只读视图唯一的渲染触发源 ⇒ 不重渲染）；`document.visibilitychange` 隐藏**暂停**、恢复可见立即拉一次
  并重启计时；失败**指数退避 3→6→12→30s 封顶**并报「与源画布同步中断」，恢复后清除提示并复位；
  404（分享已撤销）终止轮询并渲染失效文案；组件卸载清理定时器与可见性监听。
- 轮询**走 HTTP**，不新增 WS 消息类型 ⇒ `PROTOCOL_VERSION` 保持 **1**（见 `docs/specs/07-websocket-protocol.md`）。
- 画布 sidecar 还没落盘时返回**空画布**（不是 404）：链接可以先开，内容随后长出来。

### 只读纪律（三层，继承 T3.2）

1. **视图层**：ReactFlow `nodesDraggable/nodesConnectable/elementsSelectable` 全关；五类节点组件经
   `ReadOnlyCanvasContext`（`src/hooks/useReadOnlyCanvas.ts`，默认 `false`）隐藏一切副作用入口；
2. **连接层**：`/share/*` 不建 `/ws`（`src/main.tsx` 分支），agent 会话与 `canvas_save` 通道物理不存在；
3. **API 层**：分享路由只有读活视图 / 暂存 fork，没有任何写源画布 sidecar 的入口；写只发生在开关 sidecar
   与 `.govio/forks/`。集成测试断言 GET/fork 前后源 `.canvas.json` 字节与 etag 恒定。

### fork 续写与派生血缘

`POST /api/shares/<token>/fork` → 服务端把**当前活画布**暂存 `.govio/forks/<forkId>.json`（含 `forkFrom`）
→ 前端跳转 `/?fork=<forkId>` → 主界面会话就绪后 WS `canvas_fork_apply {forkId}` → 写入**本地当前会话** sidecar
（顶层键 `forkFrom`）→ `fork_applied` + `canvas_restore` 水合成可写画布，暂存文件消费即删。血缘形状与 T3.2
一致（`forkFrom.shareId` 现在存的是派生 token）；`saveCanvas` 无 meta 调用时保留附加键（血缘抗 autosave）；
派生画布再分享时活视图载荷继承 `forkFrom`。

### 前端

- `/share/<token>` 独立静态页（`src/components/Share/ShareView.tsx`）：**复用主画布同一套 `nodeTypes`** 与边样式
  （语义边、X13/X15 关系详情、X18 口径徽标、Plotly 懒加载 chunk），右栏只读展示 Manifest 清单；
- 单例 `useCanvasStore` 灌远端数据前必须中和 persist（`src/components/Share/canvas-persistence.ts`），否则远端画布
  会被写进同源共享的 `localStorage['govio-canvas-state']`，顶掉本机画布；
- ChatPanel 头部分享入口改为**开关语义**（`src/components/Chat/ShareToggle.tsx`）；链接一律
  `shareLink(path, window.location.origin)`，API 一律 `apiBaseFrom(origin) ?? ''`（X25 模块）。
