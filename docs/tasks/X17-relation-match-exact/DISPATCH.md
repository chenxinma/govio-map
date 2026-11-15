# X17 任务书：表间关系匹配精确化（档 A：全限定名全等优先）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X17")`（note/scope/acceptance 即验收契约）。
> **用户裁决（2026-11-14）：只做档 A**（全限定名全等优先）。档 B（图谱 PhysicalTable id 匹配）**不在本任务范围**，任何情况下不得实施。

## 1. 背景与动机

X10 建立了表间语义关系线（图谱 `RELATES_TO` → 画布 sourceTable 语义边），遗留①：**同名表跨 catalog/schema 时，点号后缀变体匹配可能误配**（`sales.a.dim_product` 与 `sales.b.dim_product` 都能被裸表名 `dim_product` 的变体集合命中，边可能连错表）。

主会话取证（2026-11-14）：现有 `buildRelatesToCypher` **已经 `RETURN b.full_table_name AS target`**（全限定名一直在手），只是前端匹配没有用它做全等优先，一律走 `tableKeyVariants` 点号后缀变体求交。**档 A = 用已有的 target 全限定名做全等优先匹配，零新增图谱查询**即可消掉主要误配场景。

## 2. 先读清单（按序）

1. `AGENTS.md`、`.pi/APPEND_SYSTEM.md`（Cypher 纪律：执行 Cypher 前必读 `.agents/skills/govio/assets/schema.md`）
2. `docs/task-plan.json → crossCutting[] | select(.id=="X17")` 的 `note` / `scope` / `acceptance`（note 含全部取证结论）
3. `docs/tasks/X10-table-semantic-edges/design.md` §8 遗留 1、`docs/tasks/X13-table-relations-ui/design.md` §8 遗留 5（完成后要标注「已由 X17 解决」）
4. `server/table-relations.ts` 全文（重点 `buildRelatesToCypher`（114-122 附近）与 `relationsFromGraphRows`）
5. `src/utils/table-relations.ts` 全文（现匹配逻辑：`tableKeyVariants` 变体集合求交、去重 pairKey、自环丢弃）
6. `src/types/` 中 `TableRelation` 类型定义处；`docs/specs/02-nodes.md`、`docs/specs/06-backend.md`（要更新的 spec）
7. `tests/integration/table-relations.test.ts`（server 27 例）、`tests/integration/` 中 canvas-store 相关用例（X10 星型/双向/去重）、`tests/ui/table-relations-ui.test.ts`（X13/X15 展示与边 label）
8. `.agents/skills/govio/assets/schema.md`（PhysicalTable/RELATES_TO 属性名；仅当需要查图谱时才执行 Cypher，且只读）

## 3. 实证事实（主会话已取证，避免你重复踩坑）

- `schema.md` 明确 `PhysicalTable.primary_key = id`，属性含 `id / node_id / full_table_name / schema / table_name / name / database_name`；live 图谱实测 id 形如 `PT11B596C1` 且每表唯一（**但档 B 不做，此信息仅供你理解域模型**）
- **当前 live 图谱无重名**（`full_table_name` 与裸 `table_name` 全部 count=1）→ 误配目前是**潜在风险而非现实缺陷**，验收以构造的 fake runner 同名跨库场景为准
- `buildRelatesToCypher`（`server/table-relations.ts:114-122`）已 `RETURN b.full_table_name AS target`；`relationsFromGraphRows` 已把该值带进 `TableRelation` 的 target 字段
- 现有匹配：`src/utils/table-relations.ts` 一律走 `tableKeyVariants` 点号后缀变体集合求交；既有去重语义：无向 pairKey、① 优先于 ②、自环丢弃、既有语义边不重建——**一字不改**
- 字段级降级路径（图谱没给全限定名）**没有**全限定名可落 → 不建新键，行为保持现状
- 本机验证基线（2026-11-14）：**脚本 624 项** / **vitest 15 文件 194 例** / **UI 4 文件 31 例**（ubuntu CI 617 = 624−7 SKIP）
- **并行任务提醒**：W4（X18）在别的 worktree 改 `SQLQueryNode.tsx`、`tests/ui/sql-query-node*`、`docs/specs/02-nodes.md`（不同小节）；W1 改 session-history/分享相关；W2 只动 `.github/`。你**不动它们的文件**；`docs/specs/02-nodes.md` 冲突由主会话 rebase

