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
| `server/extensions/govio-canvas.ts` | Agent 扩展（工具注册 + 事件拦截 + treemap 解析） |
| `server/parquet-api.ts` | Parquet 文件预览 API |
| `server/permission-manager.ts` | observe load 权限审批 |
| `server/session-history.ts` | 会话列表/删除/画布 sidecar/transcript 分页 |
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

## parquet-api.ts - Parquet 预览 API

### 路由

`GET /api/preview`

### 参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| df | string | 必填 | DataFrame 名称（对应 .parquet 文件） |
| rows | number | 10 | 返回行数上限 |

### 流程

1. 解析路径：`.govio/observe/dataframes/{df}.parquet`
2. 检查文件存在性
3. 使用 `hyparquet` 读取 parquet 对象（rowEnd 限制）
4. JSON 序列化：bigint 转 string，非原生对象转 `[ClassName]`
5. 设置 Content-Length，返回 JSON

### 错误处理

- 缺少 df 参数 → 400
- 文件不存在 → 404
- 读取失败 → 500

### CORS

完全开放（Allow-Origin: *），支持 GET/OPTIONS。

## cli.ts - 命令行入口

通过 `npm run ask -- -m "你的问题"` 调用。

| 参数 | 说明 |
|------|------|
| -m, --message | 必填，提示内容 |
| -n, --new | 可选，新开会话（默认续接最近一次会话历史） |
| -r, --raw | 可选，输出原始 AgentEvent JSON |
| -o, --output | 可选，输出写入文件 |

输出格式：NDJSON（每行一个 JSON 对象），包含 text_delta、thinking_delta、tool_start/end、message_start/end 等事件。
