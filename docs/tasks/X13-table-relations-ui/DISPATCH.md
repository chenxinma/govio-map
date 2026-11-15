# X13 任务书：tableRelations 可视化（表间语义边的关系详情与降级留痕 UI 出口）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X13")`（含 scope/acceptance，即验收契约）。

## 1. 背景与动机

govio-map 是无限画布数据治理工具：自然语言 → agent 生成 SQL/DataFrame/报告/图表，节点落画布并按血缘自动连边。

**X10（已 accepted，PR #29）做完的事**：`sourceTable`（物理表）节点之间现在会连出**语义血缘边**（紫虚线）——服务端为每个 sourceTable 节点补齐 `tableRelations`（主路径=图谱 `(:PhysicalTable)-[:RELATES_TO]->(:PhysicalTable)`，降级路径=字段级 `fields[].references`），前端 `canvas-store` 据此双向匹配建边；关系数据与来源留痕（`tableRelations` / `tableRelationsSource` / `tableRelationsError`）随 `node.data` 落 canvas sidecar。

**当前缺口（本任务的全部动机，出自 `docs/tasks/X10-table-semantic-edges/design.md` §8 遗留问题 2，用户 2026-11-11 裁决立项）**：关系数据**在画布上没有任何 UI 出口**。用户只看得到一条紫虚线，看不到：

- 这条边**基于哪几列**（`sourceColumns` → `targetColumns`）
- **关系类型**（`relationshipType`，图谱原值如 `many_to_one`；字段降级路径固定 `foreign_key`）
- 图谱给的**关系说明**（`description`，实测常缺失）
- 来源是**图谱还是字段级降级**（`tableRelationsSource: 'graph' | 'fields'`）
- **降级原因**（`tableRelationsError`，如 `spawn govio-cli ENOENT` / 超时 / `Binder exception`）

**目标**：星型模型 4 张表上画布后，用户能从**节点内**和/或**边上**看到 3 条关系的列映射与 `many_to_one` 类型；图谱降级时能看到「来源=字段级」与原因；导出 HTML 报告含同样信息。正常态（`source='graph'`）**不打扰**。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、环境约定、「合入 main 纪律（PR 门禁）」）
2. `.pi/APPEND_SYSTEM.md`（运行时硬约束：**SQL 生成纪律、Cypher 查询纪律、govio-cli 输出禁止截断**）
3. `docs/task-plan.json → crossCutting[] | select(.id=="X13")` 的 `note` / `scope` / `acceptance`
4. `docs/tasks/X10-table-semantic-edges/design.md`（**重点 §4 建边与匹配、§6 展示与导出核实、§8 遗留问题**）、`CHANGES.md`、`verification.md`
5. `src/types/index.ts`（`TableRelation` 第 57-69 行、`TableRelationsSource` 第 74 行、`SourceTableNodeData` 的三个 X10 键第 136-146 行）
6. `src/utils/table-relations.ts`（185 行，前端**限定名变体匹配 + 语义边候选**纯函数：`tableKeyVariants` / `sourceTableMatchKeys` / `nodeTableRelations` / `relationTargetKeys` / `tableSemanticEdgeCandidates`）
7. `src/utils/lineage.ts`（89 行，**样式唯一来源**：`APPEARANCE` / `lineageEdgeAppearance` / `lineageEdgeDefaults` / `lineageEdge` 工厂 / `SEMANTIC_SOURCE_HANDLE` / `SEMANTIC_TARGET_HANDLE` / `withSemanticHandles` / `lineageKindOf`）
8. `src/store/canvas-store.ts`（第 256-258 行 node.data 三键透传；第 331-345 行表间语义边建边）
9. `src/components/Nodes/SourceTableNode.tsx`（135 行，现有 PK/FK 徽标、字段折叠、qualifiedName 复制行、四个 Handle）
10. `src/components/Canvas/Canvas.tsx`（第 65 行 `defaultEdgeOptions={lineageEdgeDefaults('data')}`；**当前未注册任何 `edgeTypes`**）、`src/components/Canvas/LineageLegend.tsx`（`KINDS = ['data','semantic']`）、`src/components/Canvas/CanvasToolbar.tsx`
11. `src/utils/layout.ts`（320 行，PR #31 的**方案B 排版**：数据血缘 LR 分层 + 语义血缘同列纵向堆叠）与 `tests/integration/layout.test.ts`（钉住方案B）
12. `src/utils/caliber.ts`（38 行，**「不打扰」取舍的范式**：`caliberNodeAppearance` 只在 conflict 时亮灯，consistent/unknown 静默；本任务的降级提示请照这个模块形状做成可 node 环境单测的纯函数）
13. `src/utils/export-report.ts`（1563 行：第 275 行 `LineageEdgeView`、371 行 `lineageKindOf(e)`、407-415 行 marker/stroke 按 kind、1215-1220 行 `edgeLegend`）、`src/utils/export-report-style.ts`、`scripts/verify-export-report.ts`（126 项断言）
14. 测试范式：`tests/ui/source-table-node.test.tsx`（`// @vitest-environment jsdom` + `vi.hoisted` store mock + `ReactFlowProvider`）、`tests/ui/sql-query-node.test.tsx`、`tests/integration/table-relations.test.ts`（471 行 / 27 例，**server 侧已定稿，不要动**）、`tests/integration/canvas-store.test.ts`
15. `docs/green-deck-DESIGN.md` + `src/index.css`（@theme token）、`docs/specs/02-nodes.md` 与涉及导出报告的 spec 章节
16. `.agents/skills/govio/assets/schema.md`（**只有当你要跑真实 Cypher 时必读**；属性名不得凭记忆构造）

