# X10 设计：表间语义关系线（sourceTable ↔ sourceTable 语义血缘边）

> 任务书见同目录 `DISPATCH.md`；验收契约见 `docs/task-plan.json → crossCutting[] | select(.id=="X10")`。
> 上游：T2.0（sourceTable 数据源标注 / qualifiedName）、T2.1（图谱查询与降级范式）、
> T2.2（语义血缘 `lineageKind:"semantic"` 与样式唯一来源）。

## 1. 目标

星型模型的 4 张表上画布后，自动出现 3 条 `fact_sales → dim_*` 的语义血缘边（紫虚线），
归入既有 `lineageKind:"semantic"` 体系；图谱不可用时优雅降级（不建边、不报错、有留痕）。

## 2. 数据流总览

```
govio_create_source_table（server/extensions/govio-canvas.ts）
  └─ await resolveTableRelations({tableName, qualifiedName, schema, fields, runQuery})   ①取数
       ├─ 主路径：runGraphQuery(buildRelatesToCypher(key))  → relationsFromGraphRows()
       └─ 降级：relationsFromFields(fields)                 （图谱失败/超时/空结果）
  └─ pushGovioNode({nodeType:"sourceTable", tableRelations?, tableRelationsSource?, tableRelationsError?})
       ↓ /canvas WS
createGovioNode（src/store/canvas-store.ts）
  └─ node.data.tableRelations（缺失不建键）                                                ②落节点
  └─ tableSemanticEdgeCandidates(nodes, newNode, edges) → Edge(lineageKind:"semantic")     ③建边
       ↓ debounce 1s canvas_save
canvas sidecar（.canvas.json）→ canvas_restore → hydrateSession（原样恢复，不重算边）      ④持久化
```

## 3. 取数分层（server/table-relations.ts）

