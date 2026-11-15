# X18 任务书：SQL 节点卡片渲染 semanticRefs 徽标（PD-1 方案 1）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X18")`（note/scope/acceptance 即验收契约）。
> **用户裁决（2026-11-14）**：PD-1 选**方案 1（最小档）——SQL 节点卡片渲染 refs 徽标**。方案 2（语义边悬停显示共用指标）与方案 3（新增指标/口径节点类型）**明确不做**。

## 1. 背景与动机

T2.2 已让 sqlQuery 节点携带 `semanticRefs`（引用的图谱 Metric/Dimension/字段标准），血缘边能区分数据/语义血缘，但**指标本身在画布上不可见**——只存在于节点属性里（T2.2 design.md 遗留 3、PD-1 记录）。用户在画布上看不到「这个 SQL 用了哪个口径/指标」，语义治理的价值在画布上出不来。

目标：在 SQL 节点卡片上渲染口径徽标（如「销售额」），让引用的图谱指标在画布可见。

## 2. 先读清单（按序）

1. `AGENTS.md`、`.pi/APPEND_SYSTEM.md`
2. `docs/task-plan.json → crossCutting[] | select(.id=="X18")` 的 `note` / `scope` / `acceptance`
3. `docs/PENDING-DISCUSSION.md` 的 **PD-1**（定调原文与三方案边界；完成后要标注「已裁决并落地」）
4. `src/types/semantic.ts`（`SemanticRef` 定义：15-21 行 `{entityType, id, code?, name?}`，entityType 取值同文件）
5. `src/components/Nodes/SQLQueryNode.tsx` 全文（现状只渲染 T2.3 口径警示 `caliberNodeAppearance`：55/105/109-117/170-175 行，**无任何 semanticRefs 渲染**）
6. `src/components/Nodes/SourceTableNode.tsx`（关系小节 / PK-FK 徽标的视觉语言与折叠范式——你要复用它，不发明第二套）
7. `src/utils/caliber.ts`（`caliberNodeAppearance`、`CALIBER_WARNING_COLOR`——警示配色的唯一来源）
8. `tests/ui/` 现有用例（尤其 `tests/ui/sql-query-node.test.tsx` 若已存在）与 `docs/tasks/X12-ui-test-infra/design.md`（jsdom 局限与 UI 测试范式）
9. `docs/tasks/X15-relation-columns-only/design.md`（X15.1 的「画布轻、详情 hover」取舍——本任务 hover 信息量对齐它）、`docs/specs/02-nodes.md`
10. `scripts/verify-export-report.ts`、`scripts/verify-semantic-lineage.ts` 的文件头注释（若需补断言，只增不削）

## 3. 实证事实（主会话已取证，避免你重复踩坑）

- `SemanticRef = { entityType, id, code?, name? }`（`src/types/semantic.ts:15-21`）；entityType 含 Metric / Dimension / 字段标准等（以文件内取值为准）
- `SQLQueryNode.tsx` 只渲染 T2.3 口径警示（warning 黄 `#F59B23`，由 `caliberNodeAppearance` 唯一提供）；无 semanticRefs 任何渲染
- green-deck token 体系（`src/index.css` @theme）：徽标复用既有 token class（sourceTable 关系小节/PK-FK 徽标同款视觉语言），**不写死新色值、不新增第二套徽标样式**
- 验证基线（2026-11-14）：**脚本 624 项** / **vitest 15 文件 194 例** / **UI 4 文件 31 例**；`verify:export` 138 断言、`verify:semantic-lineage` 48 断言
- 旧节点/手动建的 SQL 节点/图谱降级时 `semanticRefs` 不存在或为空 → **整个徽标区不渲染**（不出现空壳行、`undefined` 文案）
- **并行任务提醒**：W3（X17）在别的 worktree 改 `server/table-relations.ts`、`src/utils/table-relations.ts`、`docs/specs/02-nodes.md`（不同小节）；W1 改 session-history/分享；W2 只动 `.github/`。你**不动它们的文件**；spec 冲突由主会话 rebase