## 3. 实证事实（主会话已调研并实测，避免你重复踩坑）

**数据形状（已定稿，你只消费不修改）**：

```ts
// src/types/index.ts:57-69
interface TableRelation {
  targetTable: string;        // 图谱 full_table_name 原值（duckdb 三段式）或字段 references 原值
  relationshipType: string;   // 图谱原值（如 many_to_one）；字段降级路径固定 "foreign_key"
  description?: string;       // 图谱 r.description，实测常缺失 → 缺失省略键
  sourceColumns?: string[];   // 图谱 r.source_columns 解析后；缺失/空省略键
  targetColumns?: string[];
}
type TableRelationsSource = 'graph' | 'fields';
// SourceTableNodeData: tableRelations? / tableRelationsSource?（仅 relations 非空时写键）/ tableRelationsError?（降级时写键，即使降级路径拿到了关系）
```

**live 图库实况（X10 实测原值，可直接当 fixture）**：

```json
[{"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"channel_id","tgt":"chocolate.chocolate.dim_channel","tgt_cols":"channel_id"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"country_id","tgt":"chocolate.chocolate.dim_country","tgt_cols":"country_id"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"product_id","tgt":"chocolate.chocolate.dim_product","tgt_cols":"product_id"}]
```

- ⚠️ 图谱返回的 `source_columns` / `target_columns` 是**字符串**（`"channel_id"`），导入源文件里是数组——`parseColumnList`（server 侧）已容错，到你手上已是 `string[]`
- ⚠️ 这 3 行**没有 `description`** → UI 必须优雅处理缺失（不渲染空行、不出现 `undefined`）
- 若要自己查图谱复核（只读、非必需）：`govio-cli query -c "MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) RETURN a.full_table_name AS src, r.relationship_type AS rel, r.source_columns AS src_cols, b.full_table_name AS tgt, r.target_columns AS tgt_cols LIMIT 10"`（**先读 schema.md**；空结果输出是 `Data not found.` 而不是 `[]`）

**建边链路的关键约束**：

