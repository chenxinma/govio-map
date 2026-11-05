# T2.1 任务书：图谱定义自动注入 Prompt（Orca worker 派发件）

> 本文件为自包含任务书（worker 是 fresh context，不共享对话历史）。执行完按「最终输出格式」汇报。

## 1. 背景与动机

agent 生成 SQL 时靠猜测表名/限定名（动机案例 `docs/tasks/BUGFIX-load-parse.md`：盲猜三次试错），主动查图谱不可靠。T2.0（已 accepted）已把 datasource/datasourceType/schema/qualifiedName 固化到 sourceTable 节点，但 prompt 不携带。本任务在会话启动/引用节点变更时**自动注入**语义上下文（表限定名 + 图谱指标/标准/码值），并留痕保证口径可追溯。KR1；完成后解锁 T2.2/T2.3。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、SQL 生成纪律）
2. `docs/task-plan.json` 中 T2.1 条目（scope/acceptance 即验收契约）
3. `docs/tasks/BUGFIX-load-parse.md`（动机案例）
4. `docs/specs/11-datasource-schema-conventions.md`（限定名规则）
5. `server/ws-handler.ts:522` `makePrompt()` 与 `:211` 调用点；`server/session-history.ts:98` REF 前缀解析
6. `server/extensions/govio-canvas.ts`、`src/types/index.ts`（SourceTableNodeData 的 T2.0 字段）
7. `.agents/skills/govio-query/SKILL.md` + `.agents/skills/govio/assets/schema.md`（图谱查询与 schema，**必读**）

## 3. 实证事实（主会话已调研，避免重复踩坑）

- `makePrompt(msg)` 在 `server/ws-handler.ts:522`，把 referencedNodes 序列化为 `REF:[...]` 前缀；`server/session-history.ts:98` 解析回填（有断言先例 `:222-223`）
- sourceTable 节点已有 `datasource/datasourceType/schema/qualifiedName`（T2.0 accepted，类型在 `src/types/index.ts`）
- 图谱查询走 `govio-cli query`（Cypher），**执行前必须先读** `.agents/skills/govio/assets/schema.md`，禁止凭记忆构造属性名（会 Binder exception）
- `.agents/skills` 被 gitignore，worktree 不含 → §6 环境准备
- X4 已建 vitest 基建（`tests/integration/`、`verify:integration` 已入 verify 聚合）；断言脚本风格见 `scripts/verify-*.ts`
- Windows Git Bash：正斜杠路径、jq 可用（`/d/Work/jq/jq`）、`python` 不可用（用 node/tsx）

## 4. 实现范围（逐项，对齐 acceptance）

1. **自动注入**：会话启动/引用节点变更时，makePrompt 注入 ① 被引用 sourceTable 节点的 qualifiedName/datasourceType/schema（SQL 表引用以此为准，禁止猜测）；② 图谱中与问题实体/引用表相关的指标定义、字段标准、枚举码值（govio-cli query 获取）
2. **注入留痕**：每次注入记录被注入节点与图谱实体 ID 列表，随会话持久化（复用 session sidecar/jsonl 模式，见 session-history.ts 既有机制）
3. **命中率测量**：新增 `scripts/verify-prompt-injection.ts`——抽样比对生成 SQL 的表引用与注入的 qualifiedName，纳入 `npm run verify` 聚合
4. **降级**：图谱不可达/无相关实体时注入失败降级为现状行为，不阻断会话（含边界用例）
5. 三件套：`docs/tasks/T2.1-graph-prompt-injection/{design.md,CHANGES.md,verification.md}`

## 5. 范围纪律（明确不做）

- **不改 WS 消息结构/协议类型**：`server/ws-handler.ts` 中只改 `makePrompt()` 函数体与 `:211` 调用点周边逻辑；`WSMessage` 界面、`ws.send` 消息形态**一律不动**（X2 正在并行做协议类型化，避免冲突）。若确需新消息字段 → 写 design.md「遗留问题」，不要实施
- 不动 UI（`src/components/`）、不动 `docs/task-plan.json`（主会话记账）
- 不顺带重构；新发现一律记 design.md 遗留问题

## 6. 环境与协议

- **环境准备（第一步执行）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
- 工作位置：Orca 独立 worktree；**不切分支、不 push**
- commit：单次 commit，message 前缀 `T2.1: ...`
- 验证门槛（全绿，任一非零退出即失败，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`（既有 458+38 断言零回归 + 本任务新增），verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不改** `docs/task-plan.json`；**不合并 PR**（主会话创建 PR 后由用户合并）
- 若收到 orchestration 唤醒消息：先把手头任务执行完再处理，不要中断

## 7. 时间预算

- 总预算 **60 分钟**；到期前 15 分钟为 checkpoint 点（先提交已改文件 + 汇报剩余工作）

## 8. 最终输出格式（≤15 行摘要）

status / 交付物路径 / commit hash 与 message / 断言数变化 / 注入留痕形态 / 遗留问题
