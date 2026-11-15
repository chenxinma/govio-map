# X19-W5b 任务书：口径维度实质比对——map 侧消费与收尾

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X19")`（note/scope/acceptance 即验收契约）。
> **前置已合并**：govio 侧（W5a）已交付并合入 govio main（PR #24，merge `a92a291`，交付 commit `c621de9`）。本任务是 map 侧消费收尾。

## 1. 背景与动机

PD-2 定调（用户 2026-11-14）：口径判定以**计算表达式**和**维度限定条件**为实质判据。W5a 已在 govio 仓把维度限定升级为结构化三元组（列/算子/值集合）比对，产出 `consistent`/`conflict`/`unknown` 三态，且**输出 JSON 契约未变**（三态取值与 `differences` 条目形状不变、aspect 复用既有 `filter`/`time_scope`，未新增字段）。

map 侧（本任务）是消费收尾：`caliberCheck` 的 stub 断言扩展（维度三态与降级路径）、展示核对（X15.1 画布轻取舍）、文档收尾（PD-2 标注 + map 侧三件套 + govio 版本/commit 记录）。

## 2. 先读清单（按序）

1. `AGENTS.md`、`.pi/APPEND_SYSTEM.md`
2. `docs/task-plan.json → crossCutting[] | select(.id=="X19")` 的 `note` / `scope` / `acceptance`（验收契约）
3. `docs/PENDING-DISCUSSION.md` 的 **PD-2**（定调原文与 8 档样本 s1-s4/t1-t4；完成后标注「已定调并落地」）
4. `scripts/verify-caliber-conflict.ts` 全文（46 项 stub 断言现状；文件头注释有降级契约）
5. `src/utils/caliber.ts`（`CALIBER_ASPECT_LABELS`、`caliberNodeAppearance`）与 `src/types/semantic.ts`（`CaliberCheck`/差异条目形状）
6. `src/components/Nodes/SQLQueryNode.tsx`（T2.3 警示区现状；**注意：X18 徽标 PR #39 在合并流程中，同文件——你的改动尽量避开徽标区代码**）
7. govio 侧成果（**只读**）：`D:/Work/gov-io/govio/docs/tasks/X19-caliber-dimension-substance/design.md`（判定矩阵、三态边界、与方案 C 的界限、8 条遗留）与 `D:/Work/gov-io/govio/tests/test_caliber_dimension_compare.py`（8 档样本断言与三类 unknown 反例）

## 3. 实证事实（主会话已核实）

- **输出契约未变**（W5a 验收核实）：`govio-cli sql caliber` 输出 JSON 的三态取值与 `differences` 条目形状不变、无新增字段 → map 的解析面**无需改动**；`CALIBER_ASPECT_LABELS` 既有 `filter`/`time_scope` 等已覆盖，W5a 未新增 aspect
- 8 档样本判定（govio 侧 tests 逐档断言，主会话复跑核实）：**s2/t2 unknown→consistent、t4 conflict 保持、s1/s3/s4/t1/t3 conflict 零回归**；「宁可 unknown」三类反例（不可归属列/跨语种取值/取值超集）有测试锁定；无别名启发式
- govio 交付版本记录：交付 commit `c621de9`（PR #24）→ merge `a92a291`（2026-11-14）
- `verify:caliber-conflict` 现状 **46 项**（`46/46 checks passed` 小结格式）；降级契约：CLI 失败/非 JSON/空输入时**省略 `caliberCheck` 键、不抛错不阻断**
- 验证基线（派发时 map main）：**脚本 624 项 / vitest 15 文件 194 例 / UI 4 文件 31 例**
- **并行提醒**：PR #36（X16）/#37（X17）/#38（T3.1+T3.2）/#39（X18）在合并流程中，会改变 vitest 文件/例数（各自验收口径 210/215/219 例）——**你只对照分支点基线 624/194/31 + 自己的增量**，合并顺序与冲突由主会话协调，不要追 merged 态数字
- 本机 `govio-cli` 是否含 W5a 改动**未验证**（PR 刚合并，已安装的 uv tool 未必更新）——真实 CLI 的 8 档输出**禁止强求**：不可用就引用 govio 侧测试证据并留「待发版补录」，**禁止**为此重建/安装 govio（不动用户环境）

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **`scripts/verify-caliber-conflict.ts` 补 stub 断言（只增不削）**：
   - 维度维度三态的透传与展示映射：`filter` aspect 的维度差异条目（`consistent`/`conflict`/`unknown` 三态）从事件 JSON → `createGovioNode` → `node.data.caliberCheck` → `caliberNodeAppearance` 映射正确
   - 降级路径补强：CLI 失败 / 非 JSON 输出 / 空输入 / 空 differences → 省略 `caliberCheck` 键、不抛错不阻断（现状断言若未全覆盖三类输入则补齐）
   - 维度差异 reason 文案可读性断言（非空、随条目透传）