- `src/store/canvas-store.ts:331-345`：`tableSemanticEdgeCandidates(nodes, {id, data}, edges)` → 对每个候选调 `lineageEdge("semantic", { id: \`e-${sourceId}-${targetId}-sem\`, source, target })`
- ⚠️ **`TableSemanticEdgeCandidate` 目前只有 `{ sourceId, targetId }`（`src/utils/table-relations.ts:35-38`），不携带匹配到的 relation** → 想在**边上**显示关系详情，必须给候选做**加法扩展**（如 `relation?: TableRelation` 或 `relations?: TableRelation[]`），这个前端 util **在你可改范围内**；`server/table-relations.ts`（取数/降级，278 行 + 27 例覆盖）**不在范围内**
- `lineageEdge` 是**唯一建边工厂**（`lineage.ts:64-66`）：返回 `{...parts, ...lineageEdgeDefaults(kind), data:{lineageKind:kind}}`。要挂额外 data，请让工厂接受可选 data 参数或在调用处 spread，但**必须保持 `type/animated/style/sourceHandle/targetHandle` 全部由 `lineageEdgeDefaults` 派生**、`data.lineageKind` 不被覆盖
- 被 `scripts/verify-semantic-lineage.ts` 钉住的既有断言（**48 项，零回归**）：第 248 行 `data.lineageKind === "semantic"`、250 行两个 SEMANTIC_* Handle、251-252 行 `type === lineageEdgeAppearance("semantic").edgeType`、269-274 行数据边无 Handle 且 kind 正确、281-284 行 `lineageKindOf` 回退语义、297-301 行 **边 data 随 sidecar JSON 往返不丢**
- PR #31（`cc81ee4`，已合并）新增了 `APPEARANCE.edgeType`（data=smoothstep / semantic=bezier）与语义专用 Handle（`semantic-source`@Bottom / `semantic-target`@Top），`SourceTableNode.tsx` 末尾已渲染这两个 Handle；`withSemanticHandles` 负责把旧持久化边升级——**这些都不能回归**
- PR #31（`f6eb0af`）的方案B 排版把语义同伴**同列纵向堆叠**（源在上、目标在下），线走节点间隙；`tests/integration/layout.test.ts`（107 行）钉住该行为。你若改边 data/Handle，务必保持 layout 测试全绿

**导出侧现状**（X10 §6 已核实「无需改动」，本任务要**新增**关系详情）：`LineageEdgeView`（`export-report.ts:275`）目前只带 `lineageKind`；SVG marker 与 stroke 按 kind 取（407-415）；图例遍历两种 kind（1215-1220）。导出必须保持**自包含**（无 `<script`、无外部引用、内联样式），`scripts/verify-export-report.ts` 有 126 项断言钉住这些性质；受跟踪的样例 `docs/tasks/T1.4-canvas-export/sample-export.html` **只有显式传 `--write` 才更新**（CI/verify 默认不传，你别传）。

**「不打扰」范式（照抄这个形状）**：`src/utils/caliber.ts` 的 `caliberNodeAppearance(check)` → `{showWarning, warningColor, badgeLabel}`，只有 `conflict` 亮灯（`#F59B23` green-deck warning token），`consistent`/`unknown` 全静默。建议为降级留痕做同构纯函数（如 `tableRelationsHint({tableRelationsSource, tableRelationsError, tableRelations})` → 是否提示 + 文案 + 色调），放 `src/utils/`，便于 node 环境单测且不在组件里散落判断。

**设计 token（禁止在组件里写死色值）**：`src/index.css` @theme + `docs/green-deck-DESIGN.md`——brand `#1DB954`、node-source 紫（`hsl(270,60%,…)` 系）、warning `#F59B23`、error `#E22134`、文本 `#121212`/`#535353`/`#727272`/`#a7a7a7`、边框 `#ececec`/`#d4d4d4`/`#b3b3b3`。组件里用 Tailwind token class（如 `bg-node-source/10 text-node-source`、`text-text-muted`、`border-border-subtle`），与 `SourceTableNode.tsx` 既有 PK/FK 徽标同一套视觉语言。

