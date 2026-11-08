# WebSocket 协议

## 概述

后端 WebSocket 服务器运行在 `ws://hostname:{port+1}`，提供两个端点：
- `/ws` - 聊天交互（Agent 会话）
- `/canvas` - 画布节点事件推送

## 协议契约（X2）

`/ws` 通道消息以 **typebox schema 契约**为单一事实源：`src/types/ws-protocol.ts`。
双端 TypeScript 类型均由此派生（`Static<>`），服务端入站经 `parseWSClientMessage`
运行时把关，出站经 `WSServerMessage` 编译期对齐；本文其余章节的示例均为说明性摘录，
完整消息全集以契约文件为准。

### 版本化

- `PROTOCOL_VERSION = 1`；每条消息 schema 携带 `$id: "govio-ws/v1/<type>"` 与 `version` 字段
  （schema 元数据层）。
- **version 不上线**：消息字段与改造前逐字节等价，v1 的版本语义由前后端同仓同构建的
  「部署对」隐式携带。未来跨版本协商的演进路径是新增 hello/握手消息，而非逐条加字段。

### 消息全集

- 客户端 → 服务端（17 类）：`prompt`、`steer`、`followUp`、`abort`、`observe_list`、
  `observe_info`、`clear`、`tool_permission_response`、`permission_accept_all`、
  `get_models_config`、`save_models_config`、`set_model`、`session_list`、`session_open`、
  `session_messages`、`session_delete`、`canvas_save`
- 服务端 → 客户端（25 类）：`session_ready`、`canvas_restore`、`session_messages_result`、
  `session_list_result`、`session_deleted`、`agent_start`、`agent_end`、`message_start`、
  `message_end`、`text_delta`、`thinking_delta`、`tool_start`、`tool_end`、`queue_update`、
  `steer_queued`、`followUp_queued`、`queue_cleared`、`tool_permission_request`、
  `observe_list_result`、`observe_info_result`、`models_config`、`config_saved`、
  `config_required`、`model_set`、`error`

开放载荷（`args` / `nodes` / `edges` / `dataframes` / `info`）在契约中松绑为 unknown/宽松
对象，形状由消费端自校验。

### 兼容策略（旧客户端 / 新消息的容忍规则）

1. **服务端 → 客户端**：客户端对未知 `type` 的服务端消息忽略不崩（switch 无 default）；
   新增服务端消息类型对旧客户端零破坏。
2. **客户端 → 服务端**：未知 `type` 与形状非法（字段类型/字面量不符）的入站消息被拒绝并回
   `error`（`unknown message type: <type>` / `invalid message: <type> ...`），连接不因此断开。
3. **附加字段容忍**：两端 schema 均允许额外属性；新版本在既有消息上加字段不被旧端拒绝；
   `type` 是唯一判别字段。
4. **字段必需性**与契约化前保持一致（业务级必填仍由 handler guard 拦截并保留原文案，如
   `session_open requires path`）；schema 负责形状合法（类型/字面量）。

契约测试见 `tests/integration/ws-protocol.test.ts`（纳入 `npm run verify`）。

## 连接生命周期

### /ws 连接

1. 客户端连接 → 服务器创建/复用 Agent Session
2. 服务器发送 `{type: "session_ready", sessionId}`
3. 客户端发送 prompt/steer/abort 等消息
4. 服务器流式推送 agent 事件
5. 连接关闭 → 取消订阅

### /canvas 连接

1. 客户端连接 → 服务器订阅 `onGovioNodesFlushed`
2. 服务器发送 `{type: "canvas_ready", sessionId}`
3. 节点队列 flush 时，逐个推送 `govio_node_create` 事件
4. 连接关闭 → 取消订阅

### 未知路径

其他 upgrade 路径直接 `socket.destroy()`。

## /ws 客户端消息

### prompt

```json
{
  "type": "prompt",
  "content": "统计客户账单金额",
  "referencedNodes": [
    {"nodeId": "src-1", "label": "billing", "type": "sourceTable", "data": "..."}
  ]
}
```

- `referencedNodes` 可选，有引用时会在 content 前拼接 `REF:[...]` 前缀
- 如果 Agent 正在流式输出，自动切换为 `session.steer()`

### steer

```json
{"type": "steer", "content": "换个维度分析"}
```

中断当前输出并追加指令。

### followUp

```json
{"type": "followUp", "content": "继续"}
```

### abort

```json
{"type": "abort"}
```

中止当前 Agent 执行。

### observe_list

```json
{"type": "observe_list"}
```

请求 DataFrame 列表。服务器执行 `govio-cli observe list`，返回 `observe_list_result`。

## /ws 服务器消息

### session_ready

```json
{"type": "session_ready", "sessionId": "xxx"}
```

### agent_start / agent_end

```json
{"type": "agent_start"}
{"type": "agent_end"}
```

### message_start / message_end

```json
{"type": "message_start"}
{"type": "message_end"}
```

仅在 `role === "assistant"` 时发送。

