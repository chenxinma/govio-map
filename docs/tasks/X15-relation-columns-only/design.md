# X15 设计：表间关系展示只保留字段关联（去掉 relationshipType 显示）

> 用户指令 2026-11-13：「X13 修改，不用显示 many_to_one one_to_many 等，只要显示字段关联关系」。
> 实现者：主会话（单写者）；改动面小且已定位到行，未派发 worker。

## 1. 需求与解读

X13 把 `tableRelations` 的关系详情做成了三处出口（节点内小节、语义边 label、导出 HTML），每处都带
**关系类型**（图谱 `r.relationship_type` 原值，如 `many_to_one` / `one_to_many`；字段级降级路径固定
`foreign_key`）。用户判定这类类型标注对看画布的人是噪声，要求只保留**字段关联**（哪几列连到哪几列）。

解读口径（本任务的边界）：

| 元素 | 处置 | 理由 |
|---|---|---|
| `relationshipType`（类型徽标 / label 前缀 / 导出「关系类型」列） | **三处全部去掉** | 用户明确要求 |
| 列映射 `sourceColumns → targetColumns` | 保留（成为唯一主体） | 就是用户说的「字段关联关系」 |
| 目标表名（裸名 + `title` 挂全限定名） | 保留 | 字段关联必须有对端 |
| 图谱 `description` | **X15.1：不再占独立行，改为关系行 hover `title`**（数据与字段本身保留） | 用户裁决 2026-11-13「hover 显示 description，先保留」——画布上关系行只留「目标表 + 字段关联」，说明按需查看；导出 HTML 无 hover，仍保留「说明」列 |
| 降级留痕轻提示（`tableRelationsHint`：字段级关系 / 图谱降级 + 原因） | 保留 | 与关系类型无关，是 X13 的来源留痕出口 |
| `TableRelation.relationshipType` **数据字段** | **保留不动** | 见 §2 |

## 2. 关键取舍：只改展示层，数据层零改动

`relationshipType` 继续由 `server/table-relations.ts` 从图谱解析、经 `govio_create_source_table`
事件写入 `node.data.tableRelations[]`，并随 X13 的 `edge.data.tableRelations` 落 canvas sidecar。

理由：

1. **可追溯**：类型是图谱事实（`RELATES_TO.relationship_type`），留着才能回答「这条边当初凭什么连」；
   审计与将来复跑对账都可能需要它。
2. **可逆**：产品口径可能反复（今天嫌噪声，明天要看基数关系）。只改展示层 → 恢复展示是几行 UI 代码，
   不需要重新取数、不需要迁移历史 sidecar。
3. **不碰已定稿的取数层**：`server/table-relations.ts` 有 27 例覆盖，X13 验收时明确列为禁改；本任务
   同样不动它，也不动 `src/utils/table-relations.ts` 的匹配/去重语义。
4. **协议零影响**：字段本来就在 `node.data` / `edge.data`（`Type.Array(Type.Unknown())` 载荷），
   不改 `PROTOCOL_VERSION`、不改 `CanvasEvent` / `GovioNodeCreateEvent` 形状。

代价：sidecar 里存着一个 UI 不展示的字段（几十字节/条）。可接受。

## 3. 实现要点

### 3.1 边 label（`src/utils/table-relations-ui.ts`）

`relationEdgeLabel` 原为 `[relationshipType, 列映射].filter(Boolean).join(' · ')`，现只剩列映射：

```ts
const first = relations.find((rel) => relationColumnView(rel).text !== '');
if (!first) return '';
return `${relationColumnView(first).text}${relations.length > 1 ? ` +${relations.length - 1}` : ''}`;
```

两处细节：

- **首条缺列时不让 label 白白变空**：改用 `find()` 取第一条**有列映射**的关系做摘要（旧实现固定取
  `relations[0]`，类型兜底掩盖了「首条无列」的情况；去掉类型后必须显式处理）。`+N` 的语义不变
  （N = 其余关系条数，按总条数算，不按有列的条数算）。
- **全部关系都缺列 → 返回空串**，调用方不写 `label` 键（见 3.2），避免渲染空 label。

### 3.2 建边处（`src/store/canvas-store.ts`）

原来无条件 `label: relationEdgeLabel(relations)`，现改为**空串就不建 `label` 键**：