| 层 | 来源 | relationshipType | 触发条件 |
|---|---|---|---|
| 主路径 | 图谱 `(:PhysicalTable)-[:RELATES_TO]->(:PhysicalTable)` | 图谱原值（`many_to_one` 等），**不做本地枚举收窄** | 表键可构造且查询成功 |
| 降级 | 字段级 `fields[].references`（+ `isForeignKey`） | 固定 `foreign_key` | 图谱失败/超时/无表键/**空结果** |
| 无 | — | — | 两者都拿不到 → 三个键一律不写、不建边 |

关键取舍：

1. **表键构造复用 T2.1 既有实现**（`graphTableKey` + `tableKeyCandidates`，均从
   `server/prompt-injection.ts` 导入）而不是另写一份：图谱 `full_table_name` 含不含 catalog
   段随导入环境不一致（2↔3 段偏差），双形 `IN [...]` 匹配是 BUGFIX-injection-graph-key 的
   既有结论；重复实现必然漂移。`graphTableKey` 优先 `qualifiedName`（含点号即用），
   否则 `schema.tableName`，**绝不对已带点号的表名再拼前缀**。
2. **Cypher 属性名严格取 `schema.md`**：`RELATES_TO` 只有 `relationship_type / description /
   source_columns / target_columns` 四个属性（凭记忆写 `description` 之外的名字会触发
   Ladybug `Binder exception`）。查询已在本机 live 图库实测（见 `verification.md`）。
3. **列形状容错**（`parseColumnList`）：图谱实测返回**字符串**（`"channel_id"`），而导入源
   文件 `chocolate_relationships.json` 里是数组（`"Cols": ["product_id"]`）。同时兼容
   字符串 / 数组 / JSON 数组字符串 / 逗号分隔串 / 数字元素；解析不出内容返回 `undefined`
   → 调用方**省略键**（不写空数组），与全仓「缺失不建键」纪律一致。
4. **空结果 ≠ 失败**：`graph-query.ts` 已把 `Data not found.` 归一为空数组（`isEmptyResultOutput`），
   故 `status` 保持 `ok`；但仍回退字段级来源（图谱没导入关系时字段 FK 依然有价值）。
5. **本地超时闸 `RELATIONS_QUERY_TIMEOUT_MS = 8000`**：`runGraphQuery` 内部超时 12s + 失败
   重试一次，最坏 24s+ 才 reject，而它在**工具执行路径**上（`govio_create_source_table`
   的 `execute` 里 await），会把 sourceTable 节点上画布的时间一起拖住。到点即降级返回；
   底层查询继续在后台跑完并填 `graph-query` 的 10min 缓存，下次同表命中缓存不再等。
6. **永不 throw、永不阻断节点创建**：`resolveTableRelations` 内部 catch 全部异常，最坏返回
   `{relations: [], status:"degraded", error}`；工具照常 `pushGovioNode`。
7. **自环与重复行过滤**：`relationsFromGraphRows` 丢弃 `target` 与本表变体相交的行（图谱里
   存在自指关系时不画自环边），并按 `(targetTable, relationshipType, 列)` 去重（重复导入
   会产出重复边）；上限 `MAX_TABLE_RELATIONS = 50` 防异常图谱撑爆节点数据。

### 3.1 降级留痕形态

参照 T2.1 的 `graphStatus`/`graphError`，但落在**节点数据**上（随 canvas sidecar 持久化，
事后可审计），而非只写服务端日志：

| 场景 | tableRelations | tableRelationsSource | tableRelationsError |
|---|---|---|---|
| 图谱命中 | 有 | `graph` | 不写键 |
| 图谱失败/超时/无表键 + 字段级有 FK | 有 | `fields` | 写键（原因） |
| 图谱空结果 + 字段级有 FK | 有 | `fields` | 不写键（`status=ok`） |
| 图谱失败/超时/无表键 + 无 FK 字段 | 不写键 | 不写键 | 写键（原因） |
| 图谱空结果 + 无 FK 字段 | 不写键 | 不写键 | 不写键 |

即：`tableRelationsError` 只在**图谱真的失败**时出现（空结果不算失败），且与是否拿到降级
关系无关——这样「有边但来源可疑」与「没边因为图谱挂了」两种情况在节点上都能区分。
同时 `console.warn` 一行（即时可见）+ 工具回执附 `relations: N (graph|fields)` /
`relations: none (degraded: ...)`（进对话 transcript，agent 与用户都能看到）。

## 4. 建边（src/utils/table-relations.ts + canvas-store）

### 4.1 为什么单独抽 util

`canvas-store.createGovioNode` 已经很长，且匹配逻辑需要单测覆盖多种限定名形态。故把
**纯匹配**抽到 `src/utils/table-relations.ts`（无 ReactFlow 依赖、结构化最小入参），
store 只负责把候选转成 `Edge`（id/样式/追加），与 T2.2 语义边同款分工。

### 4.2 限定名变体匹配

图谱给的 `targetTable` 是三段式 `chocolate.chocolate.dim_product`，而画布节点的 `tableName`
通常是裸表名。两侧都展开为**点号后缀变体集合**再求交：

```
chocolate.chocolate.dim_product → {chocolate.chocolate.dim_product, chocolate.dim_product, dim_product}
```

节点侧键来源优先级：`qualifiedName`（T2.0，最精确）→ `schema.tableName` → `tableName`；
键归一为 `trim().toLowerCase()`（DuckDB/Postgres 表名大小写不敏感场景不因大小写漏配）。

已知局限（有意接受）：变体匹配是**尽力而为**——同名表存在于多个 catalog/schema 时可能误配。
缓解：① 最长变体优先命中（`qualifiedName` 在场时三段式先对上）；② 只在 sourceTable ↔
sourceTable 之间建边，误配面有限；③ 关系数据本身来自图谱（不是猜的）。彻底解法需要关系里
带 catalog/schema 三段信息并做全等匹配，已记入遗留问题 1。

### 4.3 双向匹配与去重

新 sourceTable 节点落地时：

- **① 新 → 既有**：新节点 `tableRelations.targetTable` 命中既有 sourceTable 节点；
- **② 既有 → 新**：既有节点 `tableRelations.targetTable` 命中新节点（星型模型里 dim 表
  可能后上画布，此时关系挂在先落地的 fact 节点上）。

去重：**无向** `pairKey(a,b)`（`a<b` 归一）——图谱里 `a→b` 与 `b→a` 同时存在时只画一条，
避免两条完全重叠的边；① 优先于 ② 产出，故方向取「新节点关系指向既有节点」那一侧。
自环（`sourceId === targetId`）丢弃；`existingEdges` 中已存在的**语义边**（按 `lineageKindOf`
判定，而非按 id 规则）覆盖的节点对不再产出候选——这既让 `canvas_restore` 后不重复建边，
也兼容历史/异来源 id。数据血缘边不参与该判定，故两类边**可并存**（id 分别为
`e-<src>-<tgt>` 与 `e-<src>-<tgt>-sem`）。

边形状（与 T2.2 语义边逐字一致，样式全部取 `lineageEdgeAppearance('semantic')`，store 内
不硬编码色值/线型）：`type:"smoothstep"`、`animated:false`、`style:{stroke, strokeWidth,
strokeDasharray}`、`data:{lineageKind:"semantic"}`。

## 5. 持久化与恢复（取舍）

- **边随 sidecar 往返无损**：`tableRelations` / `tableRelationsSource` / `tableRelationsError`
  都是 `node.data` 上的普通 JSON，边是普通 `Edge`；`canvas_save`/`canvas_restore` 载荷是
  `Type.Array(Type.Unknown())`，故**不需要改 `PROTOCOL_VERSION`**（任务书已核实，实现后由
  `tests/integration/table-relations.test.ts` 的往返用例再次验证）。
- **`hydrateSession` 不重算边**（明确取舍：**不做恢复期补建**）。理由：
  1. 恢复期补建需要区分「用户手动删掉的边」与「从未建过的边」——sidecar 里没有这个信息，
     补建会复活用户显式删除的边（破坏用户意图，比缺边更糟）；
  2. 本功能上线前的历史会话，其节点根本没有 `tableRelations`（服务端当时没解析），恢复期
     无从补建，除非再查一次图谱——那是「重新导入」而非「恢复」，应走新会话/重新落地表节点；
  3. `hydrateSession` 现状是纯替换（`set({nodes, edges})`），保持它无副作用最简单可测。
  影响：历史会话恢复后仍无表间边；用户重新让 agent 建表节点即补齐（节点落地时会重新查图谱）。
- **前端 mock 路径不补关系**：`addSourceTableToCanvas`（`MOCK_TABLES`）是纯前端演示入口，
  不经服务端、不查图谱，故不产出 `tableRelations`、不建表间边（记入遗留问题 3）。

## 6. 展示与导出核实（预期无改动，已实测确认）

- `src/components/Canvas/LineageLegend.tsx`：`KINDS = ['data','semantic']`，与边端点类型无关
  → 表间语义边自动出现在图例（「语义血缘」紫虚线）。**未改动**。
- `src/utils/export-report.ts`：`layoutLineage` 按 `lineageKindOf(e)` 分类、`lineageSvg` 按
  kind 选 stroke/dasharray/marker、`edgeLegend` 已遍历两种 kind → 表间边在导出 HTML 的血缘图
  与图例中正确呈现。**未改动**；由新测试用例（`layoutLineage` + `buildDeliveryReportHtml`
  断言紫虚线/`govio-arrow-sem`/图例文案/无 `<script`）钉住。
- `src/utils/lineage.ts`：未新增第三种血缘类别（表间关系语义上就是「语义血缘」），色值/线型
  体系零改动。
- `SourceTableNode.tsx`：未改动（字段级 FK 徽标保留）。关系数据目前只在边上体现，不做
  节点内列表/点击详情（任务书范围纪律：不做新交互），记入遗留问题 2。

## 7. 测试策略

| 文件 | 覆盖 |
|---|---|
| `tests/integration/canvas-store.test.ts`（扩展，+10 例） | 星型 3 条边（先 fact 后 dim / 先 dim 后 fact 两种顺序）、互相声明关系时无向去重、与数据血缘边并存且 id 不冲突、裸表名变体匹配、`tableRelations` 缺失不建边且不写键、目标不在画布不建边不报错、自环与非法关系元素忽略、`hydrateSession` 恢复不重复建边、字段级降级关系建边 + `tableRelationsError` 透传 |
| `tests/integration/table-relations.test.ts`（新增，27 例） | `parseColumnList` 四种形状 + 5 类边界；`buildRelatesToCypher` 双形 IN/属性名/LIMIT/引号转义；`relationsFromGraphRows` 映射/自环/去重/非法元素；`relationsFromFields` FK/多列合并/`isForeignKey:false`/非法输入；`resolveTableRelations` 降级矩阵（ok/空结果/reject/超时/无表键/键回退）；工具链路（图谱命中、降级不阻断、都无关系时三键全不写）；星型全链路（4 节点 3 边 → sidecar 往返 → 导出 HTML） |

每条链路都有失败/边界用例（沿用 X4 约定）：永不 resolve 的 runner（超时闸）、
`spawn ENOENT`（降级）、`Binder exception`（错误透传）、`null`/`"bogus"` 关系元素、
空画布导出、`isForeignKey:false`、无表键。

## 8. 遗留问题

1. **变体匹配可能误配同名表**（§4.2）：`dim_product` 同时存在于多个 catalog/schema 时，
   裸表名变体会命中第一个。彻底解法：让关系数据携带目标表的三段式全名并在两侧都做全等
   优先匹配（需要图谱侧 `RELATES_TO` 查询返回 `b.schema`/`b.database_name` 并落到
   `TableRelation`），或给 sourceTable 节点补 `catalog` 字段。当前星型演示场景无同名表，
   风险可接受。
2. **关系数据只在边上体现，节点内不可见**：`tableRelations`（含 `description`、列映射、
   `tableRelationsError` 降级留痕）没有 UI 出口，用户只能看到一条紫虚线，无法知道
   「这条边基于哪几列、图谱怎么描述的」，也看不到降级原因。建议后续在 SourceTableNode
   加折叠区或边 tooltip（属新交互，本任务范围纪律明确不做）。
3. **前端 mock 路径（`addSourceTableToCanvas` / `MOCK_TABLES`）不产出表间关系**：纯前端演示
   入口不经服务端，故无表间边。若要让 mock 演示也连线，需要在前端复用
   `relationsFromFields` 等价逻辑（会造成 server/前端双实现），或在 mock 数据里预置
   `tableRelations`。当前 mock 路径本身已是历史遗留，暂不投入。
4. **历史会话不补建表间边**（§5 取舍）：上线前的 sidecar 恢复后仍无表间边。若产品认为
   「打开老会话就该看到关系」，需要新增一次显式「刷新表间关系」动作（用户触发 → 服务端
   重查图谱 → 回填节点 + 建边），而不是在 `hydrateSession` 里隐式做。
5. **工具执行路径新增一次图谱查询的延迟**：命中缓存时 ~0ms，冷启动实测 2.5~4.3s，最坏
   8s（本地超时闸）后降级。`govio_create_source_table` 通常一次落地 3~5 张表，冷启动会
   明显拉长该轮工具耗时。可选优化：把常用 `RELATES_TO` 全量查询（不带 WHERE）加入
   `prewarmGraphCache` 的预热列表并按表在内存里筛选——需评估图谱规模，未在本任务展开。
6. **`observe explore` 的外键发现仍未与画布打通**：它只产出 correlation 文字报告，与本任务
   的图谱路径是两套关系来源。若将来要以 explore 结果建边，需要新的关系来源分层与去重规则。
