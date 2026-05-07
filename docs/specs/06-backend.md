# Backend 后端服务

## 概述

后端作为 Vite 插件运行，在 Vite dev server 启动时创建独立 HTTP+WebSocket 服务器（端口+1），提供 AI Agent 会话和画布通信能力。

## 文件结构

| 文件 | 职责 |
|------|------|
| `server/index.ts` | Vite 插件入口 |
| `server/ws-handler.ts` | WebSocket 消息处理 |
| `server/agent.ts` | pi-coding-agent 会话管理 |
| `server/govio-node-queue.ts` | 节点事件批量队列 |
| `server/extensions/govio-canvas.ts` | Agent 扩展（工具注册+事件拦截） |
| `server/parquet-api.ts` | Parquet 文件预览 API |
| `server/cli.ts` | CLI 命令行入口 |

## index.ts - Vite 插件入口

### 插件名

`ws-plugin`

### 启动流程

1. `configureServer` 钩子触发
2. 创建独立 HTTP Server（不依赖 Vite server）
3. 调用 `setupWebSocket(httpServer)` 设置 WebSocket
4. 等待 Vite server listening 事件
5. 在 `port+1` 启动 HTTP Server
6. 调用 `agentSetup()` 初始化 AI Agent

### HTTP 路由

唯一路由 `/api/preview` 由 `handleParquetApi` 处理，其他返回 404。

## agent.ts - Agent 会话管理

### agentSetup()

1. 创建 `DefaultResourceLoader`，配置：
   - 扩展工厂：`govioCanvasExtension(pi)`
   - Skills 过滤：仅保留含 "browser"/"search"/"govio"/"observe" 的技能
2. 调用 `resLoader.reload()` 加载资源
3. 执行 `govio-cli --help` 验证
4. 日志输出 "Server agent ready."

### getOrCreateSession()

单例模式，返回 `AgentSession`：
- `cwd`: `process.cwd()`
- `tools`: `createCodingTools(cwd)` (文件系统、bash 等)
- `sessionManager`: `SessionManager.inMemory()` (非持久化)
- `agentDir`: `~/.pi/agent`
- `resourceLoader`: 上述配置的 DefaultResourceLoader

### runGovioCli(cmd)

通过 `child_process.execSync` 同步执行 `govio-cli <cmd>`，15 秒超时。

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
| nodeType | 全部 | 节点类型 |
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
| sourceRefs | report | 数据源引用 |
| tableName | sourceTable | 表名 |
| database | sourceTable | 数据库名 |
| fields | sourceTable | 字段列表 |
| referencedNodes | 全部 | 引用节点（自动附加） |

## govio-canvas.ts - Agent 扩展

### 注册工具: govio_create_source_table

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tableName | string | 是 | 物理表名 |
| database | string | 否 | 数据库名 |
| fields | Array<{name, type, description?, references?}> | 是 | 字段定义 |

执行后调用 `pushGovioNode({nodeType: "sourceTable", ...})`。

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
| -r, --raw | 可选，输出原始 AgentEvent JSON |

输出格式：NDJSON（每行一个 JSON 对象），包含 text_delta、thinking_delta、tool_start/end、message_start/end 等事件。
