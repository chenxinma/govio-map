# X13 设计：tableRelations 可视化（关系详情与降级留痕的 UI 出口）

> 任务书见同目录 `DISPATCH.md`；验收契约见 `docs/task-plan.json -> crossCutting[] | select(.id=="X13")`。
> 上游：X10（关系取数与建边，PR #29 已 accepted）、PR #31（边样式/语义 Handle 与方案B 排版）、
> T2.3（`src/utils/caliber.ts` 的「不打扰」范式）、T1.4（导出报告自包含）。

## 1. 目标与边界

X10 把关系数据放进了 `node.data` 并连出紫虚线，但画布上**只有线没有信息**（X10 design.md
§8 遗留问题②，用户 2026-11-11 裁决立项）。本任务补 UI 出口，不改取数、不改建边语义：

| 出口 | 位置 | 可见内容 |
|---|---|---|
| ① 节点内「表间关系」小节 | `src/components/Nodes/SourceTableNode.tsx` | 目标表裸名 + `relationshipType` 徽标 + 列映射 + `description`；多于 3 条折叠 |
| ② 边侧出口 | 语义边 `label` + `edge.data.tableRelations` | `many_to_one · product_id → product_id`（同节点对多条时末尾 `+N`） |
| ③ 降级留痕轻提示 | 节点底部一行 | 「字段级关系」/「图谱降级」徽标 + 原因（展示截断，全文放 `title`） |
| ④ 导出 HTML | 节点卡片关系小节 + 「关系来源」行 + `box warn` 留痕 + 血缘 SVG 边 `<title>` | 同 ①②③（原因全文不截断） |

正常态（`tableRelationsSource === 'graph'` 且无 `tableRelationsError`）**不打扰**：节点上没有黄色提示，
没有关系时整个小节不渲染（旧节点形状不变，不出现空壳）。

## 2. 展示模型：`src/utils/table-relations-ui.ts`（新增 139 行）

照 `caliber.ts` 的形状做纯函数（无 React 依赖，node 环境直接单测；文案与色值的**唯一来源**，
组件里不散落判断、不写死色值）：

| 导出 | 作用 | 约束 |
|---|---|---|
| `tableRelationsHint()` | 是否提示 + 徽标 + 文案 + 色值 | 判定表见 §4；`graph` 正常态与无关系态 `showHint=false` |
| `relationTargetLabel()` | 三段式取裸表名 | 全限定名交给 `title`，不臆造 schema |
| `relationColumnView()` | 列映射文案 | 任一侧缺失只渲染存在的一侧；两侧都缺 `text=''`（调用方省略该行） |
| `relationEdgeLabel()` | 边 label 摘要 | 首条关系摘要 + 多条附 `+N`；空输入返回 `''` |
| `TABLE_RELATIONS_SOURCE_LABELS` | 来源文案 | `graph`=「图谱 RELATES_TO」/ `fields`=「字段级外键」（导出「关系来源」行与画布共用） |
| `TABLE_RELATIONS_HINT_COLOR` | 警示色 | `#F59B23`（green-deck warning token，与 `CALIBER_WARNING_COLOR` 同值） |
| `MAX_VISIBLE_TABLE_RELATIONS` / `MAX_HINT_REASON_LENGTH` | 折叠阈值 / 原因截断长度 | 3 / 60 |

关系数据的**清洗**复用 X10 的 `nodeTableRelations()`（非法元素过滤、不猜测补全），本模块只决定
「怎么展示」，不重复校验、不改匹配语义。

## 3. 边侧出口：为什么用 `label` 而不是自定义 `edgeTypes`

- **成本/风险最低**：ReactFlow 内置边会把字符串 `Edge.label` 渲染在路径中点（`EdgeText`），
  与 `lineageEdgeDefaults('semantic')` 的 bezier + `semantic-source`/`semantic-target` Handle 天然兼容；
  排版只吃端点，`src/utils/layout.ts` 与 `tests/integration/layout.test.ts` 零改动全绿（方案B 不受影响）。
- **自定义 edge 组件会顶到既有断言**：`scripts/verify-semantic-lineage.ts` 钉住
  `edge.type === lineageEdgeAppearance('semantic').edgeType`（48 项零回归门槛），`withSemanticHandles()`
  又按同一 `type` 幂等升级历史边。注册 `edgeTypes` 要么改 `type` 取值（断言变红），要么在 `lineage.ts`
  另起样式来源（任务书 §5 明确禁止）。
