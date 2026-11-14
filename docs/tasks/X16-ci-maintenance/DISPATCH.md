# X16 任务书：CI 维护小修包（actions pin SHA、runner 钉版、断言数看板、concurrency 注释）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X16")`（note/scope/acceptance 即验收契约）。

## 1. 背景与动机

X14 建立了 GitHub Actions CI 门禁（`.github/workflows/ci.yml`，required check `build + lint + verify`，ruleset 27209918）。首次真实运行留下三条待办（本任务的全部动机，用户裁决「X14 小修打包 OK」）：

1. run 注解：**Node.js 20 弃用警告**——`actions/checkout@v4`、`actions/setup-node@v4` 目标 Node 20 被强制跑在 Node 24 上（GitHub 2025-09-19 起弃用 Node 20）
2. run 注解：`ubuntu-latest` 标签将于 2026-10-19 起迁移 Ubuntu 26（actions/runner-images#14748）→ 不可预期变化
3. concurrency 组按 `workflow + ref` 分组且 `cancel-in-progress`，连续 push main 时前一个 run 被取消（实例：#34 合并的 run 43461685410 被 #35 推送取消）

**用户决策（2026-11-14）**：actions 升级走 **pin commit SHA**。其余取舍见 §4（主会话建议默认，若你有更强证据可在 design.md 纠偏）。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、合入 main 纪律）
2. `docs/task-plan.json → crossCutting[] | select(.id=="X16")` 的 `note` / `scope` / `acceptance`（note 里有全部触发证据）
3. `docs/tasks/X14-github-actions-ci/design.md`（尤其 §8 遗留 1/2/6）、`docs/tasks/X14-github-actions-ci/verification.md`（首跑记录与断言数）
4. `.github/workflows/ci.yml` 全文
5. `docs/tasks/X14-github-actions-ci/DISPATCH.md`（本仓任务书体例与 verification.md 写法参照）

## 3. 实证事实（主会话已核实，避免你重复踩坑）

- 当前 `ci.yml`：`actions/checkout@v4`、`actions/setup-node@v4`（均 major tag，未 pin SHA）；runner `ubuntu-latest`；`concurrency` 按 `workflow + ref` 分组、`cancel-in-progress: true`（PR 侧取消是省额度的正确行为；问题只在 push main 侧）
- required check 名是 **`build + lint + verify`**（ruleset 27209918 引用它）——**不得改名**；确需改名必须先在 design.md 写明并提示用户更新 ruleset，不得擅自改
- 断言现状（2026-11-14 基线）：**脚本 624 项**（manifest 92 / rerun 71 / audit 119 / export 138 / source-table 39 / semantic-lineage 48 / caliber 46 / cwd 13 / prompt-injection 58）、**vitest 15 文件 194 例**、**UI 4 文件 31 例**；ubuntu CI 上 `verify:cwd` caseDrift 闸门固定 SKIP 7 项 → **617**，这是脚本既有设计不是回归
- verify 小结有**四种格式**：`共 N 项断言，失败 0 项`（多数脚本）、`N/N checks passed`（caliber）、`N/N 通过`（prompt-injection）、vitest 的 `Test Files` + `Tests` 行；看板解析须全覆盖
- verify 链全部自包含（不调 govio-cli、不联网、无 `.env` 依赖），CI 无需 `.agents/`
- **并行任务提醒**：W1/W3/W4 在别的 worktree 并行改业务代码，断言数可能上涨；你只与「派发时基线」对照，**不要**因数字对不上改 workflow 或脚本
- 本任务与任何业务代码零交集

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **actions 升级 + pin commit SHA（用户决策）**：`actions/checkout`、`actions/setup-node` 升级到当前维护版并 **pin 到 commit SHA**（tag 注释并列，如 `# v5.x.y`，SHA 必须来自官方仓库该 tag 的真实 commit，不得编造）；目标是 run 注解里**不再出现 Node.js 20 弃用警告**；design.md 写 pin 的维护策略（如何跟进升级、SHA 来源如何核验）
2. **runner 钉版**：`ubuntu-latest` → `ubuntu-24.04`；design.md 写升级策略（何时/如何试 Ubuntu 26、需要重跑哪些对照）
3. **断言数看板（非门禁，失败绝不阻断）**：解析 §3 的四种小结格式，与基线比对后**只写 `$GITHUB_STEP_SUMMARY`**（或 warning 注解）；显式建模平台差值（ubuntu 617 / windows 624 口径分清，不得把 SKIP 7 报成漂移）；基线数字**单一来源**——因并行派发 worker 不改 `task-plan.json`，允许在 workflow 顶部变量处硬编码一处并注释来源；若你认为应从 `docs/task-plan.json` 读（需加字段），写进 design.md 遗留由主会话补。看板自身出错不得令 job 变红（用独立步骤 + `continue-on-error: true` 或等价防护，并验证之）
4. **concurrency 取舍（默认维持现状）**：PR 侧保留 `cancel-in-progress`；push main 侧维持现状，但必须在 workflow 注释与 design.md 明确写「连续合并时中间 commit 可能无 completed run，最终态由后续 run 覆盖」。若你认为应改为按 commit sha 分组/不取消 push 侧，design.md 给取舍论证后可改（后果：额度消耗上升）
5. **windows nightly 腿：本轮不做**（额度成本未经用户批准）。design.md 记录评估（分钟数估算、覆盖价值：ubuntu 永久 SKIP 的 7 项大小写断言）与「可后补」清单，不要实现
6. **真实 PR 证据**：你改完后由主会话推分支开 PR 看真实 run；verification.md 留「待主会话补录」小节（PR 号、改动前后 run 注解对比、看板输出截图/文本）
7. **三件套**落盘 `docs/tasks/X16-ci-maintenance/`：`design.md`（每项取舍 + pin 维护策略 + Ubuntu 26 升级策略 + nightly 评估 + **「遗留问题」小节**）、`CHANGES.md`、`verification.md`（改动前后对比、看板验证证据）