**测试基建现状与局限**：`tests/ui/*.test.tsx` 走 jsdom（X12 建立），**jsdom 无布局引擎**——高度/间距/对齐类断言测不出来（X12 遗留①，已裁决不引入真浏览器通道）。所以：结构与文案用组件测试断言，视觉/布局靠源码契约断言 + 人工目视，并在 `verification.md` 明说哪些只能人工看。`vitest.config.ts`：`environment: node`、`globals: false`（显式 import describe/it/expect）、`isolate: true`、include `tests/integration/**/*.test.ts` + `tests/ui/**/*.test.tsx`；UI 文件在**文件头**声明 `// @vitest-environment jsdom`。

**验证基线（主会话 2026-11-12 于 main `ac8bab1` 实测，必须零回归）**：

| 门槛 | 结果 | 耗时 |
|---|---|---|
| `npm run build` | ✅ | 62s |
| `npm run lint` | ✅ 零输出 | 34s |
| `npm run verify` | ✅ exit 0，全跑后 `git status --porcelain` 干净 | 94s |

- **脚本断言 612 项 / 0 失败**：manifest 92、rerun 71、audit 119、export 126、source-table 39、semantic-lineage 48、caliber-conflict 46、cwd 13、prompt-injection 58
- **vitest**：`verify:integration` = **14 文件 / 155 例**；`verify:ui` = **4 文件 / 21 例**（UI 用例被执行两次是 X12 已知遗留③，别动）
- verify 链**不需要真实 govio-cli / 图谱 / 网络**（全 mock/stub；`verify:rerun -- --real` 是 opt-in，别开）

**并行任务提醒**：X14（GitHub Actions CI）正在另一个 worktree 并行进行，它**只新增** `.github/workflows/ci.yml` 与自己的三件套，不碰业务代码 → 与你无文件重叠。你**不要**创建或修改 `.github/` 下任何文件。

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **节点内关系详情出口（必做）**：`SourceTableNode.tsx` 新增「表间关系」小节，逐条渲染 `tableRelations`：`targetTable`（建议显示裸表名 + `title` 挂全名）、`relationshipType` 徽标、列映射 `sourceColumns → targetColumns`（任一侧缺失就只渲染存在的一侧，两侧都缺则省略该行）、`description`（缺失不渲染空行）。视觉语言复用既有 PK/FK 徽标与字段折叠交互（多条时默认折叠 + 「+N more」，与字段区一致）；**无 `tableRelations` 时整个小节不渲染**（旧节点形状不变、不出现空壳）。
2. **边侧出口（建议做，至少一种）**：让语义边可看到它基于哪条关系——可选实现：① 自定义 edge 组件（在 `Canvas.tsx` 注册 `edgeTypes`）带关系徽标/label；② 边 hover/点击弹出详情（ReactFlow 的 edge label / `title` / 自有浮层）。若走这条路，需按 §3 扩展 `TableSemanticEdgeCandidate` 与 `edge.data`（保持 `data.lineageKind` 与工厂派生的形状/样式不变），并保证旧边（无新键）不报错。
   - 若你评估后认为边侧出口成本/风险过高（例如与方案B 排版或 Handle 冲突），**可以只做节点内出口**，但必须在 `design.md` 写清取舍与影响，并把它列入「遗留问题」。
