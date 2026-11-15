# X15 变更清单

> 单次 commit，前缀 `X15:`。10 文件 **+81 / −51**（含三件套另计）。X15.1 追加改动见文末专节。
> 纪律：**只改展示层**——数据层（`TableRelation.relationshipType`）、取数层（`server/table-relations.ts`）、
> 匹配/去重（`src/utils/table-relations.ts`）、样式唯一来源（`src/utils/lineage.ts`）、排版
> （`src/utils/layout.ts`）、协议（`PROTOCOL_VERSION`）一字未动。

## 源码（4 文件）

| 文件 | 处 | 摘要 |
|---|---|---|
| `src/utils/table-relations-ui.ts` | `relationEdgeLabel()`（+注释） | label 由「`类型 · 列映射`」改为**只有列映射**；摘要关系由固定 `relations[0]` 改为 `find(有列映射的第一条)`（去掉类型兜底后，首条缺列不该让 label 直接变空）；全部缺列返回空串；`+N` 语义不变（N=其余条数）。注释写明 X15 动机与「类型仍随 sidecar 持久化、恢复展示只改展示层」 |
| `src/components/Nodes/SourceTableNode.tsx` | 表间关系小节 | 删除 `rel.relationshipType && <span …徽标>` 整块（node-source 紫底徽标）；小节顶部注释改为 X15 口径。**DOM 层级不变**（徽标原嵌在目标表所在 flex 行内）→ 既有按 `row.children.length` 断言结构的用例无需修改即通过 |
| `src/utils/export-report.ts` | `tableRelationsBlock()`；边 SVG `<title>` 注释 | 关系表由四列变三列：去掉类型单元格（`badge(rel.relationshipType)`）与表头 `关系类型` → `table(['目标表','列映射','说明'], rows)`；函数注释补 X15 取舍。`badge()` 保留（Manifest/复跑/确认门仍在用）。SVG `<title>` 经 `relationEdgeLabel` 自动去掉类型段 |
| `src/store/canvas-store.ts` | 表间语义边建边处 | `label` 改为**空串就不建键**（`...(label ? { label } : {})`），避免「只有类型没有列」的关系渲染出空 label；注释更新为 X15 口径。形状/样式/Handle/`data.lineageKind` 仍全部由 `lineageEdge` 工厂派生 |

## 测试（3 文件，反向断言替代正向断言，总数只增不减）

| 文件 | 处 | 摘要 |
|---|---|---|
| `tests/integration/table-relations-ui.test.ts` | 文件头注释；label 用例；候选合并用例；建边用例 ×2 | ① label 期望 4 处去掉类型前缀（`product_id → product_id`、`… +2`、`… +1`、星型三条排序数组）；② label 用例新增两条断言：不含 `many_to_one`、**首条缺列时取次条**（`x → y +1`）；③ 「② 方向建边」用例改为断言 `label` 为 `undefined` 且 `"label" in edges[0] === false`，并新增「类型原值 `one_to_many` 仍在 `edge.data.tableRelations` 里」的**数据留痕断言**；④ 星型建边用例新增 `rels[0].relationshipType === "many_to_one"`（数据未丢）+ `e.label` 不含类型；⑤ `candidates[0].relations?.[0].relationshipType` 一类既有数据断言原样保留 |
| `tests/ui/source-table-node.test.tsx` | 星型关系用例；降级留痕用例 | ① 用例标题改为「裸表名 + 列映射可见，关系类型不显示（X15）」；`getAllByText("many_to_one")).toHaveLength(3)` → `queryByText("many_to_one")).toBeNull()` + `document.body.textContent` 不含该串；② `source=fields` 降级用例补 `queryByText("foreign_key")).toBeNull()`（降级路径的类型值同样不得泄漏；「字段级关系」提示是**来源**不是类型，照旧显示） |
| `scripts/verify-export-report.ts` | `[3]` 节点卡片段；`[3b]` 边段 | ① 关系小节断言去掉 `includes("many_to_one")`，标题改为「目标表 / 列映射 / 说明」；② **新增 1 项断言**：导出全文不含 `<th>关系类型</th>`、不含 `many_to_one`、不含 `foreign_key`；③ 边悬停断言 `<title>rel-1 → rel-2 · many_to_one · customer_id → id</title>` → `<title>rel-1 → rel-2 · customer_id → id</title>` 且 `relHtml` 不含类型 |

