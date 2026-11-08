# X4 任务书：核心链路集成测试基建（Orca worker 派发件）

> 本文件为自包含任务书（worker 是 fresh context，不共享对话历史）。执行完按「最终输出格式」汇报。

## 1. 背景与动机

govio-map 的验证门槛 `npm run verify` 目前只有 6 个专项脚本（manifest/rerun/audit/export/source-table/cwd），缺核心链路集成测试：ws 消息处理、权限决策流、govio-canvas 扩展事件→画布节点转换、canvas 状态与 sidecar 持久化均无回归防护。后续 T2.x/T3.x/X2 都会改这些区域，先建测试基建可让所有后续任务零成本获得回归防护。关联文档：`AGENTS.md`（任务模式、验证门槛）、`docs/task-plan.json` 中 X4 条目。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、完成定义、环境约定）
2. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X4")`（scope/acceptance 即验收契约）
3. `package.json`（scripts 现状）与 `tsconfig.scripts.json`（scripts 编译约定，确认实际文件名）
4. `scripts/verify-manifest-roundtrip.ts` 等既有 verify 脚本（模仿其断言计数/输出风格）
5. `server/ws-handler.ts`、`server/permission-manager.ts`、`server/extensions/govio-canvas.ts`、`src/store/canvas-store.ts`
6. `docs/tasks/` 下任一既有任务三件套样例（如 X7、T2.0）了解交付物格式

## 3. 实证事实（主会话已调研，避免重复踩坑）

- `npm run verify` = 6 个 `tsx scripts/verify-*.ts` 顺序执行；devDependencies **无任何测试框架**（无 vitest/jest），需自行选型并加依赖
- `.agents/skills` 被 `.gitignore` 忽略（规则 `skills`），fresh worktree **不包含**该目录 → 见 §7 环境准备
- 本机为 Windows Git Bash：路径用正斜杠、jq 可用（`/d/Work/jq/jq`）、`python` 是 Windows Store 存根**不可用**（需要脚本语言一律用 node/tsx）
- 核心链路文件：`server/ws-handler.ts`（WS `/ws`）、`server/permission-manager.ts`（权限决策）、`server/extensions/govio-canvas.ts`（pi 扩展，工具结果→GovioNodeCreateEvent）、`src/store/canvas-store.ts`（Zustand，节点/边/持久化到 localStorage）
- 后端还有现成纯逻辑模块便于测：`server/analysis-manifest.ts`、`server/dataframe-rerun.ts`、`server/permission-audit.ts`、`server/cwd-normalize.ts`

## 4. 实现范围（逐项，对齐 acceptance）

1. 选型并落地集成测试框架（建议 vitest，与 vite 生态一致；自行论证，写入 design.md）
2. 编写 4 条核心链路的集成测试：
   - ① ws-handler 消息处理 + permission-manager allow/deny/edit 决策分支（mock WS 与 pi session）
   - ② govio-canvas 扩展：工具结果/`message_end` → `GovioNodeCreateEvent` 转换（含失败信号、列结构字段，参见 BUGFIX-load-parse/BUGFIX-df-columns 教训）
   - ③ canvas-store：`createGovioNode` 节点创建、自动边生成、`positionNewNode` 布局
   - ④ canvas sidecar（.canvas.json）持久化往返（save/load 往返无丢失）
   - 每条链路至少含 1 个失败/边界用例
3. 接入验证门槛：新增 `npm run test:integration`（或 `verify:integration`）并纳入 `npm run verify` 聚合链
4. 若为可测性需对业务代码做最小调整（如依赖注入、导出内部函数），只做最小改动并在 CHANGES.md 逐处记录
5. 三件套落盘：`docs/tasks/X4-test-infra/design.md`（含框架选型取舍）、`CHANGES.md`、`verification.md`（验证命令与关键输出、断言数变化）

## 5. 范围纪律（明确不做）

- 不改任何业务逻辑/交互行为（仅允许 §4.4 的最小可测性调整）
- 不动 `src/components/` UI、不动 `docs/task-plan.json`（计划记账由主会话统一执行，避免并行 worktree 冲突）
- 不引入对真实 govio-cli、真实 LLM/网络的测试依赖（一律 mock/fixture）
- 不顺带重构、不顺带修其他已知问题；新发现写入 design.md 的「遗留问题」小节

## 6. 环境与协议

- **环境准备（第一步执行）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（worktree 缺 skills 目录；大小约 353K）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪）；**不切分支、不 push**
- Windows Git Bash：正斜杠路径；jq 可用；python 不可用
- commit：单次 commit，message 前缀 `X4: ...`
- 验证门槛（全部必须绿，任一非零退出即任务失败，修复后重跑，禁止虚报）：
  `npm run build`、`npm run lint`、`npm run verify`（既有断言零回归 + 新增用例），且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 `docs/task-plan.json`（主会话记账）

## 7. 时间预算

- 总预算 **45 分钟**（timeoutMs 2700000）
- 到期前 10 分钟为 checkpoint 点：若未完成，先提交已改文件并在汇报中写明「已改文件/验证状态/剩余工作」，超时不是变更安全边界

## 8. 最终输出格式（≤15 行摘要）

- status / 交付物路径 / commit hash 与 message / 断言数变化（新增用例数、verify 断言前后对比）/ 遗留问题
