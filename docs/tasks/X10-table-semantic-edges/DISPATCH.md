# X10 任务书：表间语义关系线（sourceTable ↔ sourceTable 语义血缘边）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X10")`（含 scope/acceptance，即验收契约）。

## 1. 背景与动机

govio-map 是无限画布数据治理工具：自然语言 → agent 生成 SQL/DataFrame/报告/图表，节点落画布并按数据血缘自动连边。

**当前缺口**：`sourceTable`（物理表）节点之间**没有任何连线**。建边逻辑只覆盖两类：
- 数据血缘（绿色实线动画）：`referencedNodes`（prompt 引用）与 `sourceRefs`（label 匹配 title/tableName/dfName）
- 语义血缘（紫虚线静态，T2.2 口径沿袭）：**仅限 `sqlQuery` ↔ `sqlQuery`**（按 `semanticRefs` 的 `entityType:id` 交集判定）

外键/表间关系目前只有两种弱呈现：① 字段级 `references` / FK 徽标（`SourceTableNode.tsx`）；② `govio-cli observe explore` 的外键发现只产出文字报告。产品演示脚本已把它列为「功能缺口」，并写明若实现则场景 1 升级为「节点间自动连出 3 条外键边」（`docs/demo/video-script-chocolate.md` 第 106 / 115 / 293 行）。

**目标**：星型模型的 4 张表上画布后，自动出现 3 条 `fact_sales → dim_*` 的语义血缘边（紫虚线），归入既有 `lineageKind:"semantic"` 体系；图谱不可用时优雅降级（不建边、不报错、有留痕）。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、环境约定、PR 门禁）
2. `.pi/APPEND_SYSTEM.md`（运行时硬约束：**SQL 生成纪律、Cypher 查询纪律、govio-cli 输出禁止截断**）
3. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X10")` 的 `note` / `scope` / `acceptance`
4. `.agents/skills/govio/assets/schema.md`（**执行任何 Cypher 前必读**：节点标签、属性名、关联关系）
5. `src/store/canvas-store.ts`（建边主逻辑，见 §3 行号）
6. `src/utils/lineage.ts`（`lineageEdgeAppearance` / `lineageKindOf`，语义边样式唯一来源）
7. `server/graph-query.ts`（`runGraphQuery` / `parseQueryRows` / `isEmptyResultOutput` / `clearGraphQueryCache`）与 `server/prompt-injection.ts`（图谱查询 + `graphStatus` 降级模式的既有范例，尤其第 210-230 行的 Cypher 与全限定名变体匹配）
8. `server/extensions/govio-canvas.ts`（`govio_create_source_table` 工具，约第 713-768 行；及 observe load 结果 → dataFrame 节点的 `source_tables` 血缘处理）
9. `src/types/index.ts`（`TableField.references` 第 39 行、`SourceTableNodeData` 第 63 行起）、`src/services/canvas-service.ts`（`CanvasEvent` 第 3-40 行）、`server/govio-node-queue.ts`（`GovioNodeCreateEvent`）
10. `docs/tasks/T2.2-semantic-lineage/`（语义血缘的既有设计与取舍）、`docs/tasks/X4-test-infra/DISPATCH.md`（测试基建约定）、`tests/integration/canvas-store.test.ts`（建边测试范式）
11. `docs/specs/01-canvas.md`、`02-nodes.md`、`05-store.md`、`06-backend.md`（判断哪些章节需同步）

## 3. 实证事实（主会话已调研，避免重复踩坑）

**建边代码位置**（`src/store/canvas-store.ts`，`createGovioNode` 内）：
- 约 277-292 行：`event.referencedNodes` → 数据血缘边
- 约 294-316 行：`event.sourceRefs` → label 匹配（`d.title` / `d.tableName` / `d.dfName`）建数据血缘边
- 约 318-341 行：语义血缘边，**判定条件为 `event.nodeType === "sqlQuery" && event.semanticRefs?.length`**，遍历既有节点时还要求 `d.type === "sqlQuery"`；样式取 `lineageEdgeAppearance('semantic')`，edge id 加 `-sem` 后缀防与数据血缘边冲突
- 收尾：`positionNewNode(nodes, newNode, newEdges)`（dagre 布局，只吃 newEdges）→ `set({nodes, edges})`

**图谱实况（本机 live 图库，已实测）**：

```bash
govio-cli query -c "MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) RETURN a.full_table_name AS src, r.relationship_type AS rel, r.source_columns AS src_cols, b.full_table_name AS tgt, r.target_columns AS tgt_cols LIMIT 10"
```
```json
[{"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"channel_id","tgt":"chocolate.chocolate.dim_channel","tgt_cols":"channel_id"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"country_id","tgt":"chocolate.chocolate.dim_country","tgt_cols":"country_id"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"product_id","tgt":"chocolate.chocolate.dim_product","tgt_cols":"product_id"}]
```

