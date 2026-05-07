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
