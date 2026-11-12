# X13 变更清单（CHANGES）

> 方案与取舍见同目录 `design.md`；验证命令与关键输出见 `verification.md`。
> 单次 commit，message 前缀 `X13:`。不改 `docs/task-plan.json`（并行派发，记账由主会话执行）。

## 新增文件（2）

| 文件 | 行数 | 摘要 |
|---|---|---|
| `src/utils/table-relations-ui.ts` | 139 | 关系详情的**展示模型**（纯函数、无 React 依赖、node 环境可单测，形状沿袭 `caliber.ts`）。导出 `tableRelationsHint()`（降级留痕唯一判定：`fields` 或有 `tableRelationsError` 才 `showHint=true`，`graph` 正常态与无关系态静默；返回 `badgeLabel` / `detail`（超 60 字截断）/ `detailFull`（全文）/ `hintColor`）、`relationTargetLabel()`（三段式取裸表名）、`relationColumnView()`（两侧都有 `a → b`，单侧缺失只渲染存在的一侧，两侧都缺 `text=''`）、`relationEdgeLabel()`（边 label 摘要：首条关系 + 多条附 `+N`，空输入 `''`）、`TABLE_RELATIONS_SOURCE_LABELS`（`graph`=「图谱 RELATES_TO」/ `fields`=「字段级外键」）、`TABLE_RELATIONS_HINT_COLOR`（`#F59B23` warning token，与 `CALIBER_WARNING_COLOR` 同值）、`MAX_VISIBLE_TABLE_RELATIONS=3`、`MAX_HINT_REASON_LENGTH=60`。不重复做数据校验（清洗复用 `nodeTableRelations`） |
| `tests/integration/table-relations-ui.test.ts` | 443 | 28 例 / 5 组：`tableRelationsHint` 判定矩阵（graph 静默、无关系静默、`fields` 两种、仅 error、空白 error 不误报、矛盾数据仍提示、超长截断、警示色唯一来源）；展示小函数（裸表名、列映射三态与脏元素、label 摘要与 `+N`）；`tableSemanticEdgeCandidates` 携带关系（星型 3 条各带 1 关系、**同节点对多条关系合并**、既有语义边覆盖不产出、② 方向也带出、①优先于②不并入、目标不在画布/非法数据不报错）；`canvas-store` 建边（`data.tableRelations` + `label`，且 `lineageKind`/`type`/`style`/两个语义 Handle 仍由 `lineageEdge` 工厂派生、sqlQuery 口径沿袭边无 label、无列映射时 label 只有类型不出现 `undefined`、旧边恢复不报错）；sidecar `saveCanvas -> loadCanvas` 边深比较无损 + `hydrateSession` 不重复建边 + 降级留痕透传判定 |

## 修改文件（6）

### 边侧数据通路（2）

| 文件 | 变更（+/-） | 摘要 |
|---|---|---|
| `src/utils/table-relations.ts` | +35/-10 | `TableSemanticEdgeCandidate` 新增**可选**键 `relations?: TableRelation[]`（加法扩展，消费方必须容忍缺失）；`push()` 多收一个 relation，把原来的单个 `seen` 集合拆成 `blocked`（既有语义边 -> 不重建）与 `byPair`（本轮已产出 -> **同节点对同方向的多条关系并入同一条候选**，修复「第二条关系被早退吞掉」）；①/② 两处 `push` 传入命中的 relation。**匹配键、变体集合、无向去重、①优先于②、自环丢弃均未改**，`nodeTableRelations` 等函数语义不变 |
| `src/store/canvas-store.ts` | +12/-3 | 引入 `relationEdgeLabel`；表间语义边在 `relations` 非空时 spread 出 `{...edge, data: {...edge.data, tableRelations: relations}, label: relationEdgeLabel(relations)}`；`data.lineageKind`、`type`/`style`/`animated`/`sourceHandle`/`targetHandle` 继续全量来自 `lineageEdge` 工厂，无关系（历史边、sqlQuery 口径沿袭边）不建键不设 label |

### 画布 UI（1）

| 文件 | 变更（+/-） | 摘要 |
|---|---|---|
| `src/components/Nodes/SourceTableNode.tsx` | +103/-1 | 新增「表间关系」小节（在字段区与操作栏之间）：`relations = nodeTableRelations({id, data: nodeData})`，为空整节不渲染；标题行 Link2 图标 + 等宽小标 + 条数；逐条渲染目标表裸名（`title` 挂全限定名）+ `relationshipType` 徽标（`bg-node-source/10 text-node-source`，与 FK 徽标同一视觉语言）+ 列映射行（`columns.text` 为空不渲染）+ `description` 行（缺失不渲染空行）；默认 `MAX_VISIBLE_TABLE_RELATIONS` 条、「+N more relations」展开 /「Collapse」收起（折叠基准按常量固定计算，展开后仍能收起）；新增降级留痕行（`hint.showHint` 才渲染：AlertTriangle + 徽标 + 单行截断文案，色值取 `hint.hintColor` 内联，全文放 `title`）；新增 `relationsExpanded` 状态与 `Link2`/`AlertTriangle` 图标导入，四个 Handle 未动 |

### 导出报告（1）