- 取舍：关系详情在边上是**摘要**（一条 label），完整列映射与说明在节点小节和导出报告里看。label
  所需数据仍随边持久化（`edge.data.tableRelations`），将来换成自定义 edge / 可交互浮层**不必再改建边逻辑**。

数据通路（全部加法）：`TableSemanticEdgeCandidate` 新增可选键 `relations?: TableRelation[]`；
`tableSemanticEdgeCandidates()` 的 `push()` 多收一个 relation，同一节点对**同方向**的后续命中并入
同一条候选。原实现用单个 `seen` 集合「产出即早退」，会把同一节点对的第二条关系吞掉——本次拆成
`blocked`（既有语义边，用于不重建）+ `byPair`（本轮已产出，用于合并），**①优先于②**、无向去重、
自环丢弃、既有边不重建的语义全部不变（既有 27 例 + 48 项断言零回归）。该修正由新测试的「复合外键
同节点对多条关系」用例钉住。`src/store/canvas-store.ts` 建边时 spread 出
`{...edge, data: {...edge.data, tableRelations}, label}`：`data.lineageKind`、`type`、`style`、
`animated`、两个语义 Handle 仍全部来自 `lineageEdge` 工厂；没有关系可挂（历史边、sqlQuery 口径沿袭边）
时既不建 `data` 键也不设 `label`。

## 4. 降级留痕判定表（`tableRelationsHint`）

| `tableRelationsSource` | `tableRelationsError` | 结果 |
|---|---|---|
| `graph` | 无 | 不提示（正常态） |
| 无 | 无 | 不提示（没有关系，同样不打扰） |
| `fields` | 无 | 「字段级关系」+「关系来源：字段级外键（图谱未记录该表关系）」 |
| `fields` | 有 | 「字段级关系」+「关系来源：字段级外键（图谱查询失败：<原因>）」 |
| 无 / `graph`（矛盾数据） | 有 | 「图谱降级」+「图谱关系查询失败：<原因>」（一条关系都没拿到时补「，本表无表间关系」） |

- 空白 / 空串原因**不算降级**（不误报）；`detail` 超 60 字截断加 `…`，`detailFull` 保留全文给 `title` 与导出。
- 提示与建边互不依赖：提示只看 `source`/`error`，建边只看 `relations`（X10 的「降级但仍有字段级关系」
  形状会同时出现边与提示，符合预期）。

## 5. 导出报告（`src/utils/export-report.ts`）

| 位置 | 新增 | 形状 |
|---|---|---|
| sourceTable 卡片 | `tableRelationsBlock()` | `label('表间关系（n）')` + `.scroll` 表格（目标表全限定名 / 关系类型徽标 / 列映射 / 说明），缺失渲染 `—` |
| sourceTable 卡片 | info 行「关系来源」 | 仅在有 `tableRelationsSource` 时渲染（旧节点不出现空行） |
| sourceTable 卡片 | `tableRelationsTraceBlock()` | `box warn` + 徽标 + **全文**原因（与画布同一判定；报告是留痕载体，故比画布不截断） |
| 血缘 SVG | 语义边 `<title>` | `rel-1 → rel-2 · many_to_one · customer_id → id`（数据边/历史边保持原样，无关系摘要） |
| 血缘说明文案 | 追加一句 | 提示「鼠标悬停连线看两端节点与表间关系（类型 + 列映射）」 |

线型 / marker / 图例仍按 `lineageKind` 取（`lineageEdgeAppearance` 唯一来源），dasharray 与
`govio-arrow-sem` 断言零回归；自包含性质不变（无 `<script`、无外部引用，关系说明里的注入串照旧转义）。
`LineageEdgeView` 新增可选 `relations?`，由 `layoutLineage()` 用 `nodeTableRelations({id, data: e.data})`
带出——导出与画布因此消费同一份边数据。

未更新受跟踪样例 `docs/tasks/T1.4-canvas-export/sample-export.html`（CI/verify 默认不传 `--write`，本任务也没传）。

## 6. 持久化与兼容

- 未改 `PROTOCOL_VERSION`，未动 `src/types/ws-protocol.ts`：`canvas_save` / `canvas_restore` 的
  `nodes`/`edges` 载荷是 `Type.Array(Type.Unknown())`，新增边字段天然透传。