3. **降级留痕出口（必做）**：`tableRelationsSource === 'fields'` 或存在 `tableRelationsError` 时给**轻提示**（标明「来源=字段级」与降级原因，原因过长截断 + `title` 全文）；`source === 'graph'` 正常态与无关系态**不显示任何提示**。实现照 `src/utils/caliber.ts` 的纯函数范式（唯一取值来源、可 node 单测），组件里不散落判断、不写死色值。
4. **导出 HTML 同步（必做）**：`buildDeliveryReportHtml` 输出同样的关系详情（targetTable / relationshipType / 列映射 / description / 来源与降级原因），风格与既有 **Manifest 附录**一致（复用 `export-report-style.ts` 的样式工具）；边线型/箭头/图例仍按 `lineageKind` 泛化（`lineageEdgeAppearance` 唯一来源）；保持自包含、无 `<script`、无外部引用。
5. **持久化与恢复**：若扩展了 `edge.data`，断言随 canvas sidecar 往返无损（`saveCanvas → loadCanvas → hydrateSession`）、`hydrateSession` 不重复建边、旧边（只有 `lineageKind`）向后兼容；**不改 `PROTOCOL_VERSION`**（`canvas_save`/`canvas_restore` 的 `nodes/edges` 载荷是 `Type.Array(Type.Unknown())`，新增字段无需改协议）。
6. **测试（必做，每条链路至少 1 个失败/边界用例——X4 约定）**：
   - `tests/ui/`：关系小节渲染（3 条星型关系、列映射、`many_to_one` 徽标）、`description` 缺失不渲染空行、无 `tableRelations` 不渲染小节、降级提示（`fields` / `tableRelationsError`）出现与正常态（`graph`）不出现、折叠交互
   - `tests/integration/`：候选携带 relation payload（若做边侧出口）、`edge.data` 扩展与去重规则不回归、sidecar 往返、旧边兼容
   - `scripts/verify-export-report.ts`：新增断言（导出含列映射/relationshipType/来源与降级原因；图例与线型零回归；无 `<script`）——**只加断言，不削弱既有 126 项**
7. **文档同步**：`docs/specs/` 中涉及 sourceTable 节点形状、画布边与导出报告的章节；若 `docs/demo/video-script-chocolate.md` 里有「只看到一条线 / 关系详情不可见」一类措辞，按实现结果更新；**三件套**落盘 `docs/tasks/X13-table-relations-ui/`：`design.md`（方案与取舍 + **「遗留问题」小节**）、`CHANGES.md`（文件清单 + 每处摘要）、`verification.md`（验证命令、关键输出、断言数前后对比、人工目视项清单）。

## 5. 范围纪律（明确不做）

- **不改 `server/table-relations.ts`**（取数分层、降级纪律、超时闸已定稿，27 例覆盖）；不改 `server/extensions/govio-canvas.ts` 的三键写入逻辑（除非你新增字段必须过事件通道，此时先在 design.md 说明并**同步改 `GovioNodeCreateEvent` 与前端 `CanvasEvent` 手工镜像**，可选字段缺失不建键）
- **不动 X10 遗留问题①**（同名表跨 catalog/schema 变体匹配可能误配）——彻底解法需让关系携带目标三段式全名做全等优先匹配，属取数层改动，须单独立项；`src/utils/table-relations.ts` 只允许**加法**扩展（新增可选字段/新函数），不得改既有匹配语义、去重规则或函数返回的既有含义
- 不改 `src/utils/lineage.ts` 的色值/线型体系，**不新增第三种 `lineageKind`**；不改 `APPEARANCE` 既有取值（如需新视觉元素，用 token class 或新增独立常量并在 design.md 说明）
- 不改 `src/utils/layout.ts` 的方案B 排版算法（PR #31 刚合并，`tests/integration/layout.test.ts` 钉住）；不改 `SEMANTIC_*_HANDLE` 的朝向约定
- 不改 `PROTOCOL_VERSION`、不动 `src/types/ws-protocol.ts` 既有消息 schema
- **不创建/不修改 `.github/` 下任何文件**（X14 并行写者）
- **不改 `docs/task-plan.json`**（并行派发，记账由主会话统一执行）
- 不引入任何新依赖（运行时与 dev 均不引入）
- 不做关系编辑器、不新增关系来源（X10 遗留⑥ `observe explore` 打通、遗留④ 历史会话补建边、遗留③ 前端 mock 路径产出关系——**都不在本任务**）
- 不顺带重构、不顺带修其它已知问题（含 X12 遗留②③）；**新发现一律写入 `design.md` 的「遗留问题」小节**
- 不调用真实 LLM；图谱查询只读，**禁止任何写图/清图命令**（`meta graph` 一类）；不主动读业务数据内容（`observe load -o` / `observe info --rows>0` 会触发权限闸门，本任务不需要数据行）

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
  `.agents/`（含 skills 与 `govio/assets/schema.md`）被 gitignore，fresh worktree **不含**该目录（约 350K）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，跑构建前确认 `node_modules` 就绪，没就绪就 `npm ci --no-audit --no-fund`）；**不切分支、不 push、不建 PR、不合并**（合入走 PR，由主会话创建、用户合并）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、**不要以反斜杠结尾**（会被当转义吞掉引号导致 `unexpected EOF`）；`python` 是 Windows Store 存根**不可用**（需脚本语言用 node/tsx）；解析 JSON 用 `jq`（`/d/Work/jq/jq`）