| 文件 | 变更（+/-） | 摘要 |
|---|---|---|
| `src/utils/export-report.ts` | +67/-3 | `LineageEdgeView` 新增可选 `relations?`；`layoutLineage()` 用 `nodeTableRelations({id, data: e.data})` 带出（有键才建，导出与画布同源）；`lineageSvg()` 的边 `<title>` 在关系存在时追加摘要（数据边/历史边文案不变）；新增 `tableRelationsBlock()`（`label('表间关系（n）')` + `.scroll` 表格：目标表全限定名 `<code>` / 关系类型 `badge()` / 列映射 / 说明，缺失单元格渲染 `—`）与 `tableRelationsTraceBlock()`（`box warn` + 徽标 + `detailFull` 全文）；`sourceTableBody()` 在有 `tableRelationsSource` 时补 info 行「关系来源」（取 `TABLE_RELATIONS_SOURCE_LABELS`）并追加两节；血缘章节说明文案补「悬停连线看表间关系」。线型/marker/图例仍按 `lineageKind` 泛化，自包含性质不变 |

### 验证与测试（2）

| 文件 | 变更（+/-） | 摘要 |
|---|---|---|
| `scripts/verify-export-report.ts` | +52/-0 | 头注释新增第 9 项；fixture `ORDERS` 加 2 条图谱形状关系（含三段式目标、列映射，其中一条 `description` 内嵌 `XSS_SENTINEL`）+ `tableRelationsSource: "graph"`，`CUSTOMERS` 加 1 条字段级关系（只有 `targetColumns`）+ `fields` + `tableRelationsError: "spawn govio-cli ENOENT"`；`[3]` 新增 6 项断言（关系小节四类字段、两种来源文案、降级原因全文、单侧映射只渲染存在侧、说明里的注入串被转义、
  图谱正常态不渲染降级警示框）；新增 `[3b]` 段 5 项断言（`LineageEdgeView.relations`、语义边 `<title>` 带关系摘要、数据边 `<title>` 零变化、线型/dasharray/marker/图例仍按 `lineageKind` 泛化、新增内容不破坏自包含）。**126 -> 137 项，既有断言一项未削弱**；`EDGES` fixture 故意不改（改边会动到 `edges.length === 9` / `droppedEdges === 2` / 层次断言）；未传 `--write`，受跟踪样例 `docs/tasks/T1.4-canvas-export/sample-export.html` 未更新 |
| `tests/ui/source-table-node.test.tsx` | +140/-1 | 新增 `TableRelation` 类型导入与 describe「SourceTableNode 表间关系出口（X13）」10 例：星型 3 条关系（裸表名 / `many_to_one` 徽标 / 列映射）可见；`description` 存在时多一行、缺失时不渲染空行（按行数断言）；无 `tableRelations` 整节不渲染；4 条时折叠 + 展开 + Collapse；单侧缺失只渲染存在侧；`fields` 出现「字段级关系」而 `graph` 不出现；长原因截断且 `title` 保留全文；仅 `tableRelationsError`（无关系）提示「图谱降级」且小节仍不渲染；脏关系元素被过滤不报错；Handle 仍为 4 个（左右 + 语义上下）。UI 用例 **21 -> 31** |

## 文档（5 + 三件套）

| 文件 | 摘要 |
|---|---|
| `docs/specs/02-nodes.md` | X10 三键段落后新增「X13 关系详情出口」段（三处出口 + 唯一来源模块 + 「不打扰」纪律）；SourceTableNode 布局列表插入第 4 项「表间关系小节」、第 5 项「关系来源轻提示」，操作栏顺延为第 6 项 |
| `docs/specs/05-store.md` | 表间语义血缘边条目补充：候选携带 `relations?`、同节点对同方向合并、建边写入 `edge.data.tableRelations` 与 `edge.label`，且 `lineageKind`/`type`/`style`/Handle 仍由 `lineageEdge` 工厂派生；关系缺失时不写新键 |
| `docs/specs/01-canvas.md` | 「导出交付报告」按钮行补充 sourceTable 快照含关系小节与来源留痕、血缘 SVG 边悬停带出类型与列映射 |
| `docs/specs/06-backend.md` | `tableRelations` 字段行补充「节点内小节 / 边 label / 导出报告」三处展示出口及唯一来源文件 |
| `docs/demo/video-script-chocolate.md` | 场景 1 步骤 3 补「关系详情可见」（列映射 + `many_to_one` + 边 label）；导演注意补降级时节点底部轻提示可见；文末差异表 X10 行补 X13 出口 |
| `docs/tasks/X13-table-relations-ui/` | 三件套：`design.md`（目标/展示模型/边侧取舍/判定表/导出/持久化/验证方式 + 7 条遗留问题）、`CHANGES.md`（本文件）、`verification.md`（门槛、断言数前后对比、live 图谱只读复核、人工目视清单） |

## 明确未改动（纪律核对）

- `server/table-relations.ts`、`server/extensions/govio-canvas.ts`（取数与三键写入定稿）
- `src/utils/lineage.ts`（未新增 `lineageKind`、未改 `APPEARANCE`/色值/Handle 朝向）、`src/utils/layout.ts`（方案B 未动）
- `src/types/index.ts`、`src/types/ws-protocol.ts`、`PROTOCOL_VERSION`（边新增字段靠 `Type.Array(Type.Unknown())` 透传）
- `src/components/Canvas/Canvas.tsx`（**未注册 `edgeTypes`**，见 design.md §3）、`LineageLegend.tsx`、`CanvasToolbar.tsx`
- `tests/integration/table-relations.test.ts`（X10 server 侧 27 例）、`tests/integration/layout.test.ts`
- `.github/**`（X14 并行写者）、`docs/task-plan.json`、`docs/tasks/T1.4-canvas-export/sample-export.html`
- 无新增运行时/dev 依赖；未调用真实 LLM；图谱仅只读 `query`，未执行任何写图命令