## 4. 实现范围（逐项编号，对齐 acceptance）

1. `SQLQueryNode.tsx` 新增「口径」徽标区：按 `semanticRefs` 渲染 `code ?? name`（两者都缺则**跳过该条**，禁止渲染 undefined/空徽标）；Metric 优先排序、默认只展示前 N 条并沿用关系小节的折叠范式（N 与折叠交互在 design.md 定）；Dimension/字段标准是否同排展示由你做取舍（避免节点过长挤压画布密度，写 design.md）
2. **与 T2.3 口径警示的视觉分工**：警示优先级高于徽标（`caliberNodeAppearance` 仍是警示配色与文案唯一来源）；冲突态下徽标不得削弱警示可读性、不互相遮挡
3. **hover `title`** 给完整信息（entityType + code + name + 图谱 id），对齐 X15.1「画布轻、详情按需」取舍；触屏无 hover 的局限按 X15.1 同款处理（已知取舍，不做点击弹层）
4. 无 `semanticRefs` 时**整个徽标区不渲染**
5. **导出 HTML 同步渲染**（建议同步，风格与 Manifest 附录一致；若你论证后选择不同步，写 design.md 取舍并说明）；若同步则 `scripts/verify-export-report.ts` 补断言（只增不削）
6. **测试**：`tests/ui/sql-query-node.test.tsx` 扩用例——徽标渲染、code 优先/name 回退/两者都缺跳过、无 refs 不渲染、与口径警示共存、折叠交互（若有）；如涉及节点形状或导出则同步补 `verify-semantic-lineage` / `verify-export-report` 断言（**只增不削**）
7. **文档**：`docs/specs/02-nodes.md`（sqlQuery 节点结构新增徽标区）、`docs/PENDING-DISCUSSION.md` PD-1 标注「已裁决并落地」、`docs/demo/video-script-chocolate.md` 若有口径可见性措辞则同步；**三件套**落盘 `docs/tasks/X18-sql-node-semantic-badges/`（design.md 含 N/折叠/同排取舍、与警示视觉分工、**「遗留问题」小节**；CHANGES.md；verification.md 含人工目视描述）

## 5. 范围纪律（明确不做）

- **不新增节点类型**（PD-1 方案 3 明确排除）；不改边语义与 `src/utils/lineage.ts`；不改 `PROTOCOL_VERSION`
- 不引入新依赖；不写死色值（一律 green-deck token class）
- 不改 `docs/task-plan.json`（主会话记账）；不动 W1/W2/W3 的文件
- 不做点击弹层/详情面板（触屏局限是已知取舍）；不做方案 2 的语义边悬停
- 新发现一律写 design.md「遗留问题」

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（被 gitignore，fresh worktree 不含）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，`node_modules` 未就绪就 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 不可用（用 node/tsx）；JSON 用 `jq`
- commit：**单次 commit**，message 前缀 `X18: ...`
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`；基线 624/194/31 零回归 + 新增用例（增量逐项列出）；verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 验收含**人工目视**一次：在 verification.md 用文字描述或截图记录「引用指标的 SQL 节点徽标可见」的效果
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话

## 7. 时间预算

- 总预算 **80 分钟**（`--timeout-ms 4800000`）
- **到期前 15 分钟为 checkpoint 点**（≈65min）：未完成则 commit 已改文件 + 三件套现状（前缀 `X18: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤15min → 徽标区实现 ≤25min → 测试 ≤25min → 导出同步与三件套 ≤15min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X18-sql-node-semantic-badges/{design.md,CHANGES.md,verification.md} + <代码文件摘要>
commit: <hash> <message>
徽标区: <N 条/折叠方式>；同排范围<Metric only|含 Dimension/字段标准>（一句话取舍）
与警示共存: <一句话：优先级/遮挡处理>；色值=<token class，未写死>
导出 HTML 同步: <是/否>（是→verify-export 新增断言 <n> 条）
人工目视: <一句话描述/见 verification.md 小节>
断言数: 脚本 624 → <k>（新增逐项）；vitest 15 文件 194 例 → <..>；UI 4 文件 31 例 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