- **禁止用 `head`/`tail`/`sed`/`grep` 截断 `govio-cli` 输出**（输出是 JSON，截断即无法解析，画布节点会静默丢失）；需要摘要用 `jq` 提字段（保留 `success`/`error`/`column_info`）
- 执行任何 Cypher 前必须先读 `.agents/skills/govio/assets/schema.md`（仅需一次）；未在 schema.md 出现的属性名会触发 Ladybug `Binder exception`
- commit：**单次 commit**，message 前缀 `X13: ...`
- 验证门槛（全绿才算完成，任一非零退出即失败；修复后重跑，**禁止虚报**）：`npm run build`、`npm run lint`、`npm run verify`（与 §3 基线对齐：脚本 612 项 / vitest 14 文件 155 例 / UI 4 文件 21 例 **零回归** + 你的新增用例），且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态（主会话验收时统一置 done/accepted）
- 完成后**必须**发 orca 信号（只把结论写在终端不算完成）：
  `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也要发，`--outcome` 用 `failed`/`blocked` 并说明缺口
- 遇到模型通道/环境类阻塞（依赖装不上、CLI 或图谱不可用等）：用 `ask` 问主会话，不要自行换方案或降级目标（例如不要因为图谱连不上就把关系详情做成硬编码 demo 数据）

## 7. 时间预算

- 总预算 **100 分钟**（`--timeout-ms 6000000`）
- **到期前 15 分钟为 checkpoint 点**（≈85min）：若未完成，先把已改文件与三件套当前状态 commit（message 前缀 `X13: WIP ...`），并在汇报中写明「已改文件 / 验证状态（哪些门槛已跑、结果如何）/ 剩余工作」。**超时不是变更安全边界**——不要为了赶时间跳过验证或留下半改状态（尤其别留下 `edge.data` 改了但往返测试没补的状态）
- 建议节奏：读档与现状核实 ≤20min → 纯函数（降级提示 + 候选扩展）≤15min → 节点内关系小节 ≤20min → 边侧出口（若做）≤15min → 导出同步 ≤10min → 测试 ≤15min → 文档与三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X13-table-relations-ui/{design.md,CHANGES.md,verification.md}
commit: <hash> <message>
出口实现: 节点内关系小节=<是/否>；边侧出口=<自定义 edge 组件/hover 详情/未做+取舍一句话>；降级留痕提示=<是/否>（纯函数名）；导出 HTML 同步=<是/否>
星型模型验证: 3 条关系的列映射 + many_to_one 可见=<是/否>；验证方式=<live 图库人工目视/全链路自动化用例（fake runner）/两者>，关键输出已贴 verification.md=<是/否>
降级验证: 注入方式=<ENOENT/超时/Binder>；「来源=字段级」+ 原因可见=<是/否>；source='graph' 正常态无提示=<是/否>
断言数变化: 脚本 612 → <k>（新增 <n> 项，覆盖点）；vitest 14 文件/155 例 → <..>；UI 4 文件/21 例 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>（verify 耗时 94s → <s>s）；git status 干净=<是/否>
人工目视项: <列出 jsdom 测不了、需人工确认的视觉/布局点>
遗留: <design.md 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也要发 `worker_done`，`--outcome` 用 `failed`/`blocked` 并说明缺口，禁止虚报验证结果。