## 4. 实现范围（逐项编号，对齐 acceptance）

1. `TableRelation` 增可选键 `targetQualifiedName`（取图谱 `b.full_table_name` 原值；缺失**不建键、禁止猜测**）
2. `server/table-relations.ts` 的 `relationsFromGraphRows` 落该键；字段级降级路径不建键（行为不变）
3. `src/utils/table-relations.ts` 匹配改**三级**：① `targetQualifiedName` 与既有节点 `qualifiedName` **全等（大小写归一）**→ 命中即止；② 未命中才退现有 `tableKeyVariants` 变体求交；③ 都不中不建边。既有去重/自环/不重建语义一字不改
4. **自动化断言**（不靠人工）：fake runner 灌**同名跨库**两行（如 `sales.a.dim_product` 与 `sales.b.dim_product`，不同全限定名），验证边连到正确的那一个；覆盖「全等命中时不再误配同名表」「只有裸表名可匹配时退回变体兜底」「字段级降级路径（无 targetQualifiedName）行为不变」；**既有用例不修改即通过**，新增用例只增不削
5. 文档：`docs/specs/02-nodes.md`（`TableRelation` 新键 + 匹配优先级）、`docs/specs/06-backend.md`（tableRelations 事件字段）、`docs/tasks/X10-table-semantic-edges/design.md` §8 遗留 1 与 `docs/tasks/X13-table-relations-ui/design.md` §8 遗留 5 标注「已由 X17 解决」
6. **三件套**落盘 `docs/tasks/X17-relation-match-exact/`：`design.md`（三级匹配定义、大小写归一规则、与档 B 的边界、**「遗留问题」小节**）、`CHANGES.md`、`verification.md`（新增断言逐项列出）

## 5. 范围纪律（明确不做）

- **档 B（`targetGraphId` / `graphNodeId` / id 匹配）严禁实施**（用户明确只批档 A）；可在 design.md 留一段「档 B 后续路线」但不写代码
- 不改展示层口径（X15/X15.1 已定：不显示关系类型、description 只在 hover、导出保留说明列）
- 不改 `src/utils/lineage.ts` APPEARANCE、不改 `src/utils/layout.ts` 方案B、不改 `PROTOCOL_VERSION`（新字段走 `Type.Unknown()` 载荷约定）
- 不改 `docs/task-plan.json`（主会话记账）；不动 W1/W2/W4 的文件
- 不为验证去写图/清图；图谱查询只读（且大概率不需要——fake runner 断言为主）
- 新发现一律写 design.md「遗留问题」

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（被 gitignore，fresh worktree 不含）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，`node_modules` 未就绪就 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 不可用（用 node/tsx）；JSON 用 `jq`
- 执行任何 Cypher 前必须先读 `.agents/skills/govio/assets/schema.md`；禁止凭记忆构造属性名
- commit：**单次 commit**，message 前缀 `X17: ...`
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`；基线 624/194/31 零回归 + 新增用例（增量在 verification.md 逐项列出）；verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话

## 7. 时间预算

- 总预算 **80 分钟**（`--timeout-ms 4800000`）
- **到期前 15 分钟为 checkpoint 点**（≈65min）：未完成则 commit 已改文件 + 三件套现状（前缀 `X17: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤15min → 实现（键落地 + 三级匹配）≤25min → 断言（fake runner 同名跨库）≤25min → 三件套 ≤15min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X17-relation-match-exact/{design.md,CHANGES.md,verification.md} + <代码文件摘要>
commit: <hash> <message>
匹配三级: <一句话：全等(大小写归一) → 变体兜底 → 不建边>
跨库同名断言: <通过/失败>（fake runner 两行同名表，边连到 <正确目标>）
断言数: 脚本 624 → <k>（新增逐项）；vitest 15 文件 194 例 → <..>；UI 4 文件 31 例 → <..>
既有用例零回归（不修改即通过）: <是/否>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
文档: specs 02/06 已更新=<是/否>；X10/X13 遗留标注=<是/否>
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
