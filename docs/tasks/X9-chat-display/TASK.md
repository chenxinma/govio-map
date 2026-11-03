# X9：对话展示改版 — assistant 去气泡化 + tool 调用可展开查看命令

## 1. 背景与动机

用户反馈：agent 回复内容多时气泡占位置，且一次 `agent_start → agent_end` 的分段输出（thinking + 工具调用 + 多段 markdown 正文）被拆成多个气泡展示，视觉碎、占地。需求：
- **用户消息**保留气泡样式（现状即可）
- **assistant 回复**保持现有分段输出（thinking 折叠段 / 工具调用行 / markdown 正文逐段），但**不再用气泡卡片包裹**（无边框、无背景、宽度放开）
- **tool 调用行可展开**：至少 bash 展开可见具体命令；其它工具显示 args 摘要

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、验证门槛）
2. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X9")` 条目
3. `src/hooks/useChat.ts`：`ToolCall` 接口（L7-11）、`WSEvent`（L77+）、`tool_start`/`tool_end` 处理（约 L389-428）、`message_start`/`message_end`/`agent_start`/`agent_end`
4. `src/components/Chat/ChatMessage.tsx`（全文 141 行）：`ToolPill`/`ToolPills`/`ThinkingSection`/`ChatMessage` 气泡容器（L97-139）
5. `server/ws-handler.ts` L77-83：`tool_execution_start/end` → `tool_start`/`tool_end` 事件转发
6. `server/session-history.ts`：`DisplayToolCall`（L10-13）、`buildRounds` 的 toolCall block 解析（L144-152）、`DisplayMessage`
7. `docs/specs/03-chat.md`（流式消息协议表、组件结构——实现后需同步）
8. `src/commands/export-session.ts`（导出会话 JSON，确认不回归）

## 3. 实证事实（主会话已调研，勿重复踩坑）

- **气泡拆分机制**：`message_start` 每次开新 `ChatMessage`（`useChat.ts` L327-357）；`message_end` 后若无正文/工具则 thinking-only 复用（`reusableThinkingId`），否则下一轮 `message_start` 再开新气泡。一次 agent 运行多个 assistant message → 多个气泡。**保持分段输出**即保持每次 `message_start` 起一段，只去外层气泡卡片。
- **工具入参已存在于 pi 事件但未转发**：pi 的 `tool_execution_start` 事件有 `args`（`server/ws-handler.ts` 当前只转 `toolName`/`toolCallId`）。流式侧在 `tool_start` 事件里加 `args` 即可；`WSEvent` 接口需加 `args?: Record<string, unknown>`（或 `string`）。
- **历史回放侧**：`session-history.ts` `buildRounds` 解析 assistant 消息 block，`b.type === "toolCall"` 时 block 自带 `arguments`（pi transcript 结构：`{type:"toolCall", id, name, arguments}`）——当前只取 `name`，需补取 `arguments` 存入 `DisplayToolCall`，历史消息的工具行同样可展开。
- **导出会话 JSON**（`src/commands/export-session.ts`）只映射 `id/role/content/thinking/referencedNodes`，不含 tools——不受本改动影响，但可顺带把 `tools` 加入导出（可选项，做了要在 CHANGES.md 说明）。
- 现有验证脚本（`scripts/verify-*.ts`）**不覆盖前端组件**（无 React 测试基建）；本任务验证以 `build`/`lint`/`verify` 全绿 + specs 文档同步为准，组件行为靠人工冒烟。

## 4. 实现范围

1. **`server/ws-handler.ts`**：`tool_execution_start` 分支转发 `args`（`event.args`，原样 JSON 可序列化；避免转义问题用 `JSON.stringify` 事件体而非嵌套字符串）。注意 `tool_execution_end` 的 `event.result` 是完整工具输出——**不要**全量转发（体积大）；如需展开显示结果摘要，可截断（≤500 字符）或仅显示 `success`。范围建议：本次只展开**命令（args）**，结果仍只显示 success 状态（用户需求即「查看具体的命令」）。
2. **`server/session-history.ts`**：`DisplayToolCall` 增 `args?: unknown`；`buildRounds` toolCall block 取 `b.arguments`（兼容 `b.args`/`b.input`，取不到留空）。历史 JSON（`DisplayMessage`）随之带出，流式与回放一致。
3. **`src/hooks/useChat.ts`**：`ToolCall` 接口增 `args?: Record<string, unknown> | string`；`tool_start` 处理把 `data.args` 存入；`WSEvent` 增 `args` 字段。
4. **`src/components/Chat/ChatMessage.tsx`**：
   - **assistant 分支去气泡**：去掉外层 `div` 的 `max-w-[90%] rounded-lg px-3 py-2 bg-bg-primary border` 样式（保留必要的 `mb-3` 间距与 `text-sm`），内容块直接铺开；用户分支保持气泡不动。
   - **ToolPill → 可展开 ToolRow**：行内显示 `toolName` + 状态图标 + 展开箭头；点击展开显示 `args`（bash 显示 `args.command` 字符串，其它工具显示 `JSON.stringify(args, null, 2)` 截断 ≤20 行）；展开态局部 `useState`（每行独立，默认收起）。
   - `ThinkingSection` 保持现状（折叠段）；`ReferenceChips` 保持现状。
5. **`docs/specs/03-chat.md`**：更新「消息渲染」「流式消息协议」（tool_start 增 args）、组件结构描述。
6. **交付物**：`docs/tasks/X9-chat-display/{design.md,CHANGES.md,verification.md}`（design 含「遗留问题」小节）。
7. **`docs/task-plan.json`**：X9 状态 `pending → done`（history，by: worker）。

## 5. 范围纪律

- 不动用户气泡样式、不动 ChatInput、不动 PermissionCard、不动画布/store。
- 不引入新的 UI 依赖（图标用现有 `lucide-react`；展开用原生 `useState`，不引入折叠库）。
- 不改 `agent_start`/`message_start` 的分段逻辑（多段输出是用户明确要保留的）。
- 不处理「合并多个 message_start 为一段」这类优化（用户要求保持现有分段输出）。
- 新发现（如 markdown 渲染细节、长文本性能）写 design.md 遗留问题。

## 6. 环境与协议

- **分支**：`main`；**不切分支、不 push**。单次 commit，message 前缀 `X9: `。
- **Windows Git Bash**：正斜杠路径；`jq` 可用；`python` 不可用。
- **状态协议**：开工先置 X9 `in_progress` + history；完成置 `done` + history（绝不置 `accepted`）；刷新顶层 `updatedAt`。
- **验证门槛**（全绿才可提交）：`npm run build`、`npm run lint`、`npm run verify`（既有断言零回归），verify 全跑后 `git status --porcelain` 干净（除本任务文件）。
- **不读数据内容**；不运行 `govio-cli observe load`。

## 7. 时间预算

- timeoutMs: 3600000（60 分钟）
- checkpointBeforeDeadlineMs: 600000（到期前 10 分钟 checkpoint：已改文件、验证状态、剩余工作，写入 CHANGES.md 草稿）

## 8. 最终输出格式（≤15 行）

```
status: done | blocked(原因)
交付物: docs/tasks/X9-chat-display/{design,CHANGES,verification}.md
commit: <sha>
验证: build ✓ / lint ✓ / verify:<各脚本断言数>（前后对比）
实现要点: <≤3 行：去气泡位置/ToolRow 展开内容/args 来源>
遗留: <无 或 列出>
```
