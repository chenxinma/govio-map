# X10 验证记录（verification）

> 环境：Windows Git Bash，worktree `C:/Users/Administrator/orca/workspaces/govio-map/x10-table-semantic-edges`，
> 分支 `chenxinma/x10-table-semantic-edges`（基点 commit `940c2f2`）。
> 基线（主会话实测于 `5bf483f`）：脚本断言 609 项 0 失败、vitest 7 文件 83 例、`npm run verify` 约 36s。

## 1. 验证门槛（三项全绿）

| 门槛 | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| build | `npm run build` | **0** | `tsc -b` 无错误；`✓ built in 13.17s`；`compile:server` → `dist-server\cli.mjs 159.4kb` |
| lint | `npm run lint` | **0** | `> eslint .` 无输出（0 error 0 warning） |
| verify | `npm run verify` | **0** | 9 个专项脚本全 PASS + `Test Files 8 passed (8) / Tests 120 passed (120)`；`real 0m49.769s` |

verify 全跑后工作树只含本任务的预期改动（无脚本产物残留）：

```
$ git status --porcelain     # verify 跑完后
 M docs/demo/video-script-chocolate.md
 M docs/specs/02-nodes.md
 M docs/specs/05-store.md
 M docs/specs/06-backend.md
 M server/extensions/govio-canvas.ts
 M server/govio-node-queue.ts
 M src/services/canvas-service.ts
 M src/store/canvas-store.ts
 M src/types/index.ts
 M tests/integration/canvas-store.test.ts
?? server/table-relations.ts
?? src/utils/table-relations.ts
?? tests/integration/table-relations.test.ts
```

（commit 之后复跑 `npm run verify`，`git status --porcelain` 输出为空 —— 见 §5。）

## 2. 断言数变化（零回归 + 新增覆盖）

### 2.1 专项脚本：609 → **609**（逐字不变，零回归）

```
共 92 项断言，失败 0 项     PASS: Manifest 往返无丢失
共 71 项断言，失败 0 项     PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
共 119 项断言，失败 0 项    PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID
共 126 项断言，失败 0 项    PASS: 交付报告自包含、含五类节点与血缘图、附录 A/B 齐全、漂移有警示、内容全部转义
共 39 项断言，失败 0 项     PASS: sourceTable 数据源标注全链路贯通，旧节点兼容
共 45 项断言，失败 0 项     PASS: 口径溯源 semanticRefs 归因链路贯通，数据/语义血缘边可视化区分
46/46 checks passed        （caliber-conflict）
共 13 项断言，失败 0 项     PASS: cwd 规范大小写后 Windows 会话恢复命中，静默失败消除
verify-prompt-injection: 58/58 通过
```

合计 92+71+119+126+39+45+46+13+58 = **609**，与基线逐项相同（本任务未新增/修改任何 verify 脚本，
新覆盖全部落在 vitest，`verify:integration` 已含在 `npm run verify` 链尾）。

### 2.2 vitest：7 文件 / 83 例 → **8 文件 / 120 例**（+1 文件 / +37 例）

```
Test Files  8 passed (8)
     Tests  120 passed (120)
```

| 文件 | 前 | 后 | 新增覆盖点 |
|---|---|---|---|
| `tests/integration/canvas-store.test.ts` | 11 | **21** | 星型 3 条 fact→dim 语义边（先 fact 后 dim / 先 dim 后 fact 两种顺序）、互相声明关系时无向去重、与数据血缘边并存且 id 不冲突、裸 `tableName` 变体匹配三段式目标、`tableRelations` 缺失不建边且不写键、关系目标不在画布不建边不报错、自环/空目标/缺 `targetTable`/`null`/`"bogus"` 元素忽略、`hydrateSession` 恢复不重复建边且新表照常补边、字段级 `foreign_key` 降级建边 + `tableRelationsError` 透传 |
| `tests/integration/table-relations.test.ts` | — | **27**（新文件） | `parseColumnList` 四种形状 + 7 类边界；`buildRelatesToCypher` 双形 IN / schema.md 属性名 / LIMIT / 引号与反斜杠转义；`relationsFromGraphRows` 字段映射 + 自环 + 重复去重 + 非法元素；`relationsFromFields` FK / 同表多列合并 / `isForeignKey:false` / 非法输入；`resolveTableRelations` 降级矩阵（图谱 ok / 空结果 / reject / **永不 resolve → 本地超时闸** / 无表键 / `schema.tableName` 键回退）；`govio_create_source_table` 工具链路（命中带关系、降级不阻断且留痕、都无关系时三键全不写）；星型全链路（4 节点 3 边 → sidecar 往返 → hydrate 不重复 → 导出 HTML） |

