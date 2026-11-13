# AGENTS.md

## Project Overview

Govio Map is an infinite canvas data governance tool. Users issue natural language commands that drive an AI agent (pi-coding-agent) to generate SQL queries, DataFrames, reports, and charts that appear as nodes on a canvas with directed edges representing data lineage.

```
Tables ──▶ SQL ──▶ DataFrame ──▶ Report
```

## Govio 资源路径的实际位置

skills/govio/assets = ./.agents/skills/govio/assets

## Govio Skills 同步

Skills 原版在 `D:/Work/gov-io/govio/skills/`（由 `package_skills.py` 打包为 `dist/govio-skills.zip`）。`.agents/skills/` 是运行时副本，尚未对外发行，不会自动更新，手动同步（**只同步源文档，排除 `assets/` 生成物**——assets 随 `meta graph` 按环境生成，盲目覆盖会把别的环境快照盖到 live 图库上）：

```bash\# 同步：仅 skills 源文档（SKILL.md/reference 等），不动 assets/
cd /d/Work/gov-io/govio-map
for d in govio govio-eda govio-meta govio-observe govio-query govio-reconcile; do
  rsync -a --exclude 'assets/' "/d/Work/gov-io/govio/skills/$d/" ".agents/skills/$d/"
done

# 校验：预期残留仅 assets/（生成物）、moli-*（非 govio 仓技能），不应有源文档差异
diff -rq /d/Work/gov-io/govio/skills .agents/skills | rg -v "assets/|moli-"
```

## SQL 生成纪律（运行时约束）

agent 生成/执行 SQL 的硬规则已移入 `.pi/APPEND_SYSTEM.md`（pi 项目级系统提示追加文件，运行时自动加载，仓库内跟踪维护；画布展示、输出截断、环境提示等其余运行时约束亦在该文件）。

## Commands

```bash
npm run dev      # Start Vite dev server (port 5173) + WebSocket (port 5174)
npm run build    # TypeScript check + Vite build
npm run lint     # ESLint
npm run verify   # 聚合验证脚本（manifest/rerun/audit/export/source-table，全部必须绿）
npm run preview  # Preview production build
```

## 任务模式（Task Mode）

本仓库的功能开发/修复/文档任务按「计划 JSON + 子代理执行 + 主会话验收」模式运作。主会话（pi 交互会话）是唯一的循环控制者与验收人；子代理（subagent worker）只做实现，不得再编排子任务。

### 工件与目录约定

| 工件 | 位置 | 说明 |
|---|---|---|
| 任务计划 | `docs/task-plan.json` | 唯一事实源：phases（P1-P3，对齐 docs/ROADMAP.md）+ crossCutting（X1-Xn）；每任务含 id/title/kr/status/dependsOn/outputDir/scope/acceptance/history |
| 任务交付物 | `docs/tasks/<任务ID-短名>/` | 三件套必交：`design.md`（方案与取舍 + 「遗留问题」小节）、`CHANGES.md`（文件清单+每处摘要）、`verification.md`（验证命令与关键输出） |
| 审查/修复记录 | `docs/tasks/REVIEW-R<n>-fixes.md`、`docs/tasks/BUGFIX-*.md` | 审查循环与验收后 bug 的留痕 |

### 状态机与写权

```
pending → in_progress → done → accepted / rejected
```

- 状态变更必须同步追加 `history` 条目 `{status, at(ISO), by, note}` 并刷新顶层 `updatedAt`
- **worker 只能改自己的任务条目**，完成置 `done`，绝不自置 `accepted`；`accepted/rejected` 只能由主会话写入
- 同一分支同一时刻**只允许一个写者**（单 worker 串行，或主会话亲自改），避免 `git add -A` 互扰

### 主会话：派发协议

任务书必须自包含（worker 是 fresh context，不共享对话历史），固定八段：
1. **背景与动机**：为什么做，关联的 bug/前置任务文档路径
2. **先读清单**（按序）：AGENTS.md、task-plan 中本任务条目、相关 specs/design、关键源码文件:行号
3. **实证事实**：主会话已调研到的结论（避免 worker 重复踩坑）
4. **实现范围**：逐项编号，对齐 acceptance
5. **范围纪律**：明确不做什么；新发现一律写 design.md 遗留问题，不顺带重构
6. **环境与协议**：分支（不切不 push）、Windows Git Bash 约定（正斜杠、jq、python 不可用）、状态协议、验证门槛、commit message 前缀（`<任务ID>: ...`）
7. **时间预算**：timeoutMs + checkpointBeforeDeadlineMs（到期前先 checkpoint 已改文件/验证状态/剩余工作，超时不是变更安全边界）
8. **最终输出格式**：≤15 行摘要（status/交付物/commit/断言数变化/遗留）

### worker：完成定义（缺一不可提交）

- 验证门槛全绿：`npm run build`、`npm run lint`、`npm run verify`（含本任务新增脚本，既有断言零回归），且 verify 全跑后 `git status --porcelain` 干净
- 三件套落盘 + task-plan 状态置 `done` + 单次 commit（ID 前缀）
- 未完成项如实报告，禁止虚报验证结果