- ⚠️ **`r.source_columns` / `r.target_columns` 从图库返回的是字符串**（`"channel_id"`），而导入源文件 `D:/Work/gov-io/govio/data/chocolate_relationships.json` 里是数组（`"Cols": ["product_id"]`）→ 解析必须同时容错字符串与数组，别假定形状
- `a.full_table_name` 是**三段式** `chocolate.chocolate.fact_sales`（catalog.schema.table，duckdb），与 sourceTable 节点的 `qualifiedName` 同形；而节点 `tableName` 通常是裸表名（`fact_sales`）→ 匹配需要变体集合（`prompt-injection.ts:223` 有现成写法：`WHERE c.full_table_name IN [<forms>]`）
- 图谱 schema（`schema.md`）：`PhysicalTable` 属性 `id / full_table_name / schema / table_name / name / data_entity_type / database_name / node_id`；`RELATES_TO` 属性 `relationship_type / description / source_columns / target_columns`。**不得凭记忆写属性名**（未出现在 schema.md 的属性会触发 Ladybug `Binder exception`）
- `runGraphQuery` 有 12s 超时、内部缓存与 `clearGraphQueryCache()`；空结果输出是 `Data not found.`（由 `isEmptyResultOutput` 识别，**不是** `[]`；见 BUGFIX-injection-graph-key 教训）

**已泛化、预期无需改动的下游**（请自行核实后再决定动不动）：
- `src/utils/export-report.ts`：第 371 行 `lineageKindOf(e)`、409-415 行按 kind 选 marker/样式、1216 行 `edgeLegend` 已遍历 `["data","semantic"]` → 表间语义边应自动正确渲染进导出 HTML
- `src/components/Canvas/LineageLegend.tsx`：`KINDS = ['data','semantic']`，与边端点类型无关
- `src/utils/lineage.ts`：`lineageKindOf` 对旧边/未知值回退 `"data"`（历史 sidecar 兼容）

**协议与持久化事实**：
- `src/types/ws-protocol.ts`：`PROTOCOL_VERSION = 1`；`canvas_save`（227 行）与 `canvas_restore` 的 `nodes/edges` 载荷是 `Type.Array(Type.Unknown())` → **新增节点字段不需要改协议版本**（服务端出站消息也不做运行时校验）
- `CanvasEvent`（前端 `src/services/canvas-service.ts:3-40`）是 `GovioNodeCreateEvent`（`server/govio-node-queue.ts`）的**手工镜像**，两处都要加字段，形状纪律沿用 T2.0：拿不到就**不建键**（`...(x ? {x} : {})`），不要写 `undefined`
- 画布快照由前端 debounce 1s 经 `canvas_save` 落到会话 sidecar（`server/session-history.ts`），恢复走 `canvas_restore` → `hydrateSession`

**验证基线（必须零回归，主会话实测于 commit `5bf483f`）**：
- `npm run verify` 全链约 **36s**，退出码 0
- 专项脚本断言合计 **609 项 0 失败**：manifest 92 / rerun 71 / audit 119 / export 126 / source-table 39 / semantic-lineage 45 / caliber-conflict 46 / cwd 13 / prompt-injection 58
- vitest：**Test Files 7 passed (7) / Tests 83 passed (83)**

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **关系数据获取（server 侧）**：为 sourceTable 节点补齐表间关系。推荐主路径 = 图谱 `RELATES_TO` 查询（走 `runGraphQuery`，按 `qualifiedName` / `full_table_name` 变体匹配，解析容错字符串与数组两种列形状）；**降级路径** = 字段级 `fields[].references`（`isForeignKey` + `references.table/field`）；两者都拿不到 → 不附加字段、不建边。降级与失败必须留痕（参照 `prompt-injection.ts` 的 `graphStatus`/`graphError` 写法），且**绝不阻断节点创建**。查询失败/超时/空结果一律按降级处理，不抛给用户。
2. **类型与事件字段**：`GovioNodeCreateEvent` + `CanvasEvent` + `SourceTableNodeData` 同步新增（建议名 `tableRelations`，元素形如 `{ targetTable, relationshipType, description?, sourceColumns?, targetColumns? }`）；可选字段缺失不建键；`relationshipType` 用图库原值（如 `many_to_one`），不做本地枚举收窄（避免与 CLI 侧漂移）。
3. **建边（canvas-store）**：新 sourceTable 节点落地时，与既有 sourceTable 节点做**双向匹配**——① 新节点的 `tableRelations.targetTable` 指向既有节点；② 既有节点的 `tableRelations.targetTable` 指向新节点（星型模型里 dim 表可能后上画布）。边：`type:"smoothstep"`、`data.lineageKind:"semantic"`、样式全量取 `lineageEdgeAppearance('semantic')`、id 形如 `e-<src>-<tgt>-sem`；**同一对节点只保留一条**（与已有数据血缘边可并存，但语义边自身去重）。匹配键需容忍三段式/两段式/裸表名差异（用 `qualifiedName` 优先、`tableName` 兜底的变体集合）。
4. **持久化与恢复**：确认边随 sidecar 往返无损（`canvas-store.test.ts` / `canvas-sidecar.test.ts` 已有范式）；`hydrateSession` 恢复历史会话时**不得重复建边**；旧会话缺表间边时是否补建 → 在 `design.md` 明确取舍（做或不做都可，但必须写清理由与影响）。
5. **展示与导出核实**：跑通「导出交付报告」路径，确认表间语义边在 HTML 血缘图与图例中正确呈现（预期无需改动；若发现 gap，只做最小修复并在 CHANGES.md 记录）。
6. **测试**：扩展 `tests/integration/canvas-store.test.ts`（node 环境，`useCanvasStore.getState()` 直驱）覆盖：星型 3 条边、双向匹配（先建 fact 后建 dim / 先建 dim 后建 fact 两种顺序）、同一对节点去重、与数据血缘边并存、`tableRelations` 缺失时不建边、关系目标不在画布时不建边不报错；如新增 server 侧纯逻辑（关系解析/变体匹配），抽成可单测函数并补用例。**每条链路至少 1 个失败/边界用例**（沿用 X4 约定）。
7. **文档同步**：`docs/specs/` 中涉及建边与 sourceTable 节点形状的章节；`docs/demo/video-script-chocolate.md` 的「功能缺口」「导演注意」「录制前检查清单」（第 106 / 115 / 293 行）按实现结果更新（实现后删除缺口声明、把场景 1 升级为连线版本）。
8. **三件套**：`docs/tasks/X10-table-semantic-edges/design.md`（方案与取舍 + **「遗留问题」小节**）、`CHANGES.md`（文件清单 + 每处摘要）、`verification.md`（验证命令与关键输出、断言数前后对比）。

