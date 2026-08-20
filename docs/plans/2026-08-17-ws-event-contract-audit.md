# WS 事件契约一致性审计

> 状态：待完善 / 待改进
> 日期：2026-08-17
> 范围：前端接收的 WSEvent / CanvasEvent 与后端 `ws-handler.ts`、`govio-node-queue.ts` 定义的一致性核对

## 涉及文件

- 后端发送
  - `server/ws-handler.ts`（/ws 聊天通道 + /canvas 通道入口）
  - `server/govio-node-queue.ts`（`GovioNodeCreateEvent` 类型定义）
  - `server/extensions/govio-canvas.ts`（`govio_create_source_table` 等工具，实际 push 节点）
- 前端接收
  - `src/hooks/useChat.ts`（`WSEvent` 接口 + onmessage switch）
  - `src/services/canvas-service.ts`（`CanvasEvent` 接口）
  - `src/types/index.ts`（`TableField` / `SourceTableNodeData` 等节点数据类型）
  - `src/components/Nodes/SourceTableNode.tsx`（消费 fields 的 PK/FK 徽章）
- 协议规范：`docs/specs/07-websocket-protocol.md`

## /ws 通道（聊天）：基本一致 ✅

后端发出的 16 种 `type`，前端 `WSEvent` 接口 + switch 全部覆盖。

| 后端发出 | 字段 | 前端声明 | 结论 |
|---|---|---|---|
| `text_delta` / `thinking_delta` | `content` | `content?` | ✅ |
| `tool_start` | `toolName` | `toolName?` | ✅ |
| `tool_end` | `toolName`, `success` | 两者都有 | ✅ |
| `observe_list_result` | `dataframes` | `dataframes?`（兼容数组/对象包裹） | ✅ |
| `tool_permission_request` | `requestId`, `command` | 两者都有 | ✅ |
| `models_config` / `error` | `config` / `message` | 两者都有 | ✅ |
| `session_ready` | `sessionId` | ⚠️ 未声明（handler 也不用） | 无害但类型不完整 |
| 其余纯信号型（agent_start/message_start/message_end/agent_end/config_required/config_saved） | - | - | ✅ |

反向（前端 → 后端 `WSMessage`）：前端实际发送 `prompt/steer/abort/observe_list/clear/tool_permission_response/permission_accept_all/get_models_config/save_models_config`。后端类型里的 `followUp` 前端从不发送——后端是死代码分支，不影响一致性。

### /ws 待改进项

- [ ] **P3** `WSEvent` 补 `sessionId?: string` 字段（当前 `session_ready` 携带但类型未声明，handler 也没用）
- [ ] **P3** 评估后端 `followUp` 分支：前端无入口，确认是否保留或删除

## /canvas 通道：存在契约缺口 ❌

后端在 `/canvas` 发 `canvas_ready` 和 `govio_node_create` 两类事件。

### 🔴 缺口 1：`fields.nullable` 前端必填、后端从不发送

- 前端 `TableField.nullable: boolean`（`src/types/index.ts:6`，**非可选**）
- 后端 `GovioNodeCreateEvent.fields` 项只有 `{ name, type, description?, references? }`（`govio-node-queue.ts`）
- `govio_create_source_table` 工具 schema（`govio-canvas.ts:337`）也不接受 `nullable`
- 运行时 `field.nullable` 恒为 `undefined`，违反前端类型契约（当前 `SourceTableNode` 没渲染它，未崩，但类型在撒谎）

### 🔴 缺口 2：`fields.isPrimaryKey` / `isForeignKey` 前端消费、后端从不发送（死功能）

- 前端 `SourceTableNode.tsx:33,36` 会渲染 PK/FK 徽章
- 后端全仓库 grep `isPrimaryKey|isForeignKey|nullable` **零命中**，从不产出
- 结果：PK/FK 徽章永远不会显示——UI 功能存在，后端契约不喂

### ⚪ 缺口 3：`sourceTable` 的 `rowCount` 前端渲染、后端不发

- 前端 `SourceTableNodeData.rowCount?` 可选，`SourceTableNode` 用 `nodeData.rowCount?.toLocaleString()` 渲染 "rows"
- 后端 sourceTable 节点从不发 `rowCount`（grep 零命中）
- 结果：sourceTable 节点永远显示「undefined rows」（可选链不崩，但显示异常）

### ⚪ 缺口 4：`canvas_ready` 事件未覆盖

- 前端 `CanvasEvent.type` 硬编码为 `"govio_node_create"`，`canvas-service` onmessage 会把 `canvas_ready` 也转发给订阅者
- `canvas-store` 只处理 `govio_node_create`，`canvas_ready` 被静默丢弃
- 当前无人消费，无害但类型未覆盖

### ✅ 其余一致

`GovioNodeCreateEvent` 与 `CanvasEvent` 的所有其他可选键（sql/outputColumns/dfName/sourceName/totalRows/totalColumns/memoryUsage/columns/reportType/content/sourceRefs/tableName/database/config/sourceDf/referencedNodes/nodeType/title）完全对齐。

## 改进方案（二选一）

### 方案 A：补后端（让 PK/FK 徽章真正生效）

- `govio-canvas.ts` 的 `govio_create_source_table` schema 增加 `nullable?/isPrimaryKey?/isForeignKey?` 入参
- 透传到 `pushGovioNode` 的 `fields`
- 同步更新 `GovioNodeCreateEvent.fields` 类型（`govio-node-queue.ts`）
- 调用方（govio-cli query 物理表结构后）需把这些字段填上
- 顺带为 sourceTable 补 `rowCount`（或前端隐藏未提供时的 "rows" 行）

### 方案 B：改前端（删死功能，类型对齐后端现状）

- `TableField.nullable` 改为可选 `nullable?`
- 删除 `SourceTableNode` 里 PK/FK 徽章逻辑（反正从没显示过）
- `SourceTableNode` 对 `rowCount` 未定义时不渲染 "rows" 行
- `CanvasEvent.type` 扩展为 `"govio_node_create" | "canvas_ready"`，或显式忽略 `canvas_ready`

## 待办

- [ ] 决策方案 A vs B（需确认产品上是否需要 PK/FK 展示能力）
- [ ] 同步更新 `docs/specs/07-websocket-protocol.md` 的 sourceTable 节点字段定义
- [ ] 修完后回归：sourceTable 节点显示、PK/FK 徽章（若走 A）、"rows" 文案
