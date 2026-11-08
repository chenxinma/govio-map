# X9 对话展示改版 — 变更清单

## 文件清单

| 文件 | 变更 |
|---|---|
| `server/ws-handler.ts` | `tool_execution_start` 转发 `args` |
| `server/session-history.ts` | `DisplayToolCall.args` + `buildRounds` 补取 toolCall 入参 + 自检断言 |
| `src/hooks/useChat.ts` | `ToolCall.args` / `WSEvent.args` / `tool_start` 存 args |
| `src/components/Chat/ChatMessage.tsx` | assistant 去气泡 + ToolPill→可展开 ToolRow |
| `src/commands/export-session.ts` | 导出会话 JSON 增加 `tools`（任务书可选项） |
| `docs/specs/03-chat.md` | 流式协议（tool_start 增 args）、消息渲染与 ToolRow 描述同步 |
| `docs/tasks/X9-chat-display/{design,CHANGES,verification}.md` | 本任务三件套 |
| `docs/task-plan.json` | X9 `pending → done` + history |

## 逐项摘要

### server/ws-handler.ts
- `tool_execution_start` 分支的 `tool_start` 事件体增加 `args: event.args`，随 `JSON.stringify` 原样序列化（不嵌套字符串，无转义问题）。
- `tool_execution_end` 不动：`result`（完整工具输出）不转发，结果仍只显 success 状态。

### server/session-history.ts
- `DisplayToolCall` 增 `args?: unknown`。
- `buildRounds` 的 toolCall block 解析补取 `b.arguments`（兼容 `b.args`/`b.input`，取不到留空），流式与历史回放的工具行行为一致。
- 模块自检（NODE_ENV≠production）新增断言：toolCall `arguments` 解析进 `tools[0].args`。

### src/hooks/useChat.ts
- `ToolCall` 接口增 `args?: Record<string, unknown> | string`。
- `WSEvent` 增 `args?: Record<string, unknown> | string`。
- `tool_start` 处理把 `data.args` 存入新建的 ToolCall（`undefined` 不落键）。

### src/components/Chat/ChatMessage.tsx
- **assistant 去气泡**：外层容器由 `max-w-[90%] rounded-lg px-3 py-2 bg-bg-primary border` 改为 `w-full text-sm`（无边框/背景/圆角，宽度铺满）；用户分支气泡不动；外层 `flex mb-3` 间距保留。
- **ToolPill/ToolPills → ToolRow/ToolRows**：每工具一行，行内展开箭头 + 工具名 + 状态图标（spinner/绿勾/红叉语义同旧）；点击展开，每行独立 `useState` 默认收起。
- 展开内容：bash 显示 `args.command` 命令原文；其它工具 `JSON.stringify(args, null, 2)` 截断 ≤20 行（超出以 `…` 标注）；无 args 显示「无参数信息」。
- `ThinkingSection`/`ReferenceChips` 不动。

### src/commands/export-session.ts（可选项，做了）
- message 映射增 `tools: m.tools`，导出 JSON 含工具名/状态/args，与界面展示对齐；既有字段不动。

### docs/specs/03-chat.md
- `ToolCall` 接口补 `toolCallId`/`args` 字段说明。
- 「助手消息渲染」改写为去气泡 + 分段输出描述；「ToolPill」小节替换为「ToolRow」（展开规则）。
- 流式协议表：`tool_start` 增 args 说明；`tool_end` 描述修正为按 toolCallId 匹配（与实现一致）。

## 不做的事（范围纪律）

- 用户气泡、ChatInput、PermissionCard、画布/store 均未动。
- 未引入新 UI 依赖（lucide-react 图标 + 原生 useState）。
- `message_start` 分段/复用逻辑未动（多段输出是需求保留项）。
