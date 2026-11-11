# X10 变更清单（CHANGES）

> 方案与取舍见同目录 `design.md`；验证命令与关键输出见 `verification.md`。
> 单次 commit，message 前缀 `X10:`。不改 `docs/task-plan.json`（并行派发，记账由主会话执行）。

## 新增文件（3）

| 文件 | 行数 | 摘要 |
|---|---|---|
| `server/table-relations.ts` | 278 | 表间关系获取（server 侧）。导出 `resolveTableRelations()`（**永不 throw**：图谱 `RELATES_TO` 主路径 → 字段级 `references` 降级 → 都拿不到返回空）与纯函数 `parseColumnList()`（列形状容错：字符串/数组/JSON 数组串/逗号分隔/数字）、`buildRelatesToCypher()`（表键双形 `IN [...]`，属性名严格取 `schema.md`）、`relationsFromGraphRows()`（映射 + 自环丢弃 + 重复去重 + `MAX_TABLE_RELATIONS=50` 上限）、`relationsFromFields()`（FK → `foreign_key`，同表多列合并，尊重 `isForeignKey:false`）；常量 `RELATIONS_QUERY_TIMEOUT_MS=8000`（本地超时闸，避免 `runGraphQuery` 12s×重试拖住节点创建）、`FIELD_RELATIONSHIP_TYPE`。表键构造复用 `prompt-injection.ts` 的 `graphTableKey`/`tableKeyCandidates`（不重复实现） |
| `src/utils/table-relations.ts` | 185 | 画布侧纯匹配逻辑（无 ReactFlow 依赖，便于 node 环境单测）。导出 `tableKeyVariants()`（点号后缀变体：`a.b.c` → {`a.b.c`,`b.c`,`c`}）、`normalizeTableKey()`（trim+lowercase）、`sourceTableMatchKeys()`（`qualifiedName` → `schema.tableName` → `tableName`）、`nodeTableRelations()`（非法元素/空 `targetTable` 过滤）、`relationTargetKeys()`、`tableSemanticEdgeCandidates()`（双向匹配 ①新→既有 ②既有→新 + **无向**去重 + 自环丢弃 + 已有语义边不重建，数据边不参与去重判定故可并存） |
| `tests/integration/table-relations.test.ts` | 471 | 27 例：列形状容错与 5 类边界；Cypher 构造（双形 IN/属性名/LIMIT/引号转义）；图谱行解析（映射/自环/去重/非法元素）；字段级降级（FK/多列合并/`isForeignKey:false`/非法输入）；`resolveTableRelations` 降级矩阵（ok / 空结果 / reject / **永不 resolve → 超时闸** / 无表键 / 键回退）；`govio_create_source_table` 工具链路（图谱命中带 `tableRelations`、降级不阻断节点创建且写 `tableRelationsError`、都无关系时三键全不写）；星型全链路（4 节点 3 边 → `saveCanvas`/`loadCanvas`/`hydrateSession` 往返无损不重复建边 → `layoutLineage`/`buildDeliveryReportHtml` 导出断言紫虚线 + `govio-arrow-sem` + 图例 + 无 `<script`） |

## 修改文件（10）

### 类型与协议形状（3）