```ts
const label = relations && relations.length > 0 ? relationEdgeLabel(relations) : '';
newEdges.push(relations?.length
  ? { ...edge, data: { ...edge.data, tableRelations: relations }, ...(label ? { label } : {}) }
  : edge);
```

行为差异（唯一一处对外可见变化）：**只有类型、没有列信息**的关系（典型是字段级降级路径里
`references` 缺 `field`，或图谱 `source_columns`/`target_columns` 全缺）以前会显示 `one_to_many`
之类当 label，现在**不显示 label**（边照旧连、`edge.data.tableRelations` 照旧带关系原文）。
这符合「只显字段关联」——没有字段关联可显时就不硬凑文案。既有测试
`tests/integration/table-relations-ui.test.ts` 的「② 方向建边同样带关系」用例已按新语义改写，
并补了「类型原值仍在 `edge.data` 里」的断言。

形状/样式/Handle/`data.lineageKind` 仍全部由 `lineageEdge` 工厂派生（`lineage.ts` 的 `APPEARANCE`
唯一来源），本任务一字未改 → `verify:semantic-lineage` 48 项、`withSemanticHandles` 幂等升级、
方案B 排版（`layout.ts`）全部零回归。

### 3.3 节点内小节（`src/components/Nodes/SourceTableNode.tsx`）

删掉 `rel.relationshipType && (<span …>{rel.relationshipType}</span>)` 徽标块（node-source 紫底那个）。
DOM 结构层级不变（徽标原本嵌在「目标表」所在的 flex 行内，不是同级子节点）→ 既有按
`row.children.length` 断言结构的用例（3 个子节点=目标表行+列映射+说明；2 个=无说明；1 个=只有目标表）
**全部无需修改即通过**，这是「只删展示、不动结构」的硬证据。

### 3.4 导出 HTML（`src/utils/export-report.ts`）

- `tableRelationsBlock`：去掉类型单元格与表头，`table(['目标表','列映射','说明'], rows)`（原四列变三列）
- 边 SVG `<title>`：经 `relationEdgeLabel` 自动变成 `src → tgt · customer_id → id`（不再有类型段）
- `badge()` 辅助函数保留（Manifest/复跑/确认门等仍在用），只是不再被关系小节调用

### 3.5 X15.1 追加（用户裁决 2026-11-13）：`description` 收进 hover

用户回复「hover 显示 description 先保留」——据此把图谱说明从「单独一行可见文本」改为「关系行 hover 的
`title` 按需查看」：信息保留，但不再占视觉重量。

- 新增纯函数 `relationRowTitle(rel)`（`src/utils/table-relations-ui.ts`）作为行 hover 全文的**唯一取值来源**：
  `关系目标表：<全限定名>` / `字段关联：<列映射>` / `说明：<description>` 三行，**缺项自动省略**
  （空白 description 不算有说明），用 `\n` 分隔（浏览器原生 title 按换行渲染）
- `SourceTableNode.tsx`：关系行 `<div>` 挂 `title={relationRowTitle(rel)}`；删掉原目标表 `<span>` 上的局部
  `title`（避免嵌套 title 互相遮蔽）与 `rel.description && <div>` 说明行 → 行子节点数由 3 降为 2
- **关系类型不进 hover**：用户明确不要看到 `many_to_one` 一类，故 `relationRowTitle` 不拼
  `relationshipType`（已有断言钉住）；类型原值仍只在 `node.data` / sidecar 里
- **导出 HTML 不改**：静态交付物没有 hover，`tableRelationsBlock` 的「说明」列照旧直接呈现（否则说明在
  报告里彻底丢失）——画布与导出这一处的不对称是有意的，记入遗留 1

## 4. 测试与断言策略

原则：**反向断言替代正向断言，总数只增不减**（不许为了变绿删断言）。

