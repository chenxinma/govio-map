# X18 · SQL 节点卡片渲染 semanticRefs 徽标（PD-1 方案 1）— design.md

> 计划事实源：`docs/task-plan.json → crossCutting[X18]`（note/scope/acceptance 即验收契约）
> 议题原文：`docs/PENDING-DISCUSSION.md → PD-1`（用户裁决 2026-11-14：选**方案 1 最小档**）
> 任务书：`docs/tasks/X18-sql-node-semantic-badges/DISPATCH.md`

## 1. 目标与边界

**目标**：T2.2 起 sqlQuery 节点已携带 `semanticRefs`（本次生成注入的图谱 Metric / Dimension / Col），
但引用的指标只存在于节点属性里，**画布上不可见**（T2.2 design.md 遗留 3、PD-1 记录 2026-11-06）。
本任务在 SQL 节点卡片上渲染「口径」徽标区，让引用的图谱指标 / 维度直接可见。

**明确不做**（PD-1 方案 2/3 + 任务书范围纪律）：

- 不新增节点类型（方案 3）、不做语义边悬停显示共用指标（方案 2）
- 不改边语义与 `src/utils/lineage.ts`、不改 `PROTOCOL_VERSION`、不引入新依赖
- 不做点击弹层 / 详情面板（触屏局限按 X15.1 同款处理，属已知取舍）
- 不写死色值（一律 green-deck token class），不新增第二套徽标样式
- 不改 `docs/task-plan.json`（并行模式下由主会话统一记账）

## 2. 结构：展示模型下沉为纯函数（唯一取值来源）

新增 `src/utils/semantic-refs-ui.ts`，沿袭 `src/utils/caliber.ts`（T2.3）与
`src/utils/table-relations-ui.ts`（X13/X15）的既有纪律：**判定、文案、排序集中在纯函数里，
组件与导出只消费返回值**。这样画布与导出 HTML 不会各写一套过滤/排序而漂移，且能在 node 环境直接单测。

| 出口 | 作用 |
|---|---|
| `MAX_VISIBLE_SEMANTIC_REFS = 3` | 徽标区默认可见条数（折叠基准） |
| `SEMANTIC_ENTITY_TYPE_LABELS` | Metric→指标 / Dimension→维度 / Col→字段标准 |
| `semanticRefTypeLabel(entityType)` | 类型展示名，未知取值回落原值（同 `CALIBER_ASPECT_LABELS` 兜底） |
| `semanticRefLabel(ref)` | 徽标短名 = `code ?? name`（去空白；都缺 → `null`，调用方跳过该条） |
| `semanticRefTitle(ref)` | hover 全文：类型 / 编码 / 名称 / 图谱 ID（多行，缺项省略） |
| `semanticRefBadges(refs)` | 脏元素过滤 → `entityType:id` 去重 → 丢无短名 → Metric 优先稳定排序；空/非数组入参 → `[]` |

`semanticRefBadges` 返回的徽标同时携带 `code` / `name` / `id` / `typeLabel`，导出 HTML 的「口径引用」表
直接复用同一份结果，不再二次解析 refs（去重与跳过规则只有一处实现）。

**处理链**（`semanticRefBadges`）：

1. 非数组 / `undefined` / `null` → `[]`（调用方整节不渲染）
2. 逐条：非对象脏元素跳过 → `semanticRefLabel` 为 `null`（code/name 都缺或纯空白）跳过
3. 去重：`entityType:id` 已有则丢弃（与 `canvas-store` 建语义边的 key 同口径）；
   `id` 缺失/空白时**不参与去重**，key 回落 `entityType:label#序号` 保证 React key 唯一
4. 排序：Metric(0) < Dimension(1) < Col(2) < 未知(99)，`Array.prototype.sort` 稳定 → 同类型保持注入原序
5. `text`：指标只给短名；非指标前缀类型名（`维度·country`），避免把维度读成指标

## 3. 关键取舍

### 3.1 N = 3 + 折叠范式（沿用关系小节，不发明第二套交互）

字段区（前 6 条 + `+N more fields`）与表间关系小节（`MAX_VISIBLE_TABLE_RELATIONS = 3` +
`+N more relations`）已确立「默认截断 + 展开 / Collapse」的范式，徽标区照抄：N = 3、
按钮文案 `+N more refs` / `Collapse`、图标同款 `ChevronDown` / `ChevronUp`、剩余数按上限固定计算
（展开后仍能收起）。300px 宽的卡片里 3 条徽标约占一到两行，再多就会把卡片推高、挤压画布密度。

