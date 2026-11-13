# X15 验证记录

验证人：主会话（实现者本人，单写者）。环境：Windows Git Bash，node v24.16.0 / npm 11.18.0，
分支 `chenxinma/x15-relation-columns-only`（base = main `08a2f68`）。
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
| `verify:integration`（`vitest run`） | 15 文件 / 193 例 | 15 文件 / **193 例** | 例数持平（4 个用例的期望值按新语义改写，另在既有用例内**新增** 5 条断言：label 不含类型、首条缺列取次条、`label` 键不存在、`edge.data` 类型原值仍在、星型建边类型原值仍在） |
| `verify:ui`（`vitest run tests/ui`） | 4 文件 / 21→31 例 | 4 文件 / **31 例** | 例数持平（2 处断言由正向改反向 + 1 条 `foreign_key` 不泄漏断言） |

> 断言总数 **623 → 624**，符合 acceptance「调整后总数不得低于基线（反向断言替代正向断言）」。

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

## 3. 行为差异清单（对外可见变化，共 4 条）

| # | 变化 | 说明 |
|---|---|---|
| 1 | 节点关系行不再有紫色类型徽标 | 行内容变为「目标表裸名」+「列映射」(+「说明」若有)；**DOM 层级未变**，故按 `children.length` 断言结构的既有用例（3/2/1 三种）无需修改即通过 |
| 2 | 边 label 由 `many_to_one · product_id → product_id` 变为 `product_id → product_id` | 多条仍附 `+N` |
| 3 | **只有类型、没有任何列信息**的关系：边**不再有 label**（旧行为是拿类型当 label） | 边照旧连、`edge.data.tableRelations` 照旧带原文；`label` 键直接不建（`"label" in edge === false`），不出现空 label |
| 4 | 导出关系表由四列（目标表/关系类型/列映射/说明）变三列（目标表/列映射/说明） | 表头与单元格同步删除，`badge()` 辅助函数保留供其它段落使用 |

不变项（已断言）：`node.data.tableRelations[].relationshipType` 与 `edge.data.tableRelations` 仍随
canvas sidecar 往返无损；`hydrateSession` 恢复不重复建边；旧边（只有 `lineageKind`）兼容且无 label；
`sqlQuery` 口径沿袭语义边形状不变、无 label；方案B 排版与 Handle 朝向不变。

## 4. 人工目视项（jsdom 无布局引擎，测不出来 → 需真实画布确认）

1. 关系行少一个徽标后的**行高/对齐**：节点变矮，方案B「语义同伴同列纵向堆叠」的间距是否仍舒服
2. 边 label 变短后在**低缩放**下的可读性（原来 `many_to_one · product_id → product_id` 偏长，现在短一半）
3. 导出 HTML 关系表**少一列后的列宽分配**（`目标表` 现在是 `<code>` 全限定名，可能偏宽）
4. 只剩列映射时，用户能否理解「这条边就是这两列的关联」——若不能，见 design.md 遗留 2（hover `title` 方案）

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