## 5. 范围纪律（明确不做）

- **不改 `docs/task-plan.json`**（并行派发，计划记账由主会话统一执行；你只在自己的 worktree 改代码与交付物）
- 不改 WS 协议版本、不动 `src/types/ws-protocol.ts` 的既有消息 schema
- 不动 X11 刚修复的 `src/components/SettingsModal.tsx` 与 `src/utils/provider-drafts.ts`
- 不做表间关系的新交互（点击边看关系详情、关系编辑器、布局算法改造等）；不改 `lineage.ts` 的色值/线型体系（如需新增第三种血缘类别，先写进 design.md 遗留问题，不自行扩张）
- 不引入新依赖（运行时或 dev 均不引入）
- 不顺带重构、不顺带修其他已知问题；**新发现一律写入 `design.md` 的「遗留问题」小节**
- 不调用真实 LLM；图谱查询只读，禁止任何写图/清图命令（`meta graph` 一类）
- 不主动读取业务数据内容（`observe load -o` / `observe info --rows>0` 会触发权限闸门，本任务不需要数据行）

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
  `.agents/`（含 skills 与 `govio/assets/schema.md`）被 `.gitignore` 忽略，fresh worktree **不含**该目录，约 350K
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪，`npm install` 由 repo setup hook 自动执行）；**不切分支、不 push、不合并**（合入走 PR，由主会话创建、用户合并）
- 同一 worktree 只有你一个写者；不要 `git add -A` 之外的仓库外文件
- Windows Git Bash 约定：路径统一正斜杠、**不要以反斜杠结尾**；`python` 是 Windows Store 存根**不可用**（需脚本语言用 node/tsx）；解析 JSON 用 `jq`（`/d/Work/jq/jq`）
- **禁止用 `head`/`tail`/`sed`/`grep` 截断 `govio-cli` 输出**（JSON 被截断即无法解析）；需要摘要用 `jq` 提取字段
- 执行任何 Cypher 前必须先读 `.agents/skills/govio/assets/schema.md`（仅需一次）；属性名不得凭记忆构造
- commit：**单次 commit**，message 前缀 `X10: ...`
- 验证门槛（全绿才算完成，任一非零退出即失败；修复后重跑，**禁止虚报**）：
  `npm run build`、`npm run lint`、`npm run verify`（既有 609 项断言 + 83 例零回归 + 你的新增用例），且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态（主会话验收时统一置 done/accepted）
- 遇到模型通道/环境类阻塞（依赖装不上、CLI 不可用等）：用 `ask` 问主会话，不要自行换方案或换工具链

## 7. 时间预算

- 总预算 **75 分钟**
- **到期前 15 分钟为 checkpoint 点**：若未完成，先把已改文件与三件套的当前状态 commit（message 前缀 `X10: WIP ...`），并在汇报中写明「已改文件 / 验证状态（哪些门槛已跑、结果如何）/ 剩余工作」。**超时不是变更安全边界**——不要为了赶时间跳过验证或留下半改状态
- 建议节奏：读档与调研 ≤15min → server 侧关系获取 + 类型 ≤20min → canvas-store 建边 ≤15min → 测试 ≤15min → 文档与三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X10-table-semantic-edges/{design.md,CHANGES.md,verification.md}
commit: <hash> <message>
断言数变化: vitest 7 文件/83 例 → <n> 文件/<m> 例；脚本断言 609 → <k>（新增用例数与覆盖点）
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>（verify 耗时 <s>s）；git status 干净=<是/否>
星型模型验证: 3 条 fact→dim 语义边=<是/否>；降级路径验证=<方式与结果>
遗留: <design.md 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号（**只把结论写在终端不算完成**）。未完成也要发 `worker_done`，`--outcome` 用 `failed`/`blocked` 并说明缺口，禁止虚报验证结果。
