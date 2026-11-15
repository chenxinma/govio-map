# X15 验证记录

验证人：主会话（实现者本人，单写者）。环境：Windows Git Bash，node v24.16.0 / npm 11.18.0，
分支 `chenxinma/x15-relation-columns-only`（base = main `08a2f68`），PR #34 内**两个 commit**：
`94ea04d`（X15：去掉关系类型显示）+ X15.1（用户裁决：`description` 改为 hover 显示）。
基线口径：合并态 main `ab42d46`（X13+X14 已合入）——脚本 623 项、vitest 15 文件 193 例、UI 4 文件 31 例。

## 1. 门槛（全绿）

```bash
npm run build    # exit 0 → tsc -b 通过、vite ✓ built、dist-server/cli.mjs 159.4kb
npm run lint     # exit 0 → eslint . 零输出
npm run verify   # exit 0 → 11 个子脚本全绿
git status --porcelain   # 只剩本任务改动的 10 个文件，无产物残留
```

verify 关键输出（逐项与基线对照）：

| 子脚本 | 基线（main ab42d46） | 本任务 | 差值 |
|---|---|---|---|
| `verify:manifest` | 92 | 92 | 0 |
| `verify:rerun` | 71 | 71 | 0 |
| `verify:audit` | 119 | 119 | 0 |
| `verify:export` | 137 | **138** | **+1**（新增「导出全文不含 `<th>关系类型</th>` / `many_to_one` / `foreign_key`」反向断言） |
| `verify:source-table` | 39 | 39 | 0 |
| `verify:semantic-lineage` | 48 | **48** | 0 ← 边形状/`edge.type`/SEMANTIC_* Handle/边 data 随 sidecar 往返**零回归**（本任务未改 `lineage.ts`） |
| `verify:caliber-conflict` | 46/46 | 46/46 | 0 |
| `verify:cwd` | 13 | 13 | 0 |
| `verify:prompt-injection` | 58/58 | 58/58 | 0 |
| **脚本合计** | **623** | **624** | **+1，无删减** |
| `verify:integration`（`vitest run`） | 15 文件 / 193 例 | 15 文件 / **194 例** | **+1**（X15.1 新增 `relationRowTitle` 用例）；X15 本身例数持平（4 个用例期望值按新语义改写，并在既有用例内新增 5 条数据留痕断言） |
| `verify:ui`（`vitest run tests/ui`） | 4 文件 / 21→31 例 | 4 文件 / **31 例** | 例数持平（X15：2 处断言由正向改反向 + 1 条 `foreign_key` 不泄漏；X15.1：星型用例的 hover 断言改为行级 title，原「description 渲染说明行」用例改为「不占行、只在 hover」） |

> 断言总数 **623 → 624**、vitest **193 → 194 例**，符合 acceptance「调整后总数不得低于基线（反向断言替代正向断言）」。

## 2. 需求达成的正向证据（画布 / 导出不再出现关系类型）

三条互相独立的机器断言，覆盖三处出口：

1. **节点内小节**（`tests/ui/source-table-node.test.tsx`，jsdom 渲染真实组件）
   - 星型 3 条关系：`queryByText("many_to_one")` 为 `null`，且 `document.body.textContent` 不含 `many_to_one`
   - 字段级降级（`relationshipType: "foreign_key"`）：`queryByText("foreign_key")` 为 `null`，
     同时「字段级关系」来源提示与原因仍可见（降级留痕未被误删）
   - 列映射照常：`product_id → product_id`、`channel_id → channel_id`、单侧缺失只渲染存在侧
2. **语义边 label**（`tests/integration/table-relations-ui.test.ts`，直驱 `canvas-store`）
   - 星型三条边 label 排序后恰为 `["channel_id → channel_id","country_id → country_id","product_id → product_id"]`
   - 每条边 `e.label` 不含 `many_to_one`，而 `edge.data.tableRelations[0].relationshipType === "many_to_one"`
     → **展示去掉、数据留痕保留**
   - 零回归：`e.type/animated/style/sourceHandle/targetHandle` 仍全等于 `lineageEdgeAppearance("semantic")` 派生值
3. **导出 HTML**（`scripts/verify-export-report.ts`，纯函数产出全文后断言）
   - 全文不含 `<th>关系类型</th>`、不含 `many_to_one`、不含 `foreign_key`
   - 关系小节仍含 `表间关系（2）`、`sales.warehouse.dim_date`、`customer_id → id`、`created_at → date_key`
   - 边悬停 `<title>rel-1 → rel-2 · customer_id → id</title>`（原为 `… · many_to_one · customer_id → id`）
   - 自包含不回归：无 `<script`、无外部引用；边线型/箭头/图例仍按 `lineageKind` 泛化

4. **行 hover 全文（X15.1）**——`relationRowTitle()` 纯函数用例 + jsdom 组件用例双重钉住：
   - 纯函数：三段逐字相等（`关系目标表：…\n字段关联：…\n说明：…`）；无 description 时不带「说明：」；
     **只有类型、没有列信息**时只剩目标表行且不含 `one_to_many`（类型不进 hover）；单侧列缺失只带存在侧；
     空白 description（`"   "`）不算有说明
   - 组件：关系行 `title` 含「字段关联：product_id → product_id」、不含「说明：」与 `many_to_one`；
     带 description 时 `queryByText("事实表产品外键")` 为 **null**、`body.textContent` 不含该串（已不占可见行），
     而行 `title` 含「说明：事实表产品外键」（按需可查）；行子节点由 3 降为 2

## 3. 行为差异清单（对外可见变化，共 5 条）