| 文件 | 变更 |
|---|---|
| `src/types/index.ts` | 新增 `TableRelation`（`targetTable` / `relationshipType` / `description?` / `sourceColumns?` / `targetColumns?`，含来源分层与列形状容错说明）与 `TableRelationsSource = 'graph' \| 'fields'`；`SourceTableNodeData` 新增三个可选字段 `tableRelations?` / `tableRelationsSource?` / `tableRelationsError?`（各带取值来源与「缺失不建键」注释） |
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent` 同步新增上述三字段（导入 `TableRelation`/`TableRelationsSource` 类型），注释说明来源与「缺失不写键」纪律 |
| `src/services/canvas-service.ts` | `CanvasEvent` 手工镜像同三字段（与 `GovioNodeCreateEvent` 逐字对齐，T2.0 同款形状纪律） |

### 服务端取数接入（1）

| 文件 | 变更 |
|---|---|
| `server/extensions/govio-canvas.ts` | ① `govio_create_source_table.execute` 内 `await resolveTableRelations({...})`，按结果条件写键（`relations.length>0` 才写 `tableRelations`；`source`/`error` 各自有值才写）；② `status==="degraded"` 时 `console.warn` 一行；③ 工具回执追加 `relations: N (graph\|fields)` / `relations: none (degraded: ...)` / `relations: none`（对话即留痕）；④ 扩展 `deps` 增加可选 `runGraphQuery?: GraphQueryRunner`（测试注入 fake，与既有 `runCaliberCli` 同款模式）；⑤ 工具 description 增一句：表间关系由服务端从图谱解析、无对应参数、不要口头复述外键 |

### 画布建边（1）

| 文件 | 变更 |
|---|---|
| `src/store/canvas-store.ts` | ① `sourceTable` 分支透传三个可选字段到 `node.data`（缺失不建键）；② 在 T2.2 sqlQuery 语义边块之后新增表间语义边块：`event.nodeType === "sourceTable"` 时调 `tableSemanticEdgeCandidates(nodes, {id, data}, edges)`，把候选转成 `Edge`（`id: e-<src>-<tgt>-sem`、`type:"smoothstep"`、样式全量取 `lineageEdgeAppearance('semantic')`、`data.lineageKind:"semantic"`）追加进 `newEdges`（因此参与 `positionNewNode` 布局）。**未改** `lineage.ts` 色值/线型，未新增血缘类别 |

### 测试扩展（1）

| 文件 | 变更 |
|---|---|
| `tests/integration/canvas-store.test.ts` | 新增 `describe("canvas-store：表间语义血缘边（X10）")` 共 10 例（11 → 21 例）：星型 3 条 fact→dim 边（先 fact 后 dim / 先 dim 后 fact 两种顺序，断言方向、条数、`-sem` id、样式取自 `lineageEdgeAppearance`）、互相声明关系时无向去重（只 1 条且 ① 方向胜出）、与数据血缘边并存（`e-a-b` 与 `e-a-b-sem` 同存、id 不冲突）、裸 `tableName` 变体匹配三段式目标、`tableRelations` 缺失不建边且不写键、关系目标不在画布不建边不报错、自环/空目标/缺 `targetTable`/`null`/`"bogus"` 元素忽略、`hydrateSession` 恢复的边不被重复追加且新表照常补边、字段级 `foreign_key` 降级关系建边 + `tableRelationsError` 透传；文件头覆盖清单与 `lineageEdgeAppearance` 导入同步 |

### 文档同步（4）

| 文件 | 变更 |
|---|---|
| `docs/specs/02-nodes.md` | `SourceTableNodeData` 字段表新增 `tableRelations?` / `tableRelationsSource?` / `tableRelationsError?` 三行；补一段 X10 说明（服务端解析、agent 不传、图谱不可用降级、拿不到不建键不建边、前端建紫虚线语义边并容忍限定名段数差异） |
| `docs/specs/05-store.md` | `createGovioNode` 流程第 4 步补 T2.2 语义边与 X10 表间语义边（双向匹配 ①/②、变体匹配、无向去重、自环丢弃、目标不在画布不建边）；第 5 步边样式改为数据血缘/语义血缘分列（语义边样式取 `lineageEdgeAppearance('semantic')`、id 加 `-sem`、两类可并存）；`hydrateSession` 小节补「不重算边」取舍与历史会话影响 |
| `docs/specs/06-backend.md` | 文件结构表新增 `server/table-relations.ts` 行；`GovioNodeCreateEvent` 字段表新增 `tableRelations` / `tableRelationsSource` / `tableRelationsError` 三行；`govio_create_source_table` 参数表补 T2.0 四个标注参数行 + 新增「表间关系无参数」段落（取数分层、永不 throw、降级留痕与 `console.warn`、工具回执形态） |
| `docs/demo/video-script-chocolate.md` | 场景 1 第 3 点由「关联关系以文字回答呈现（⚠ 连线未实现）」改为「表间关系自动连边呈现（X10 已实现）：3 条紫虚线语义边 + 图例可辨识」；旁白/字幕/运镜改为连线版；「导演注意」由「若实现则升级」改为「已落地，按连线版录制 + 图谱降级时录前预检」；录制前检查清单第 293 行由「场景 1 不出现表间连线」改为「场景 1 出现 3 条表间紫虚线语义边（录前实测确认）」；「功能缺口」表首行标删除线并改为已实现说明 |

## 明确未改动（核实后确认无需改）

- `src/utils/lineage.ts`（色值/线型体系、`lineageKindOf` 回退）
- `src/components/Canvas/LineageLegend.tsx`（`KINDS=['data','semantic']` 与端点类型无关）
- `src/utils/export-report.ts`（`layoutLineage`/`lineageSvg`/`edgeLegend` 已按 `lineageKind` 泛化；由新测试钉住）
- `src/components/Nodes/SourceTableNode.tsx`（字段级 FK 徽标保留，不新增关系交互）
- `src/types/ws-protocol.ts`（`canvas_save`/`canvas_restore` 载荷为 `Type.Unknown()`，`PROTOCOL_VERSION` 保持 1）
- `src/components/SettingsModal.tsx` / `src/utils/provider-drafts.ts`（X11 刚修复，未触碰）
- `docs/task-plan.json`（并行派发纪律：worker 不改计划，记账由主会话执行）
- `package.json` / verify 脚本链（未新增 verify 脚本，新覆盖全部落在 vitest；既有 609 项脚本断言逐字不变）
- 依赖：运行时与 dev 依赖均**零新增**
