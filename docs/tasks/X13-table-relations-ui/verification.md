# X13 验证记录（verification）

> 环境：Windows PowerShell + Orca worktree `C:/Users/Administrator/orca/workspaces/govio-map/x13-table-relations-ui`，
> 分支 `chenxinma/x13-table-relations-ui`（基点 commit `2839b68`）。`npm ci` 后 `node_modules` 就绪。
> 基线（主会话 2026-11-12 实测于 `ac8bab1`）：脚本断言 612 项 0 失败、`verify:integration` 14 文件 155 例、
> `verify:ui` 4 文件 21 例、`npm run verify` ≈94s。
> 备注：本地跑 `npm` 时用 `node node_modules/<pkg>/...` 直调等价命令（`npx` 被脚本策略挡住）；
> tsx 类脚本在沙箱内 `ENOMEM`，需放行执行——结果与 `npm run verify` 完全一致。

## 1. 验证门槛（三项全绿）

| 门槛 | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| build | `npm run build` | **0** | `tsc -b` 无错误；`✓ built in 12.41s`；`compile:server` -> `dist-server\cli.mjs 159.4kb` |
| lint | `npm run lint` | **0** | `> eslint .` 零输出（0 error 0 warning；中途曾出现 1 error：新测试文件 `afterEach` 导入未用，已删） |
| verify | `npm run verify` | **0** | 9 个专项脚本全 PASS + `Test Files 15 passed (15) / Tests 193 passed (193)` + UI `4 passed (4) / 31 passed (31)`；末次实测 **≈57s**（lint+build+verify 三段合计 84.6s；基线单 verify 94s，差异是机器负载，非改动导致） |

verify 全跑后 `git status --porcelain` 只含本任务预期改动，无脚本产物残留：

```
 M docs/demo/video-script-chocolate.md
 M docs/specs/01-canvas.md
 M docs/specs/02-nodes.md
 M docs/specs/05-store.md
 M docs/specs/06-backend.md
 M scripts/verify-export-report.ts
 M src/components/Nodes/SourceTableNode.tsx
 M src/store/canvas-store.ts
 M src/utils/export-report.ts
 M src/utils/table-relations.ts
 M tests/ui/source-table-node.test.tsx
?? src/utils/table-relations-ui.ts
?? tests/integration/table-relations-ui.test.ts
（+ 三件套 docs/tasks/X13-table-relations-ui/）
```

## 2. 断言数前后对比（零回归 + 新增）

| 脚本 | 基线 | 本次 | 说明 |
|---|---|---|---|
| verify-manifest-roundtrip | 92 | 92 | 未触碰 |
| verify-rerun-drift | 71 | 71 | 未触碰 |
| verify-permission-audit | 119 | 119 | 未触碰 |
| **verify-export-report** | **126** | **137** | 新增 11 项（`[3]` 6 项关系小节/来源/降级/单侧映射/转义/正常态不打扰 + `[3b]` 5 项 `LineageEdgeView`/边悬停 title/数据边 title 不变/线型图例泛化/自包含）；既有 126 项一字未削 |
| verify-source-table | 39 | 39 | 未触碰 |
| **verify-semantic-lineage** | **48** | **48** | `lineageKind` / 两个语义 Handle / `type` / 数据边无 Handle / `lineageKindOf` 回退 / 边 data sidecar 往返全绿（**edge.data 扩展未破任何一条**） |
| verify-caliber-conflict | 46 | 46 | 未触碰 |
| verify-cwd-normalize | 13 | 13 | 未触碰 |
| verify-prompt-injection | 58 | 58 | 未触碰 |
| **合计** | **612** | **623** | 0 失败 |

vitest：