### 3.2 Dimension / Col 是否同排展示

**同排**，但用排序 + 前缀控制噪声：

- **Metric 永远排最前**，占据默认可见的 3 个位置——PD-1 的诉求就是「指标可见」；
- **Dimension 同排但前缀类型名**（`维度·country`）：维度能解释「这个口径是在什么维度上算的」，
  但必须一眼看出它不是指标，否则 `country` 会被读成指标名。用文本前缀而非第二种配色/样式，
  符合「不新增第二套徽标样式」；
- **Col（字段标准）在实践中天然不产徽标**：图谱 Col 查询只返回 `column_name` / `data_type`
  （`server/prompt-injection.ts` 的 `queryTableColumns`），`entityFromRow` 取不到 `code` / `name`，
  `toSemanticRefs` 因此不写这两个键 → 被「无短名整条跳过」规则过滤。这正好符合「列级实体不该占
  画布密度」的直觉（一次注入最多 40×表数条 Col），无需为 Col 单开特例。
  `scripts/verify-semantic-lineage.ts` 的 `REFS`（`[{Metric m1 gmv 销售额}, {Col c1}]`）就是这一真实形态，
  新增断言直接钉住「Col 不产徽标」。

### 3.3 短名取 `code` 优先（契约 + 用户裁决：暂时保留 code）

按 X18 scope 的硬规则实现 `code ?? name`。实际效果需要点明：chocolate 图谱里指标 code 形如
`m_sales_amount`，所以画布徽标显示的是 **code**（`m_sales_amount`），而 PD-1 记录举的例子是中文名
「销售额」；中文名在 hover 的 `名称：` 行与导出表的「名称」列里。若产品上更希望画布直接显示中文名，
只需把 `semanticRefLabel` 的优先级换成 `name ?? code`（一处、纯函数、画布与导出同时生效）。
本任务**不擅自改契约**，按 scope 实现并把选择权交给用户。

**用户裁决（2026-11-14，派发后追问）：「暂时不用中文显示，保留 code」**——维持 `code ?? name`，
本任务不改。裁决同时记入 `semanticRefLabel` 的 docblock、PD-1 与本文件遗留 1（已关闭），
避免后来者把它当未定项"顺手"改掉。中文名在 hover 与导出表里仍可见，追溯链没有变短。

### 3.4 与 T2.3 口径警示的视觉分工（警示优先）

- 警示**永远在标题行**（卡片第一行右上角），配色与文案仍**只**由 `caliberNodeAppearance`
  （`src/utils/caliber.ts`）给出；徽标区不读 `CALIBER_WARNING_COLOR`、不带任何内联 `style`。
- 徽标区**独立成行**（`border-t` 分隔，位于 SQL 正文与「输出列」之间），与标题行的警示徽标在 DOM 上
  不相邻、不重叠 → 冲突态下互不遮挡。UI 用例用 `compareDocumentPosition` 钉住「警示在前、徽标区在后」
  的文档顺序，并断言徽标 `getAttribute("style") === null`（不借警示色、不写死色值）。
- 徽标用紫色 token，**警示黄保持唯一语义**：画布上出现黄色 = 口径冲突，不会被徽标稀释。
- 口径差异展开区（`showCaliber`）与徽标区是两个独立的条件块，互不影响展开状态。

### 3.5 为什么是紫色 token（`bg-node-source/10 text-node-source`）

`--color-node-source`（`hsl(270, 60%, 60%)`）与语义血缘边（`lineage.ts` 的 `semantic`：
`hsl(270, 60%, 55%)` 紫虚线）同色系。口径徽标 = 语义层信息 = 紫虚线的成因，同色让「这几个 SQL
为什么被紫虚线连起来」在卡片内自解释。它同时是既有 token class（sourceTable 的 FK 徽标、
数据源类型徽标同款），符合「不写死新色值、不新增第二套徽标样式」。绿色（`bg-node-sql/10`）
继续留给 SQL 节点自身产物「输出列」，两节相邻也不混淆。

### 3.6 hover 信息量（对齐 X15.1「画布轻、详情按需」）与触屏局限

画布上只留短名，完整信息进 `title`（多行，浏览器原生按 `\n` 换行）：

```
类型：指标
编码：m_sales_amount
名称：销售额
图谱 ID：m_sales_amount
```

缺项自动省略、绝不出现 `undefined` 或空行。与 X15.1 把关系 `description` 收进 hover 是同一取舍。
**触屏无 hover → 完整信息不可见**，属已知取舍（PD-1 方案 1 的最小档定位），不做点击弹层。
导出 HTML 无 hover，故同样信息**直接成列呈现**（与 X15.1 对表间关系「说明」列的处理一致）。

