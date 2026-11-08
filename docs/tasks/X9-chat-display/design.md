# X9 对话展示改版 — 设计方案

## 需求

1. 用户消息保留气泡样式（现状不动）。
2. assistant 回复**去气泡化**：保持现有分段输出（thinking 折叠段 / 工具调用行 / markdown 正文逐段，`message_start` 分段逻辑不动），但不再用气泡卡片包裹——无边框、无背景、无圆角、宽度铺满。
3. tool 调用行**可展开查看命令**：bash 展开可见具体命令（`args.command`），其它工具展开显示 args JSON 摘要。

## 数据链路（args 从哪来）

| 侧 | 来源 | 改动 |
|---|---|---|
| 流式 | pi `ToolExecutionStartEvent.args`（`@earendil-works/pi-ai` 事件，`args: any`，已实证 `dist/core/extensions/types.d.ts:853`） | `server/ws-handler.ts` 的 `tool_execution_start` 分支在 `tool_start` 事件体中随 `JSON.stringify` 原样携带 `args`（不嵌套字符串，避免转义问题） |
| 历史回放 | pi transcript assistant 消息的 toolCall block `{type:"toolCall", id, name, arguments: JsonObject}`（已实证 `@earendil-works/pi-ai/dist/types.d.ts:271`） | `server/session-history.ts` `buildRounds` 补取 `b.arguments`（兼容 `b.args`/`b.input` 变体，取不到留空）存入 `DisplayToolCall.args` |
| 前端 | `WSEvent.args` → `ToolCall.args` | `src/hooks/useChat.ts` `tool_start` 处理存入 args |

结果（`tool_execution_end` 的 `event.result`）为完整工具输出，体积大，**不转发**——按用户需求「查看具体的命令」，结果仍只显示 success 状态。

## UI 结构

### ChatMessage 容器

- 用户分支：原样保留（`max-w-[90%] rounded-lg px-3 py-2 bg-bg-primary border-l-2 border-brand`）。
- assistant 分支：外层气泡样式全部移除，只保留 `w-full text-sm text-text-primary`；外层 `flex mb-3` 间距保留。分段输出机制（每次 `message_start` 起一段、thinking-only 复用）不动。

### ToolPill → ToolRow（可展开行）

- 每个工具调用一行（`flex flex-col` 纵向排列），行内：展开箭头（ChevronRight/Down）+ Wrench 图标 + 工具名（font-mono）+ 状态图标（Loader2/Check/X，语义同旧 ToolPill）。
- 点击整行 toggle，展开态为每行独立 `useState`（默认收起），不引入折叠库。
- 展开内容：
  - `bash`：显示 `args.command`（字符串原文，不截断——查看具体命令是核心诉求）；
  - 其它工具：`JSON.stringify(args, null, 2)`，截断 ≤20 行（超出以 `…` 标注）；
  - `args` 缺失（旧历史消息/未转发）：显示「无参数信息」降级提示。
- 状态匹配沿用 `toolCallId` 匹配逻辑（`useChat` `tool_end`，不回归）。

## 取舍

- **args 原样 JSON 序列化**而非 `JSON.stringify` 成字符串字段：前端拿到结构化对象，bash 取 `command`、其它工具格式化 JSON 都简单，无二次解析。
- **只展开命令不展开结果**：结果体可能巨大（`observe load` 输出等），全量转发会撑爆 WS 消息与内存；且任务书明确范围。如需结果摘要（截断 ≤500 字符）列为遗留。
- **JSON 展开截断 20 行**：多数工具 args 不大，20 行足够辨识；超长 args（如整段 SQL）避免展开区过高。
- **导出会话 JSON 增加 `tools`**（任务书可选项）：导出与界面展示对齐，命令不再随导出丢失；仅在 message 映射加一字段，既有字段不动。

## 遗留问题

1. **工具结果不可展开**：`tool_execution_end` 的 `result` 未转发，如后续需要「展开看结果摘要」（截断 ≤500 字符或仅 success+exitCode），需在 ws-handler 补 `resultSummary` 字段并扩展 ToolRow。
2. **超长 args 的展开性能/滚动**：当前用 `whitespace-pre-wrap break-words` 整段渲染，极大 args（数百行）展开会有渲染负担；如成为问题可加 max-height + 内部滚动。
3. **markdown 渲染细节**：去气泡后正文宽度铺满，超宽表格/代码块的视觉表现依赖现有 `WideContent` 组件，未在本任务内调整。
4. **旧历史消息无 args**：本改动之前的会话记录里 toolCall block 若已带 `arguments` 则可回填；实际不带的只能显示「无参数信息」，无法补造。