| 门槛 | 基线 | 本次 | 增量 |
|---|---|---|---|
| `verify:integration`（全量） | 14 文件 / 155 例 | **15 文件 / 193 例** | +1 文件（`table-relations-ui.test.ts` 28 例）、+10 UI 例 |
| `verify:ui` | 4 文件 / 21 例 | **4 文件 / 31 例** | +10 例（SourceTableNode 表间关系出口） |
| 两个新测试文件单独跑 | — | 2 文件 / **44 例** 全绿 | `vitest run tests/integration/table-relations-ui.test.ts tests/ui/source-table-node.test.tsx` |

其它零回归：`tests/integration/layout.test.ts`（方案B 同列纵向堆叠）、`tests/integration/table-relations.test.ts`
（X10 server 侧 27 例）、`tests/integration/canvas-store.test.ts` 全部原样通过（未被本次改动触及）。

## 3. 星型模型链路（自动化全链路，fake runner）

数据形状取 X10 的 live 实测原值（`chocolate.chocolate.fact_sales` -> `dim_channel`/`dim_country`/`dim_product`，
`many_to_one`，列映射同名，无 `description`）：

- `tests/integration/table-relations-ui.test.ts`：`tableSemanticEdgeCandidates` 三条候选各带 1 条关系原文 ->
  `createGovioNode` 建出 3 条语义边，每条 `edge.data.tableRelations` 非空且 `edge.label` 形如
  `many_to_one · product_id → product_id`；同一节点对多条关系（复合外键）合并成一条边、relations 为 2；
  既有语义边覆盖的节点对不再产出（恢复不重复建边）；sidecar `saveCanvas -> loadCanvas` 边深比较无损，
  `hydrateSession` 后仍 3 条边。
- `tests/ui/source-table-node.test.tsx`：3 条关系在 `fact_sales` 节点内逐条可见（裸表名 + `many_to_one`
  徽标 + `product_id → product_id`）；`description` 存在时多一行、缺失时行数不变（不出现空行/`undefined`）；
  无 `tableRelations` 时整节不存在；4 条时默认 3 条 + 「+1 more relations」可展开/收起。
- `scripts/verify-export-report.ts`：导出 HTML 含 `表间关系（2）` 小节（三段式全名 / `many_to_one` /
  `customer_id → id` / `created_at → date_key`）与语义边 `<title>rel-1 → rel-2 · many_to_one · customer_id → id</title>`。
- 关键输出：见 §2 表内 `[3]`/`[3b]` 断言清单（`✓` 全绿）。

## 4. live 图谱只读复核（人工执行，非验收必需）

先读 `.agents/skills/govio/assets/schema.md`（`RELATES_TO` 属性 = `relationship_type` / `description` /
`source_columns` / `target_columns`，`PhysicalTable.full_table_name`），只读查询：

```
govio-cli query -c "MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) RETURN a.full_table_name AS src,
  r.relationship_type AS rel, r.source_columns AS src_cols, r.target_columns AS tgt_cols,
  r.description AS descr, b.full_table_name AS tgt LIMIT 10"
```

`Result output: .govio\output-*.json rows: 3 columns: ["src","rel","src_cols","tgt_cols","descr","tgt"]`

```json
[{"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"channel_id","tgt_cols":"channel_id","descr":"事实表渠道外键：每条销售订单归属一个销售渠道","tgt":"chocolate.chocolate.dim_channel"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"country_id","tgt_cols":"country_id","descr":"事实表国家外键：每条销售订单归属一个国家","tgt":"chocolate.chocolate.dim_country"},
 {"src":"chocolate.chocolate.fact_sales","rel":"many_to_one","src_cols":"product_id","tgt_cols":"product_id","descr":"事实表产品外键：每条销售订单归属一个产品","tgt":"chocolate.chocolate.dim_product"}]
```

结论：3 行关系与 X10 定稿形状一致（列仍是字符串形状，server 侧 `parseColumnList` 已容错，到前端为 `string[]`）；
**与 X10 记录不同：`description` 现在实测有值**（X10 当时常缺失）——UI 两种形态都覆盖（有则渲染说明行、
无则整行省略），差异记入 design.md §8 遗留③。未执行任何写图/清图命令（`meta graph` 一类）。