**每条链路至少 1 个失败/边界用例**（X4 约定）：`spawn govio-cli ENOENT`（降级）、
`Binder exception`（错误透传）、永不 resolve 的 runner（超时闸 30ms 实测 <3s 返回）、
`null`/`"bogus"` 关系元素、空画布导出、`isForeignKey:false`、无表键不查图谱。

## 3. 星型模型实测（live 图谱，只读查询）

### 3.1 图谱查询（实现所用的 Cypher 由 `buildRelatesToCypher()` 生成）

```bash
govio-cli query -c 'MATCH (a:PhysicalTable)-[r:RELATES_TO]->(b:PhysicalTable) WHERE a.full_table_name IN ["chocolate.chocolate.fact_sales", "chocolate.fact_sales"] RETURN a.full_table_name AS src, r.relationship_type AS relationship_type, r.description AS description, r.source_columns AS source_columns, b.full_table_name AS target, r.target_columns AS target_columns LIMIT 50'
```

```
Result output: .govio\output-20261111062557538056.json rows: 3 columns: ["src", "relationship_type", "description", "source_columns", "target", "target_columns"]
[{"src": "chocolate.chocolate.fact_sales", "relationship_type": "many_to_one", "description": "事实表产品外键：每条销售订单归属一个产品", "source_columns": "product_id", "target": "chocolate.chocolate.dim_product", "target_columns": "product_id"},
 {"src": "chocolate.chocolate.fact_sales", "relationship_type": "many_to_one", "description": "事实表国家外键：每条销售订单归属一个国家", "source_columns": "country_id", "target": "chocolate.chocolate.dim_country", "target_columns": "country_id"},
 {"src": "chocolate.chocolate.fact_sales", "relationship_type": "many_to_one", "description": "事实表渠道外键：每条销售订单归属一个销售渠道", "source_columns": "channel_id", "target": "chocolate.chocolate.dim_channel", "target_columns": "channel_id"}]
```

⚠ 实证复核：`source_columns` / `target_columns` 确实返回**字符串**（`"product_id"`），
`parseColumnList()` 的字符串分支即为此而设（导入源文件里是数组，两条分支都有用例）。

### 3.2 端到端（真实 `resolveTableRelations` + 真实 `tableSemanticEdgeCandidates`）

临时脚本（`tmp-x10-live-check.ts`，**不入库**，验证后删除）对 4 张表跑真实图谱查询，
再按两种上画布顺序模拟建边：

```
chocolate.chocolate.fact_sales   → status=ok source=graph relations=3
    many_to_one → chocolate.chocolate.dim_product [product_id → product_id]
    many_to_one → chocolate.chocolate.dim_country [country_id → country_id]
    many_to_one → chocolate.chocolate.dim_channel [channel_id → channel_id]
chocolate.chocolate.dim_product  → status=ok source=- relations=0
chocolate.chocolate.dim_country  → status=ok source=- relations=0
chocolate.chocolate.dim_channel  → status=ok source=- relations=0

[顺序A 先 fact 后 dim] nodes=4 semanticEdges=3
    gov-1 → gov-2 (e-gov-1-gov-2-sem)
    gov-1 → gov-3 (e-gov-1-gov-3-sem)
    gov-1 → gov-4 (e-gov-1-gov-4-sem)

[顺序B 先 dim 后 fact] nodes=4 semanticEdges=3
    n-0 → n-1 (e-n-0-n-1-sem)
    n-0 → n-2 (e-n-0-n-2-sem)
    n-0 → n-3 (e-n-0-n-3-sem)
```

