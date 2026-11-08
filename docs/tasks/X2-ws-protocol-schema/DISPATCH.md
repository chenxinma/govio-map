# X2 任务书：WS 协议契约化（版本化 schema + 双端类型生成）（Orca worker 派发件）

> 本文件为自包含任务书（worker 是 fresh context，不共享对话历史）。执行完按「最终输出格式」汇报。

## 1. 背景与动机

`/ws` 通道消息双端靠内联 interface 与裸 JSON 手工对齐（`server/ws-handler.ts:12` 的 `WSMessage` + `src/hooks/useChat.ts` 的松散处理），新增消息易漂移、缺编译期保障。P3（T3.1 团队存储抽象）等后续任务都需要稳定契约。本任务把协议契约化：版本化 schema + 双端类型单一来源 + 契约测试。纯契约化重构，**不改任何消息语义**。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、完成定义）
2. `docs/task-plan.json` 中 X2 条目（scope/acceptance 即验收契约）
3. `docs/specs/07-websocket-protocol.md`（现有协议文档，契约化后需同步）
4. `server/ws-handler.ts` 全文（`:12` WSMessage、各 `ws.send` 消息形态）
5. `src/hooks/useChat.ts`（客户端消息处理）
6. `server/observe-load-schema.ts`、`server/extensions/govio-canvas.ts`（typebox 既有用法先例）
7. `tests/integration/`（X4 vitest 基建，契约测试复用其模式）

## 3. 实证事实（主会话已调研，避免重复踩坑）

- `WSMessage` 内联在 `server/ws-handler.ts:12`；服务端 `ws.send` 有 10+ 种消息形态（agent_start/text_delta/thinking_delta/tool_start/tool_end/message_start/message_end/agent_end/session_ready/models_config/permission 请求等）
- **typebox 已在 dependencies** 且有用例（`observe-load-schema.ts`、`govio-canvas.ts`）
- X4 vitest 基建可复用：`verify:integration` 已入 `npm run verify` 聚合（既有 38 用例零回归）
- `.agents/skills` 被 gitignore，worktree 不含 → §6 环境准备
- Windows Git Bash：正斜杠路径、jq 可用、`python` 不可用（用 node/tsx）

## 4. 实现范围（逐项，对齐 acceptance）

1. **版本化 schema**：以 typebox 定义全量 `/ws` 消息 schema（含协议 version 字段与兼容策略：旧客户端/新消息的容忍规则，策略文档化）
2. **双端类型单一来源**：schema 导出 TS 类型供 server 与 src 共用（生成脚本或共享模块——方案取舍写 design.md）
3. **机械替换**：`server/ws-handler.ts` 内联 `WSMessage` 与 `src/hooks/useChat.ts` 松散类型全部替换为契约类型，运行时可校验入站消息（非法/未知消息拒绝路径）
4. **契约测试**：复用 X4 vitest 基建，覆盖各消息类型合法收发匹配 schema + 非法/未知消息拒绝；纳入 verify 聚合
5. 更新 `docs/specs/07-websocket-protocol.md` + 三件套：`docs/tasks/X2-ws-protocol-schema/{design.md,CHANGES.md,verification.md}`

## 5. 范围纪律（明确不做）

- **纯契约化，不改任何消息语义/业务行为**（消息字段、时序、错误处理行为保持逐字节等价；只加类型与校验）
- **不碰 prompt/注入逻辑**：`makePrompt()` 函数体与 `ws-handler.ts:211` 调用点逻辑**一律不动**（T2.1 正在并行改那里，避免冲突）；ws-handler.ts 中你只动类型声明与消息收发的类型化改造
- 不动 UI 交互、不动 `docs/task-plan.json`（主会话记账）
- 不顺带重构；新发现记 design.md 遗留问题

## 6. 环境与协议

- **环境准备（第一步执行）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
- 工作位置：Orca 独立 worktree；**不切分支、不 push**
- commit：单次 commit，message 前缀 `X2: ...`
- 验证门槛（全绿，任一非零退出即失败，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`（既有 458+38 断言零回归 + 本任务新增），verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不改** `docs/task-plan.json`；**不合并 PR**（主会话创建 PR 后由用户合并）
- 若收到 orchestration 唤醒消息：先把手头任务执行完再处理，不要中断

## 7. 时间预算

- 总预算 **60 分钟**；到期前 15 分钟为 checkpoint 点（先提交已改文件 + 汇报剩余工作）

## 8. 最终输出格式（≤15 行摘要）

status / 交付物路径 / commit hash 与 message / 断言数变化 / 契约覆盖消息类型数 / 遗留问题