### 3.7 导出 HTML：同步渲染（是）

`src/utils/export-report.ts` 的 `sqlQueryBody` 新增 `semanticRefsBlock()`：「口径引用（N）」表，
列为 类型 / 编码 / 名称 / 图谱 ID，缺失值渲染 `—`；结构复用既有 `label()` + `<div class="scroll">` +
`table()`（与 `tableRelationsBlock` 同款，风格与 Manifest 附录一致），内容全部经 `esc()` 转义。

理由：导出是**交付物**，口径溯源正是「结果可信、口径可溯」的核心证据——画布可见而交付物里缺席
说不过去；成本仅一个纯函数消费点，自包含性质不变（无脚本、无外部引用，`verify:export` 新增断言覆盖）。
无 refs / refs 只有 Col 时整节不渲染，旧节点卡片形状不变。

## 4. 空态与向后兼容

| 场景 | `semanticRefs` | 结果 |
|---|---|---|
| 旧节点（早于 T2.2） | 键不存在 | 整节不渲染 |
| 手动新建的 SQL 节点 | 键不存在 | 整节不渲染 |
| steer / followUp（无注入） | 键不存在 | 整节不渲染 |
| 图谱降级 / 未命中实体 | 键不存在或 `[]` | 整节不渲染 |
| 只注入了 Col（无 code/name） | 有值但全部无短名 | 整节不渲染（不出计数 0 的空壳行） |

节点数据形状**零改动**：不新增字段、不改 `PROTOCOL_VERSION`、不动 sidecar 序列化，
旧画布往返与 hydrate 不受影响（`verify:semantic-lineage` 既有断言零回归）。

## 5. 验证策略

见 `verification.md`。三层：

1. **纯函数**：新增 `tests/integration/semantic-refs-ui.test.ts`（19 例，穷举缺字段 / 脏元素 / 去重 / 排序稳定性 / hover 全文）
2. **组件**：`tests/ui/sql-query-node.test.tsx` 扩 6 例（渲染、hover、code 优先与 name 回退与跳过、无 refs 不渲染、折叠交互、与警示共存）
3. **脚本**：`verify:semantic-lineage` +6（同一份 refs 的展示模型与导出出口）、`verify:export` +9（口径引用表 + 空态 + 转义 + 自包含）

## 6. 遗留问题

1. **（已裁决关闭 2026-11-14）徽标短名 code vs 中文名**：用户裁决「暂时不用中文显示，保留 code」，
   故维持 `code ?? name`（chocolate 图谱下画布显示 `m_sales_amount`，中文名在 hover 与导出表里）。
   裁决已写进 `semanticRefLabel` docblock 与 §3.3，不再作为待确认项；若将来重开，改一处优先级即可
   （画布 + 导出同步生效），并同步 3 条 UI 用例与 2 条脚本断言的期望值。
2. **受跟踪样例 `docs/tasks/T1.4-canvas-export/sample-export.html` 未刷新**：本次改了导出内容，
   但该样例本就早于 X13/X15（不含「字段关联」列），已经陈旧；`verify:export` 默认**不**比对它
   （只有追加 `--write` 才重写）。刷新会产生跨任务目录的大 diff，留给主会话决定是否单独跑一次
   `npm run verify:export -- --write`。
3. **导出 HTML 仍不渲染 T2.3 口径冲突警示**：不对称——现在有「口径引用」表，却没有冲突警示框。
   属 T2.3 既有范围（当时未同步导出），本任务未顺带做。
4. **触屏看不到完整信息**（无 hover）：X15.1 同款已知取舍。若将来要补，最小做法是点徽标就地展开
   一行详情（复用折叠范式），不新建弹层。
5. **Col（字段标准）在画布恒不可见**：因注入行不带 code/name（§3.2）。若将来 `toSemanticRefs` 补
   `columnName`，需要重新决定 Col 是否占徽标位（建议仍不占，或只在展开态显示），否则一次注入
   最多 40×表数条 Col 会淹没指标。
6. **徽标不可点击跳转图谱实体**：应用内没有图谱浏览视图，`图谱 ID` 目前只是 hover / 导出里的追溯线索。
7. **未做浏览器截图**：本 worktree 无显示环境且未装 `govio-cli`，人工目视以「真实渲染 DOM 结构核对 +
   文字描述」形式记入 `verification.md`；建议主会话在 PR 复核时用 `npm run dev` 补一张截图。