### Orca 编排派发 SOP（多 worker 并行执行）

任务经 Orca worker（各自独立 worktree）并行执行时适用；pi 交互会话作为 coordinator。实例参考：X3/X4 派发（`docs/task-plan.json → crossCutting`）。

1. **派发前准备**（主会话串行写者）：task-plan 补全任务 scope/acceptance 并置 `in_progress` + history；写八段式任务书 `docs/tasks/<outputDir>/DISPATCH.md`（自包含，含最终输出格式）；计划+任务书单次 commit（`chore(plan): ...`）
2. **worktree 隔离**：每个 worker `--worktree new-top-level --repo id:<repoId> --name <短名>`（重派时复用既有 worktree），保证单写者纪律不跨分支破坏
3. **环境准备**：`.agents/`（skills）被 gitignore，fresh worktree 不含 → 任务书第一步必须是 `cp -r <主仓>/.agents ./`（约 350K）
4. **派发**：`orca orchestration worker-start --spec-file docs/tasks/<ID>/DISPATCH.md --worktree ... --agent <agent> --json`；独立 worker 全部启动后结束回合等 Orca 唤醒，**禁止轮询**
5. **任务书送达确认**：`--task` 复用/重派的 dispatch 可能不带 spec（agent 启动后不开工）→ `orca orchestration send --to dispatch:<id> --type dispatch --body "$(cat docs/tasks/<ID>/DISPATCH.md)"` 重发正文（`$( )` 结果不二次求值，含反引号也安全）；worktree 建于任务书 commit 之前时正文即唯一事实源，附 `git show main:...` 对照路径。注意：send/wake 送达会**打断 worker 当前回合**（`Operation aborted`），续做指令须要求 worker 先完成任务再处理后续消息
6. **并行模式的写权变通**：worker **不改** task-plan.json（多分支同改必冲突），主会话验收时统一记账（done/accepted + history + updatedAt）；其余完成定义不变
7. **失败恢复**：启动/模型通道错误（订阅失效等）→ 停下问用户（换 agent/换模型/续订），禁止静默换 agent；用户明确要求重派后 `task-update --id <task_id> --status ready --run <run_id>` → `worker-start --task <task_id> --run <run_id> --worktree <placement> --agent <agent>`（复用原 spec；`--retry-of` 须指向 latest settled dispatch，常不适用）；重派前 `git -C <worktree> log/status` 确认无残留半成品
8. **验收合入**：`worker_done` 必须是 **orca 信号**而非终端文本——若 worker 只把汇报写在终端就收尾（Task 未结），令其补发 `orca orchestration send --type worker_done --outcome succeeded --task-id ... --dispatch-id ...`，收到信号才按「验收协议」独立复跑 + 抽查；功能/大改动按 PR 门禁合入

### 合入 main 纪律（PR 门禁 + 分支保护）

`main` 已受 GitHub **ruleset「main」**保护（id=27209918，`enforcement: active`，2026-11-13 用户开启）：
required status check **`build + lint + verify`**（X14 的 `.github/workflows/ci.yml`）+ 禁删分支 + 禁 non-fast-forward；
`bypass_actors` = **RepositoryRole: admin（bypass_mode: always）**（2026-11-14 用户授权，仅供文档记账直推）。

按变更性质分两类：

| 变更类型 | 合入方式 |
|---|---|
| **代码改动**（新功能、界面交互优化、大改动，**以及 bugfix**） | 必须走 **GitHub PR**：任务分支 → PR → CI `build + lint + verify` 绿 → 用户合并 → 清理分支。**bugfix 不再直推 main**（保护生效前的旧表述已作废：直推会被 `remote rejected ... repository rule violations` 拦下） |
| **纯文档记账**（`docs/task-plan.json`、`docs/tasks/**` 三件套与 DISPATCH、`AGENTS.md`、`.pi/APPEND_SYSTEM.md`） | 可用 admin bypass 直接 commit + push `main`（单次 commit，`chore(plan): ...` 前缀）；push 后 main 的 CI 仍会跑，红了立即修 |

- **直推前自查（硬规则）**：`git diff --cached --name-only` 必须**全部**落在 `docs/` 或 `.pi/` 下，且不含
  `src/` `server/` `scripts/` `tests/` `package.json` `package-lock.json` `.github/` 的任何改动；
  只要沾到代码就改走 PR。`docs/specs/**` 若与代码同批变更，随代码 PR 一起走，不单独直推
- **PR 由用户合并**：主会话创建 PR 后停下等用户合并，**不得自行 merge**（用户指令 2026-11-04；admin bypass
  只用于文档直推，不用于合并代码 PR）；并行 PR 间若有冲突，主会话先行 rebase/消解再交付用户
- PR 合并后主会话做验收（独立复跑验证 + 抽查）→ `accepted` 置位 + 记账 commit（文档，可直推）
- 判不准是 bugfix 还是功能时，**按 PR 处理**（宁重勿漏）；判不准是否算「纯文档」时，同样**按 PR 处理**
- 实例参考：PR 合并惯例见 `docs/task-plan.json → pullRequests`（#12-#17、#28-#35）；X7/X9 走本地 merge 是历史例外；
  X14（PR #32）建立 CI 门禁，X15（PR #34）是门禁上线后第一个功能 PR；`chore/plan-x151-bookkeeping`（PR #35）
  是保护刚生效、bypass 尚未加时被迫走 PR 的文档记账，bypass 加好后此类改回直推