## 5. 范围纪律（明确不做）

- **只动 `.github/workflows/` 与三件套**；不改任何业务代码、测试、`package.json`、`package-lock.json`、既有 verify 脚本断言或输出格式
- **不改 required check 名** `build + lint + verify`
- **不实现 windows nightly 腿**（只做评估记录）；不做 merge queue / 其它 GitHub 设置（用户侧操作）
- 不改 `docs/task-plan.json`（主会话记账）；不引入任何依赖（含 actionlint 类工具，要用只准一次性使用不留痕）
- 新发现一律写 design.md「遗留问题」

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（被 gitignore，fresh worktree 不含）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，`node_modules` 未就绪就自己 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 不可用（用 node/tsx）；JSON 用 `jq`
- commit：**单次 commit**，message 前缀 `X16: ...`
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`（624/194/31 零回归——你不改断言，数字必须原样），verify 全跑后 `git status --porcelain` 干净；workflow 本身用 `actionlint`（一次性）或人工结构校验 + 真实 CI 运行为准
- 状态协议：**不要**改 task-plan 状态
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**

## 7. 时间预算

- 总预算 **60 分钟**（`--timeout-ms 3600000`）
- **到期前 15 分钟为 checkpoint 点**（≈45min）：未完成则 commit 已改文件 + 三件套现状（前缀 `X16: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤10min → pin SHA 选型与核验 ≤15min → ci.yml 改造 ≤15min → 看板本地验证 ≤10min → 三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X16-ci-maintenance/{design.md,CHANGES.md,verification.md} + .github/workflows/ci.yml
commit: <hash> <message>
actions pin: <checkout SHA (# tag) / setup-node SHA (# tag)>（SHA 核验方式一句话）
runner: <ubuntu-24.04>；升级策略=<已写 design.md 与否>
看板: <已实现/未实现>；平台差值建模=<ubuntu 617 / windows 624 处理方式>；失败不阻断验证方式=<一句话>
concurrency: <维持现状+注释/已改>（一句话取舍）
nightly 腿: 未实现，评估记录=<design.md 小节>（分钟数估算 <n>）
断言数: 本地 verify 624/194/31 零回归=<是/否>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
待主会话补录: <PR 号 / 改动前后 run 注解对比 / 看板输出>
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