## 5. 降级留痕验证（注入方式与断言）

| 注入形态 | 注入点 | 期望 | 断言位置 |
|---|---|---|---|
| `fields` + `error`（ENOENT，图谱挂了仍有字段级关系） | 导出 fixture `CUSTOMERS`：`tableRelationsSource:'fields'` + `tableRelationsError:'spawn govio-cli ENOENT'` | 卡片出现 `关系来源 = 字段级外键` + warn 框全文「关系来源：字段级外键（图谱查询失败：spawn govio-cli ENOENT）」 | `verify-export-report [3]` |
| `fields` 无 error（图谱没记录该表关系） | `tableRelationsHint` 单测 + UI 用例 | 徽标「字段级关系」+「图谱未记录该表关系」；节点出现提示行 | `table-relations-ui.test.ts`、`source-table-node.test.tsx` |
| 仅 `error`（图谱挂了且一条关系都没拿到） | UI 用例 + 单测 | 徽标「图谱降级」+ 原因，且关系小节仍不渲染（不出现空壳） | 同上 |
| 原因过长（>60 字） | 单测 + UI 用例 | 展示行截断加 `…`，`title`/导出保留 `detailFull` 全文 | 同上 |
| 超时 / `Binder exception` 类原因 | 与 ENOENT 同路径（原因只是字符串透传，server 侧已定稿） | 同「仅 error」形态 | 单测以任意原因字符串覆盖 |
| **正常态**（`source='graph'`，无 error） | 单测 + UI 用例 + 导出 fixture `ORDERS` | `showHint=false`、文案字段全 `null`、节点无提示行、导出卡片**不出现** warn 框（只有「关系来源 图谱 RELATES_TO」info 行） | `verify-export-report [3]`「不打扰」项 + 单测/UI 用例 |
| 无关系 + 无留痕（旧节点） | 单测 + UI 用例 | 全静默：小节与提示都不渲染 | 同上 |

## 6. 兼容与持久化

- `PROTOCOL_VERSION` 未改、`ws-protocol.ts` 未动：边新增 `data.tableRelations` / `label` 走
  `canvas_save`/`canvas_restore` 的 `Type.Array(Type.Unknown())` 透传（已由断言验证往返）。
- 旧边（只有 `lineageKind`）恢复：不建 `data` 新键、`label` 为空、不报错（集成用例）。
- 旧节点（无三键）：关系小节与提示都不渲染，PK/FK 徽标与四 Handle 形状不变（UI 用例断言 Handle 仍 4 个）。
- sqlQuery 口径沿袭语义边：不带 `tableRelations`、不带 `label`（集成用例），避免与表间关系混淆。

## 7. 人工目视清单（jsdom 无布局引擎，测不出来 —— X12 遗留①）

请在 dev server（`npm run dev`）上把星型 4 表落画布后确认：

1. 紫虚线中点的 label 摘要（`many_to_one · product_id → product_id`）在默认缩放下是否清晰、是否与线重叠；
   多关系时的 `+N` 是否可理解。
2. 关系小节带来的节点高度增长对方案B「同列纵向堆叠」间距/对齐的观感（源在上、目标在下，线走节点间隙）。
3. 警示行（`#F59B23` 徽标 + 10% 底色 + 11px 文案）在浅色 Green Deck 上的对比度与「不打扰」观感。
4. `description` 长文案（live 实测 20+ 字）单行 truncate + hover `title` 是否够用，是否需要换行。
5. 折叠交互（「+N more relations」/「Collapse」）点击区域与字段区折叠是否视觉一致、不误触节点选中拖拽。
6. 导出 HTML：关系表格列宽与 `.scroll` 容器在长表名下的表现；血缘 SVG 悬停 `<title>` 在浏览器里的可见性。
7. 无关系/无降级的普通表节点：确认画布上没有任何新增视觉噪声（本任务的「不打扰」承诺）。