结论（对齐 acceptance 1）：**4 个 sourceTable 节点 → 恰好 3 条语义边，方向均为 fact → dim**，
两种上画布顺序结果一致（双向匹配生效）；dim 表自身无出向关系（`relations=0`）时不产生多余边。
边样式在 store 内全量取 `lineageEdgeAppearance('semantic')`（紫虚线、不流动），
由 canvas-store 用例逐字段断言；导出 HTML 与图例由 table-relations 用例断言。

## 4. 降级路径验证（acceptance 2）

以 fake runner 注入（`deps.runGraphQuery`，不调真实 CLI），断言「不建边、不抛错、不阻断节点创建、原因有留痕」：

| 场景 | 注入 | 结果（用例断言） |
|---|---|---|
| CLI 不可达 | `reject(new Error("spawn govio-cli ENOENT"))` | 工具仍 `pushGovioNode`（事件数 1）；`tableRelationsSource="fields"`（字段级 FK 降级出 1 条关系）；`tableRelationsError` 含 `ENOENT`；回执含 `Created source table node: fact_sales` |
| Cypher 属性名错 | `reject(... "Binder exception")` | `status="degraded"`、`error` 含 `Binder exception`，字段级降级出 2 条关系 |
| 查询挂死 | `new Promise(() => {})` + `timeoutMs: 30` | `status="degraded"`、`error` 含「超时」，实测 <3s 返回（本地超时闸生效，不拖住节点创建） |
| 图谱空结果 | `resolve([])` | `status="ok"`（空结果非失败）、无 `error` 键；有 FK 字段时 `source="fields"` |
| 图谱与字段级都无 | `resolve([])` + 无 `references` 字段 | `tableRelations`/`tableRelationsSource`/`tableRelationsError` **三键全不写**；回执 `relations: none`；画布不建边（canvas-store 用例断言 `Object.keys(node.data)` 不含 `tableRelations`） |
| 表键构造不出 | `tableName`/`qualifiedName` 均缺 | `status="degraded"`、`error` 含「表键」，**不调用图谱查询**（`runQuery` 未被调用，禁止猜表名），仍走字段级降级 |

前端侧：`tableRelations` 缺失 / 目标不在画布 / 自环 / 非法元素 → 一律不建边且不抛错
（`createGovioNode` 外层 try/catch 未触发，用例直接断言 `edges.length === 0`）。

## 5. 持久化与导出核实（acceptance 4）

- **sidecar 往返**：星型 4 节点 3 边 → `saveCanvas()` → `loadCanvas()`：`edges` 深度相等，
  `node.data.tableRelations` / `tableRelationsSource` 无损；`hydrateSession()` 后边数仍为 3
  （**不重复建边**），恢复后再落地一张既有关系指向的表只新增 1 条边。
- **导出交付报告**：`layoutLineage(nodes, edges)` → 3 条边 `lineageKind === "semantic"`；
  `buildDeliveryReportHtml()` 产物含 `stroke="hsl(270, 60%, 55%)"`、`stroke-dasharray="6 4"`、
  `marker-end="url(#govio-arrow-sem)"`、图例文案「语义血缘」，且不含 `<script`。
  → `export-report.ts` / `LineageLegend.tsx` **确认无需改动**（已按 `lineageKind` 泛化），
  与任务书 §3 的预期一致；未发现 gap，故无最小修复。
- **WS 协议**：未改 `src/types/ws-protocol.ts`，`PROTOCOL_VERSION` 保持 `1`
  （`canvas_save`/`canvas_restore` 载荷为 `Type.Array(Type.Unknown())`，新增节点字段无需升版）。

## 6. 交付物

- `docs/tasks/X10-table-semantic-edges/design.md`（方案与取舍 + 6 条遗留问题）
- `docs/tasks/X10-table-semantic-edges/CHANGES.md`（3 新增 + 10 修改，逐处摘要 + 明确未改动清单）
- `docs/tasks/X10-table-semantic-edges/verification.md`（本文件）

## 7. 复跑命令

```bash
npm run build          # tsc -b && vite build && esbuild server
npm run lint           # eslint .
npm run verify         # 9 个专项脚本 + vitest run（约 50s）
npx vitest run tests/integration/table-relations.test.ts tests/integration/canvas-store.test.ts   # 48 例
```