### 主会话：验收协议

1. 独立复跑验证门槛（不转述 worker 报告），确认断言数变化与新增用例吻合
2. 抽查关键实现源码（至少验最关键的 2-3 处声明）与交付物齐全性
3. 通过 → jq 置 `accepted` + history 记录验收证据 + 单独 commit（`chore(plan): accept <ID>`）；不通过 → 列明缺口后 resume/重新派发
4. 验收后的后续动作（如更新下游任务定义）由主会话执行

### 审查循环（用于阶段性大 diff，非每任务必做）

- 每轮用 **fresh-context reviewer 并行**（只读，直接从仓库取证，不依赖对话历史），按变更选角度（正确性/安全/测试与文档），上限 3 轮
- 发现只报有证据项，标 P0（阻断）/P1（发布前修）/P2（记录），结尾 `Merge verdict: BLOCK/OK/OK with notes`
- 主会话综合后派**单个 forked worker** 修 P1+采纳的 P2；修复有实质变更才进下一轮（定向三问：解决？新缺陷？旧结论仍成立？）；终审用 blockers-only
- 延后项必须落入 task-plan（crossCutting 或任务遗留）而非口头搜置

实例参考：Phase 1 完整循环见 `docs/task-plan.json → phases[0].reviewLoop` 与 `docs/tasks/REVIEW-R1/R2-fixes.md`。

## Architecture

### Data Flow
1. User sends message via `ChatPanel` → `useChat.send()` over WS `/ws`
2. `server/ws-handler.ts` prepends referenced-node context and calls pi `session.prompt()` (or `session.steer()` while streaming)
3. pi events stream back; the `govio-canvas` extension parses tool results / `message_end` into `GovioNodeCreateEvent`s, flushed over WS `/canvas`
4. `canvas-service` -> `canvas-store.createGovioNode()` creates nodes + auto-edges, positioned via `positionNewNode` (dagre)

### State Management (`src/store/canvas-store.ts`)
Single Zustand store owns canvas state: nodes, edges, referenced nodes, preview panels (persists to localStorage `govio-canvas-state`). Chat messages live in `useChat`.

### Node Types (`src/types/index.ts`)
- `sourceTable`: Database table with schema (purple left border)
- `sqlQuery`: SQL statement (green left border)
- `dataFrame`: pandas-style dataframe info (orange left border)
- `report`: diff or correlation analysis (amber/violet left border)
- `chart`: Plotly visualization (blue left border)

### Backend (`server/index.ts`)
Vite plugin (`server/index.ts`) runs HTTP + WebSocket on port 5174: `/ws` (chat), `/canvas` (node stream), `/api/preview` (parquet). `server/agent.ts` manages an in-memory pi `AgentSession` with the `govio-canvas` extension. Requires `govio-cli` on PATH; no mock fallback (disconnected state disables input).

### Key Files
- `server/index.ts` — Vite plugin: HTTP + WS server on port 5174 (`/ws`, `/canvas`, `/api/preview`)
- `server/agent.ts` / `server/extensions/govio-canvas.ts` — pi AgentSession + govio tools & event hooks
- `server/ws-handler.ts` / `server/permission-manager.ts` — WS handling, event forwarding, permission flow
- `server/govio-installer.ts` — govio-cli 安装与技能包下载
- `src/hooks/useChat.ts` / `src/services/canvas-service.ts` — /ws & /canvas clients
- `src/store/canvas-store.ts` / `src/components/Nodes/*.tsx` — Zustand canvas state + nodes (incl. Plotly)
- `src/commands/` / `src/utils/layout.ts` — slash-command system + dagre layout

## Design System

Light "Green Deck" variant (Spotify-inspired); see docs/green-deck-DESIGN.md. Tokens in src/index.css (@theme):
- Background: `#f5f5f5` (page/canvas), `#ffffff` (cards/messages), `#f0f0f0` (surfaces/inputs)
- Brand green: `#1DB954` (edges, accents), hover `#1ED760`
- Text: `#121212` (primary), `#535353` (secondary), `#727272` (muted), `#a7a7a7` (dim)
- Borders: `#ececec` (subtle) → `#d4d4d4` (default) → `#b3b3b3` (prominent) → `#a3a3a3` (light)
- Semantic: warning `#F59B23`, error `#E22134`, success `#1DB954`; fonts DM Sans + JetBrains Mono (Google Fonts); elevation via surface brightness (lighter = higher)

## Environment Variables

Create `.env` with at least one AI provider. Also requires `govio-cli` on PATH (external CLI, validated at backend startup):
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# or OPENAI_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY
```

## Technical Stack

React 19 + TypeScript, Vite, @xyflow/react (ReactFlow), Zustand, @dagrejs/dagre, Tailwind CSS v4, plotly.js, @earendil-works/pi-coding-agent, hyparquet, WebSocket (ws)