| 文件 | 改动 |
|---|---|
| `tests/integration/table-relations-ui.test.ts` | label 期望 4 处去掉类型前缀；新增「首条缺列时取次条」与「label 不含 many_to_one」断言；「② 方向建边」用例改为断言 `label` 键不存在（`"label" in edges[0] === false`）+ 类型原值仍在 `edge.data`；`candidates[0].relations?.[0].relationshipType === "one_to_many"` 一类**数据留痕断言原样保留**。**X15.1 另新增 1 个用例**（193 → 194 例）钉 `relationRowTitle`：三段全文拼接、无 description 时不带「说明：」、只有类型无列时只剩目标表行且**不含类型原值**、单侧列缺失、空白 description 不算有说明 |
| `tests/ui/source-table-node.test.tsx` | 「3 个 many_to_one 徽标」→ `queryByText("many_to_one")` 为 null + `document.body.textContent` 不含该串；降级用例补 `queryByText("foreign_key")` 为 null（降级路径的类型值同样不得泄漏到 UI）。**X15.1 改写 2 处**：① 星型用例的 `getByTitle("关系目标表：…")` 改为正则匹配行级 hover，并断言 title 含「字段关联：」、不含「说明：」与类型原值；② 原「description 渲染说明行」用例改为「**不占行、只在 hover title 里**」：`queryByText("事实表产品外键")` 为 null、`body.textContent` 不含该串、行子节点 3 → 2、`title` 含「说明：事实表产品外键」 |
| `scripts/verify-export-report.ts` | 关系小节断言去掉 `includes("many_to_one")`；**新增 1 项**断言：导出全文不含 `<th>关系类型</th>`、不含 `many_to_one`、不含 `foreign_key`；边 `<title>` 断言改为 `rel-1 → rel-2 · customer_id → id` 且不含类型 |

`tests/integration/table-relations.test.ts`（server 侧 27 例）、`canvas-store.test.ts`（X10 星型/去重）、
`tests/integration/layout.test.ts`（方案B）**未修改即通过** → 取数层、建边语义、排版零回归。

## 5. 验证结果

见 `verification.md`。摘要：`build`/`lint`/`verify` 全 exit 0；脚本断言 **623 → 624**（+1，新增导出
反向断言）；vitest **15 文件 / 193 → 194 例**（X15.1 新增 `relationRowTitle` 用例）、UI **4 文件 / 31 例**
（例数持平，断言内容按新语义改写）；verify 全跑后除本任务改动外工作树干净。

## 6. 遗留问题

1. **已裁决（X15.1）：`description` 保留，但画布上改为 hover 按需查看**（用户 2026-11-13：「hover 显示
   description 先保留」）。残留的不对称：**导出 HTML 仍把说明当一列直接呈现**（静态交付物无 hover，
   若也收掉则说明在报告里彻底丢失）。若产品要求两边一致，两个方向二选一：导出也去掉说明列（信息丢失），
   或画布恢复可见行（回到 X13 形态）。**待产品裁决**。
2. **类型信息的可发现性仍归零**：用户只要求把 `description` 放 hover，**未要求把类型放 hover**，故
   `relationRowTitle` 不拼 `relationshipType`（已有断言钉住）。想知道基数关系仍只能查图谱
   （`govio-cli query`）或读 sidecar；若将来要「按需查看」，在 `relationRowTitle` 里加一行即可（已有唯一
   取值来源，改动面极小），不必恢复徽标。
3. **`+N` 语义在混合缺列时略有歧义**：`+N` 按关系总条数算，而摘要取的是「第一条有列映射的关系」，
   极端情况（首条无列、后两条有列）下 label 显示的是第二条的列映射 + `+2`。属可接受近似；若要精确，
   需改成 `+N` 只数「其余有列映射的」，会让 label 与节点内条数不一致，故未做。
4. **X13 的两条产品裁决仍未解**（不因本任务变化）：边上只显示**首条**关系摘要（要全量需自定义 edge
   组件，须先解 `verify-semantic-lineage` 的 `edge.type` 断言与 `withSemanticHandles` 幂等）；
   dim 侧无入向关系视图（`tableRelations` 本身是出向）。
5. **`TABLE_RELATIONS_HINT_COLOR` 与 `CALIBER_WARNING_COLOR` 同值分处两模块**（X13 验收时记的 P2）：
   本任务未合并这两个常量（属独立重构，范围纪律不顺带做）。
   > **已裁决（2026-11-14 用户）：保持分开设定，不抽共享 token、不再排期。**理由：两者是
   > **不同语义的提示信息**（表间关系来源/降级留痕 vs 口径冲突警示），当前同用 green-deck
   > warning 黄只是配色巧合，将来任一方调色不应牽连另一方。两个常量各自仍是其所在展示
   > 领域的唯一取值来源（符合纪律），此项关闭。