**未修改即通过**（零回归硬证据）：`tests/integration/table-relations.test.ts`（server 侧 27 例）、
`tests/integration/canvas-store.test.ts`（X10 星型建边/双向匹配/无向去重/并存/恢复不重建）、
`tests/integration/layout.test.ts`（PR #31 方案B 排版）、`scripts/verify-semantic-lineage.ts`（48 项，
含 `edge.type === APPEARANCE.edgeType`、SEMANTIC_* Handle、边 data 随 sidecar 往返）。

## 文档（3 文件）

| 文件 | 处 | 摘要 |
|---|---|---|
| `docs/specs/02-nodes.md` | `tableRelations?` 字段行；「X13 关系详情出口」段；节点结构第 4 条 | 三处同步为 X15 口径：字段行注明「`relationshipType` 只落盘留痕，画布与导出均不展示」；出口段写明三处一律不显示类型、只留字段关联、类型仍随 `node.data`/`edge.data` 落 sidecar；结构第 4 条删掉类型徽标描述并注明 X15 |
| `docs/specs/06-backend.md` | `tableRelations` 事件字段行 | 注明「X15 起三处只展示字段关联（列映射），不再展示 `relationshipType`，但**服务端仍照原样解析并下发**该字段供留痕」 |
| `docs/demo/video-script-chocolate.md` | 场景 1 第 3 条 | 演示口径更新：图谱里的 `many_to_one` 仅落盘留痕、画布不展示；节点小节与边 label 均描述为「列映射」（同节点对多条附 `+N`） |

## X15.1 追加改动（用户裁决 2026-11-13：「hover 显示 description 先保留」）

> 同一 PR（#34）的第二个 commit。口径：图谱 `description` **保留但不再占可见行**，改为关系行 hover 的
> `title` 按需查看；关系类型仍不进任何展示（包括 hover）。

| 文件 | 处 | 摘要 |
|---|---|---|
| `src/utils/table-relations-ui.ts` | 新增 `relationRowTitle()` | 行 hover 全文的**唯一取值来源**：`关系目标表：<全限定名>` / `字段关联：<列映射>` / `说明：<description>`，`\n` 分隔，**缺项自动省略**（空白 description 不算有说明、单侧列缺失只带存在侧）；**不拼 `relationshipType`** |
| `src/components/Nodes/SourceTableNode.tsx` | 关系行 | 行 `<div>` 挂 `title={relationRowTitle(rel)}`；删除目标表 `<span>` 上的局部 `title`（避免嵌套 title 遮蔽）与 `rel.description && <div>` 说明行 → 行子节点 3 → 2；小节注释补 X15.1 口径 |
| `tests/integration/table-relations-ui.test.ts` | 新增 1 例（193 → 194） | 钉 `relationRowTitle`：三段拼接逐字相等、无 description 不带「说明：」、只有类型无列时只剩目标表行且**不含类型原值**、单侧列缺失、空白 description 不算有说明 |
| `tests/ui/source-table-node.test.tsx` | 改写 2 处 | ① 星型用例：`getByTitle("关系目标表：…")` → 正则匹配行级 hover，断言 title 含「字段关联：」、不含「说明：」与 `many_to_one`；② 原「description 渲染说明行」→「**不占行、只在 hover title 里**」：`queryByText("事实表产品外键")` 为 null、`body.textContent` 不含该串、`row.children` 3 → 2、`title` 含「说明：事实表产品外键」 |
| `docs/specs/02-nodes.md` | 出口段、函数清单、节点结构第 4 条 | 同步 X15.1：关系小节只留目标表+列映射，description 随 hover；函数清单补 `relationRowTitle`；并注明导出 HTML（无 hover）仍保留「说明」列的不对称是有意的 |

**未改**（有意为之）：`src/utils/export-report.ts` 的关系表仍为「目标表 / 列映射 / 说明」三列——静态交付物
没有 hover，若也收掉说明列则图谱说明在报告里彻底丢失；`scripts/verify-export-report.ts` 因此不需再改（138 项不变）。

## 交付物（本目录）

- `design.md`：需求解读边界表、只改展示层的四条理由、三处实现要点、测试策略、**遗留问题 5 条**
- `CHANGES.md`：本文件
- `verification.md`：门槛命令与关键输出、断言数前后逐项对照、行为差异清单、人工目视项