| # | 变化 | 说明 |
|---|---|---|
| 1 | 节点关系行不再有紫色类型徽标 | 行内容变为「目标表裸名」+「列映射」(+「说明」若有)；**DOM 层级未变**，故按 `children.length` 断言结构的既有用例（3/2/1 三种）无需修改即通过 |
| 2 | 边 label 由 `many_to_one · product_id → product_id` 变为 `product_id → product_id` | 多条仍附 `+N` |
| 3 | **只有类型、没有任何列信息**的关系：边**不再有 label**（旧行为是拿类型当 label） | 边照旧连、`edge.data.tableRelations` 照旧带原文；`label` 键直接不建（`"label" in edge === false`），不出现空 label |
| 4 | 导出关系表由四列（目标表/关系类型/列映射/说明）变三列（目标表/列映射/说明） | 表头与单元格同步删除，`badge()` 辅助函数保留供其它段落使用 |
| 5 | **X15.1**：图谱 `description` 不再占可见行，改为关系行 hover `title` 的第三段 | 行子节点 3 → 2（节点更矮）；hover 全文 = `关系目标表：<全限定名>` / `字段关联：<列映射>` / `说明：<description>`（缺项自动省略）；目标表 `<span>` 上原本的局部 title 已删（避免嵌套 title 遮蔽）；**导出 HTML 保留「说明」列**（静态交付物无 hover） |

不变项（已断言）：`node.data.tableRelations[].relationshipType` 与 `edge.data.tableRelations` 仍随
canvas sidecar 往返无损；`hydrateSession` 恢复不重复建边；旧边（只有 `lineageKind`）兼容且无 label；
`sqlQuery` 口径沿袭语义边形状不变、无 label；方案B 排版与 Handle 朝向不变。

## 4. 人工目视项（jsdom 无布局引擎，测不出来 → 需真实画布确认）

1. 关系行少一个徽标、且 `description` 不再占行后的**行高/对齐**：节点明显变矮（每条关系由最多 3 行降为最多 2 行），方案B「语义同伴同列纵向堆叠」的间距是否仍舒服
2. 边 label 变短后在**低缩放**下的可读性（原来 `many_to_one · product_id → product_id` 偏长，现在短一半）
3. 导出 HTML 关系表**少一列后的列宽分配**（`目标表` 现在是 `<code>` 全限定名，可能偏宽）
4. **X15.1 新增：hover 体验**——多行 `title`（目标表 / 字段关联 / 说明）在浏览器里的换行与可读性、hover 延迟是否可接受（原生 title 约 1s 才出，且移动端/触屏无 hover → 说明在画布上对触屏用户实际不可见，若在意需改为点击弹层）
5. 只剩列映射时，用户能否理解「这条边就是这两列的关联」——若不能，见 design.md 遗留 2（把类型也加进 `relationRowTitle` 只需一行）

## 5. 复跑方式

```bash
cd /d/Work/gov-io/govio-map           # 或本分支的 worktree
npm run build && npm run lint && npm run verify
git status --porcelain                # 预期：无产物残留

# 只跑与本任务直接相关的三处
npx vitest run tests/integration/table-relations-ui.test.ts tests/ui/source-table-node.test.tsx
npm run verify:export                 # 预期 共 138 项断言，失败 0 项
npm run verify:semantic-lineage       # 预期 共 48 项断言，失败 0 项（零回归门槛）

# 反向验证（**已实测**）：把关系类型拼回 label 应当让新断言变红
#   在 src/utils/table-relations-ui.ts 的 relationEdgeLabel 里把 relationshipType 拼回 summary 后：
#     npx vitest run tests/integration/table-relations-ui.test.ts
#     → Test Files 1 failed / Tests 4 failed | 24 passed (28)，红的正是 4 个 label 相关用例：
#       「边 label 摘要 = 列映射（X15…）」「同一对节点被多条关系命中…」「语义边携带关系原文与 label…」
#       「边上关系的列映射可与节点数据对上…」
#   还原后 git diff 与验证前一致（已确认）→ 新断言真能抓住回退，不是空转
# 反向验证 2（X15.1，**已实测**）：把 description 行加回组件应当让新断言变红
#   在 SourceTableNode.tsx 的关系行里恢复 `{rel.description && <div …>{rel.description}</div>}` 后：
#     npx vitest run tests/ui/source-table-node.test.tsx
#     → Test Files 1 failed / Tests 1 failed | 15 passed (16)，红的正是
#       「description 不占行、只在 hover title 里（X15.1）；缺失时 title 不带说明段」
#   还原后两个测试文件重跑 → 2 passed / 45 passed（已确认）
# 另两处同理可验（未实测，断言为全文不含型，回退必红）：
#   在 SourceTableNode.tsx 恢复类型徽标 → tests/ui 的 queryByText("many_to_one") 断言红
#   在 export-report.ts 恢复类型列 → npm run verify:export 的「不含关系类型」断言红
```

## 6. 未做（范围纪律）

- 未改 `server/table-relations.ts`、`src/utils/table-relations.ts`（匹配/去重语义）、`src/utils/lineage.ts`
  （APPEARANCE / 工厂 / Handle）、`src/utils/layout.ts`（方案B）、`src/types/index.ts`（`TableRelation` 形状）、
  `PROTOCOL_VERSION` 与 WS 协议 schema
- 未引入任何依赖；未改 `package.json` / `package-lock.json`；未改 `docs/task-plan.json`（记账在 main 上做）
- 未顺带处理 design.md 遗留 4/5（X13 的两条产品裁决、警示色常量合并）——属独立议题