- 往返由测试断言：`saveCanvas -> loadCanvas` 后边深比较（含 `data.tableRelations` 与 `label`），
  `hydrateSession` 不重复建边（仍 3 条）。
- 旧数据三向兼容：旧节点无 `tableRelations` -> 小节与提示都不渲染；旧边只有 `lineageKind` -> 无 label、
  不建 `data` 新键、不报错；`withSemanticHandles` 与 PR #31 的 Handle/`type` 语义未触碰。

## 7. 验证方式

- **全链路自动化（fake runner）**：`tests/integration/table-relations-ui.test.ts` 直接用 X10 定稿的
  live 形状（`chocolate.chocolate.fact_sales → dim_channel/dim_country/dim_product`，`many_to_one`，
  列映射同名）灌进 `createGovioNode`，断言候选带关系 -> 建边带 `data.tableRelations` + `label` ->
  sidecar 往返 -> 导出取数；`tests/ui/source-table-node.test.tsx` 断言节点内小节与轻提示的渲染/折叠/缺失。
- **live 图库只读复核（人工，非必需）**：`govio-cli query -c "MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) ..."`
  实测 3 行与 X10 形状一致，且**现在已带 `description`**（X10 当时记录为常缺失）——关键输出见
  `verification.md` §4。画布上的最终视觉效果仍需人工目视（§8 遗留④，清单见 `verification.md` §7）。

## 8. 遗留问题

1. **边上只显示首条关系摘要 + `+N`**：同一节点对多条关系（复合外键 / 图谱多行）时 label 不含全部列映射，
   完整信息要看节点小节与导出报告。若产品要求边上全量可见，需自定义 edge 组件——先解决 §3 的
   `type` 断言与 `withSemanticHandles` 幂等约束（建议单独立项，同时把 label 升级为可交互浮层）。
   > **已裁决（2026-11-14 用户）：保持现状，不立项。**边上就只显示首条关系摘要 + `+N`，
   > 全量信息以节点小节与导出报告为准。
2. **只有出向视图**：`dim_product` 节点里看不到「被 `fact_sales` 引用」——X10 的 `tableRelations` 本身是
   出向数据，②方向的边由对端关系建出（边上带关系），但 dim 节点内没有入向小节。补入向视图需要在前端
   按匹配键反向聚合，属 UI 扩展，本任务未做。
3. **live 图谱现在会返回 `description`**（X10 记录为「实测常缺失」）：实测文案 20+ 字，节点里单行
   `truncate` + `title` 兜底，导出表格里全量可见；是否换行/限长留给设计确认。
   > **已实质解决（X15.1，2026-11-14）**：用户裁决「hover 显示 description 先保留」后，
   > 画布上 description 不再占行，改为关系行 hover 的 `title` 全文（`relationRowTitle()`），
   > 长文案换行/限长问题随之消失；导出报告按用户裁决**保持现状**（仍保留「说明」列）。
4. **jsdom 无布局引擎**（X12 遗留①）：label 在低缩放下的可读性、新增小节导致的节点增高对方案B 纵向堆叠
   间距的影响、警示行黄字对比度都**只能人工目视**，清单见 `verification.md` §7。
5. **X10 遗留① 未动**：同名表跨 catalog/schema 的变体匹配仍可能误配（本任务只在候选上做了加法，
   未改匹配语义；彻底解法需关系携带目标三段式全名，属取数层改动）。
   > **已立项（2026-11-14）→ `crossCutting[X17]`**（表间关系匹配精确化）。用户提议用 `PhysicalTable` 的
   > id 判定；主会话取证：id 确为 primary_key 且逐表唯一（形如 `PT11B596C1`），但**当前 live 图谱
   > `full_table_name` 与裸 `table_name` 均无重复**（误配属潜在风险），且现有 RELATES_TO 查询已返回
   > `b.full_table_name` → X17 默认先做「全限定名全等优先」（零新增查询），用 id 的彻底方案列为可选档 B。
6. **前端 mock 路径仍不产出关系**（X10 遗留③）：`MOCK_TABLES` / `addSourceTableToCanvas` 没有
   `tableRelations`，演示模式下关系小节恒空——形状兼容，不是缺陷。
7. **关系多于 3 条时节点明显变高**：若实测影响画布密度，可考虑更紧凑的出口（徽标 + 浮层），与 §8 遗留① 同批评估。