### text_delta / thinking_delta

```json
{"type": "text_delta", "content": "SELECT ..."}
{"type": "thinking_delta", "content": "用户想要..."}
```

### tool_start / tool_end

```json
{"type": "tool_start", "toolName": "bash"}
{"type": "tool_end", "toolName": "bash", "success": true}
```

`tool_end` 后会 flush 节点队列。

### observe_list_result

```json
{"type": "observe_list_result", "dataframes": [...]}
```

### error

```json
{"type": "error", "message": "observe list failed: ..."}
```

## /canvas 服务器消息

### canvas_ready

```json
{"type": "canvas_ready", "sessionId": "xxx"}
```

### govio_node_create

```json
{
  "type": "govio_node_create",
  "nodeType": "sqlQuery",
  "title": "Q: billing",
  "sql": "SELECT ...",
  "outputColumns": ["month", "total"],
  "referencedNodes": [{"nodeId": "src-1", "label": "billing"}]
}
```

字段因 nodeType 而异，详见 06-backend.md 中 GovioNodeCreateEvent 字段表。

## 会话管理协议

会话记录由 pi `SessionManager` 持久化到 `.govio/sessions/<ts>_<id>.jsonl`；画布快照存同名 sidecar `<session-file>.canvas.json`。会话建立/切换后服务端依次推送 `session_ready` → `canvas_restore`（如有）→ `session_messages_result`（replace=true，最近 10 轮）。

### 客户端消息

| 消息 | 参数 | 说明 |
|---|---|---|
| `session_list` | - | 拉取历史会话列表 |
| `session_open` | `{path}` | 切换到指定会话文件（先 abort 当前流式） |
| `session_messages` | `{beforeEntryId?}` | 分页拉取展示记录；缺省返回最近 10 轮 |
| `session_delete` | `{path}` | 删除会话（不允许删当前活动会话） |
| `canvas_save` | `{nodes, edges}` | 画布快照写入当前会话 sidecar（前端 debounce 1s） |

### 服务端消息

| 消息 | 载荷 | 说明 |
|---|---|---|
| `session_list_result` | `{sessions:[{id,path,name,preview,messageCount,modified}]}` | 按 modified 倒序 |
| `session_messages_result` | `{messages, hasMore, oldestEntryId, replace}` | replace=true 整屏替换（恢复/切换），false 为 prepend（加载更早） |
| `session_deleted` | `{path}` | 删除成功回执 |
| `canvas_restore` | `{nodes, edges}` | 恢复会话绑定的画布（sidecar 存在时） |

`messages` 元素与前端 `ChatMessage` 同构（id 用 entry id；user 消息的 `REF:` 前缀已解析为 `referencedNodes`，仅还原 label）。

## 节点队列刷新时机

队列在以下两个事件时刷新：

1. **tool_execution_end** - 工具执行完成后（如 bash 执行 govio-cli 命令）
2. **message_end** (assistant) - 助手消息完成后（如 SQL 代码块提取）

这确保节点创建事件不会逐条推送，而是在逻辑单元完成时批量发送。

## 引用节点协议

客户端发送 prompt 时，`referencedNodes` 数组会被转换为 `REF:[...]` 前缀拼接在 content 前：

```
REF:[{"billing": "{\"full_table_name\":\"billing\",...}"},{"df_query_1": "df_query_1"}]
统计这些数据的月度趋势
```

服务端 `setCurrentReferencedNodes()` 存储引用，后续 `pushGovioNode()` 自动附加到节点事件中，用于前端自动创建连线。

## 权限审批协议

当 Agent 执行 `govio-cli observe load -o`（带输出标志）时，扩展拦截并请求用户确认。

### 客户端消息

| 消息 | 参数 | 说明 |
|---|---|---|
| `tool_permission_response` | `{requestId, decision, editedCommand?, reason?}` | allow/deny/edit |
| `permission_accept_all` | - | 同意当前请求并标记后续全部放行 |

### 服务端消息

| 消息 | 载荷 | 说明 |
|---|---|---|
| `tool_permission_request` | `{requestId, command}` | 需要审批的 bash 命令 |

超时 5 分钟自动 deny。

## 模型配置协议

### 客户端消息

| 消息 | 参数 | 说明 |
|---|---|---|
| `get_models_config` | - | 拉取 models.json |
| `save_models_config` | `{config}` 或 `{apiKey}` | 保存配置或首次设置 API key |
| `set_model` | `{provider, modelId}` | 切换当前会话使用的模型 |

### 服务端消息

| 消息 | 载荷 | 说明 |
|---|---|---|
| `models_config` | `{config}` | ModelsConfig 对象 |
| `config_saved` | - | 配置保存成功回执 |
| `config_required` | - | 首次启动无配置，需前端引导设置 |
| `model_set` | `{provider, modelId}` | 模型切换成功回执 |

首次启动检测到无 models.json 时，服务端发送 `config_required`，前端显示配置弹窗。配置保存后服务端重启 Agent 会话并推送 `session_ready`。
