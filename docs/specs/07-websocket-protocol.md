# WebSocket 协议

## 概述

后端 WebSocket 服务器运行在 `ws://hostname:{port+1}`，提供两个端点：
- `/ws` - 聊天交互（Agent 会话）
- `/canvas` - 画布节点事件推送

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