2. **`src/utils/caliber.ts` 核对**：`CALIBER_ASPECT_LABELS` 覆盖 W5a 输出的全部 aspect（实测为 `filter`/`time_scope` 等既有集合）→ 无需新展示名则**零改动**并在 design.md 说明；若发现新 aspect 才补展示名
3. **SQLQueryNode 警示区展示核对**：维度差异展示沿用 X15.1「画布轻、详情 hover/展开」取舍——核对 hover/展开明细已覆盖维度条目与 reason；仅在确有缺口时做**最小改动**（避开 X18 徽标区代码，冲突主会话 rebase）
4. **文档**：`docs/PENDING-DISCUSSION.md` PD-2 标注「已定调并落地（govio PR #24，merge a92a291）」；map 侧三件套落盘 `docs/tasks/X19-caliber-dimension-substance/`（**注意该目录已有 DISPATCH.md 与 DISPATCH-W5b.md，不要覆盖**）：
   - `design.md`：判定矩阵与三态边界（引用 govio design.md 对应节）、与方案 C（别名归一）的界限、「遗留问题」小节
   - `CHANGES.md`：文件清单 + 每处摘要
   - `verification.md`：**记录所用 govio 版本与 commit（c621de9 / merge a92a291）**、govio 侧 8 档证据引用（govio tests 42 例 + design 判定矩阵）、map 侧断言清单与增量数、8 档逐档判定记录表（引用 govio 测试断言；真实 CLI 输出可得则贴，不可得标「待发版补录」）

## 5. 范围纪律（明确不做）

- **不改 map 的解析兼容面**（`parseCaliberOutput`/事件解析）——契约未变；若实测发现契约差异，停下 `ask` 主会话，禁止自行扩解析
- **不做方案 C**（别名同义词典/启发式归一）；不改 govio 仓（已合并，只读引用）
- 不重建/安装 govio-cli（不动用户环境）；不改 `docs/task-plan.json`（主会话记账）
- 不动 `lineage.ts`/边语义/`PROTOCOL_VERSION`；不追 X17/X18/T3 的 merged 态数字
- 新发现一律写 design.md「遗留问题」

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（被 gitignore，fresh worktree 不含）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，`node_modules` 未就绪就 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 不可用（用 node/tsx）；JSON 用 `jq`
- commit：**单次 commit**，message 前缀 `X19: ...`（注明 map 侧收尾 / W5b）
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`；基线 624/194/31 零回归 + 新增断言（增量逐项列出）；verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话

## 7. 时间预算

- 总预算 **60 分钟**（`--timeout-ms 3600000`）
- **到期前 15 分钟为 checkpoint 点**（≈45min）：未完成则 commit 已改文件 + 三件套现状（前缀 `X19: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤10min → stub 断言 ≤25min → 展示核对 ≤10min → 三件套 ≤15min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X19-caliber-dimension-substance/{design.md,CHANGES.md,verification.md} + <代码文件摘要>
commit: <hash> <message>
stub 断言: 46 → <k>（新增 <n>，逐项：三态透传/降级/reason）
CALIBER_ASPECT_LABELS: <零改动（aspect 集合核实）/补了哪些>
SQLQueryNode: <零改动（现状已覆盖）/最小改动摘要>
govio 版本记录: <c621de9 / merge a92a291>（8 档证据引用 <govio tests/design 路径>）
8 档记录: <逐档表见 verification.md>；真实 CLI=<贴了/待发版补录>
断言数: 脚本 624 → <k>；vitest 15 文件 194 例 → <..>；UI 4 文件 31 例 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
