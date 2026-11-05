# X2 CHANGES：WS 协议契约化

## 文件清单

| 文件 | 变更 | 摘要 |
|---|---|---|
| `src/types/ws-protocol.ts` | 新增 | 契约单一来源：PROTOCOL_VERSION/注册表（$id+version 字段）、客户端 17 类 + 服务端 25 类 typebox schema、`Static<>` 派生类型、`parseWSClientMessage` 入站解析、`WSClientMessageOf<T>` 提取工具 |
| `server/ws-handler.ts` | 修改 | 删除内联 `interface WSMessage`（20 字段）→ 契约类型；50 处 `/ws` 发送收口 `sendMsg(ws, WSServerMessage)`；3 个 message 监听接入 `parseWSClientMessage` 拒绝路径；`handleNormalMessage` 补 `assertNever` 编译期穷尽；`makePrompt`/`handleSaveModelsConfig` 参数改 `WSClientMessageOf<...>`（函数体未动） |
| `src/hooks/useChat.ts` | 修改 | 删除松散 `interface WSEvent`（28 字段）→ `WSServerMessage` 判别联合；20+ 处出站收口 `sendClientMessage(ws, WSClientMessage)`；`DataFrameSummary/ObserveInfo/SessionListItem/PermissionDecision` 改契约别名再导出（UI 导入路径不变）；`tool.args` 边界 cast 一处 |
| `tests/integration/ws-protocol.test.ts` | 新增 | 契约测试 19 用例：注册表版本化断言、42 条合法样本匹配 schema、拒绝路径（非法 JSON/非对象/未知 type/形状非法）+ 容忍规则、端到端真实 ws 通道（入站拒绝 + 实发消息逐条匹配 schema）、无重复定义源码扫描 |
| `docs/specs/07-websocket-protocol.md` | 修改 | 新增「协议契约（X2）」章节：单一事实源指向、版本化与 version 字段、消息全集（17+25）、4 条兼容策略、拒绝行为 |
| `docs/tasks/X2-ws-protocol-schema/{design.md,CHANGES.md,verification.md}` | 新增 | 三件套交付物 |

## 逐处摘要

### src/types/ws-protocol.ts（新）

- `PROTOCOL_VERSION = 1`、`PROTOCOL_ID_PREFIX = "govio-ws/v1"`、`WS_PROTOCOL` 注册表
  （`version` 字段 + client/server schema 映射）；
- 每条消息 schema 经 `messageSchema()` 构造：`$id: "govio-ws/v1/<type>"` + `version` 元数据 +
  `additionalProperties: true`（附加字段容忍）；
- 载荷构件 8 个（ReferencedNode/PermissionDecision/DisplayToolCall/TranscriptMessage/
  SessionListItem/DataFrameSummary/ObserveInfo/ModelsConfig）；
- `parseWSClientMessage`：非法 JSON → `String(err)`（原回包文案）；非对象/未知 type →
  `unknown message type: ...`；形状非法 → `invalid message: ...`；合法原样返回。

### server/ws-handler.ts（改）

- import 行：`PermissionDecision`/`ModelsConfig` 类型导入移除（改由契约派生）；
- `sendMsg` / `assertNever` 助手（makePrompt 上方）；
- 发送收口覆盖 subscribeToSession（10）、sendModelsConfig（2）、handleSaveModelsConfig（3）、
  pushSessionState（3）、handleNormalMessage（18）、连接初始化（4）；
- `handleCanvasConnection` 的 3 处 `/canvas` 发送保持原样（不在 /ws 契约范围）。

### src/hooks/useChat.ts（改）

- 别名再导出 4 个线上载荷类型（DataSourcesModal/PermissionCard 导入不受影响）；
- `send()` 的 `Record<string, unknown>` 拼装改为两个具名字面量（键序不变，JSON 字节等价）；
- `respondPermission` 的可选 `editedCommand` 改三元字面量（字节等价）。
