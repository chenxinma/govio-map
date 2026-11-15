# X17 CHANGES：文件清单与逐处摘要

## 代码（档 A：全限定名全等优先）

| 文件 | 摘要 |
|---|---|
| `src/types/index.ts` | `TableRelation` 新增可选键 `targetQualifiedName`（图谱 `b.full_table_name` 原值；缺失不建键、禁止猜测），带 X17 注释说明键的产出方与回退语义 |
| `server/table-relations.ts` | ① 新增导出纯函数 `withGraphQualifiedNames(relations, rows)`：仅当关系 `targetTable` 命中某行 `target` 列（`b.full_table_name AS target` 原值列，归一集合）时浅拷贝补 `targetQualifiedName`；`tgt`/`full_table_name` 兜底列名产出的值不建键。② `resolveTableRelations` 图谱分支调用它（零新增查询，`buildRelatesToCypher` 不动）。③ `relationsFromGraphRows` / `relationsFromFields` 输出形状**不变**（既有用例锁死形状，落点取舍见 design §2.2）。④ 模块头注释补 X17 段落 |
| `src/utils/table-relations.ts` | ① `nodeTableRelations` 清洗器透传合法 `targetQualifiedName`、过滤非字符串。② 新增导出 `relationExactTargetKey`（第①级比较键：trim+lowercase）与 `sourceTableQualifiedNameKey`（节点归一 `qualifiedName`，非 sourceTable/缺失 → undefined）。③ `tableSemanticEdgeCandidates` 两方向改三级匹配：全等命中即止（该关系不再进变体求交）→ 未命中退既有变体兜底 → 都不中不建边；既有去重/自环/不重建语义一字不改。④ 模块头与函数 doc 补三级定义 |

## 测试（纯增量；既有文件零修改）

| 文件 | 摘要 |
|---|---|
| `tests/integration/x17-relation-match.test.ts`（新增） | 15 用例三组：服务端落键（图谱主路径带键 / `tgt` 兜底不建键 / 字段级降级不建键 / `relationsFromGraphRows` 形状锁定 / `withGraphQualifiedNames` 边界）；前端三级匹配（全等命中即止只连 dim-a、去键对照复现 X10 双连误配基线、大小写归一、全等未命中退变体、旧节点无 qualifiedName 兜底、都不中不建边、反向既有→新、键透传、助手函数归一）；端到端跨库同名（fake runner 两行，fact_b 后上画布唯一边连 dim-b；两 fact 各连各的 dim 互不串线） |

## 文档

| 文件 | 摘要 |
|---|---|
| `docs/specs/02-nodes.md` | `tableRelations` 字段行元素形状加 `targetQualifiedName?` 与产出纪律；匹配段改写为 X17 三级（含大小写归一口径与「既有语义不变」声明） |
| `docs/specs/06-backend.md` | `tableRelations` 事件字段行更新（新键 + 前端第①级消费）；「表间关系无参数」段后补「X17 档 A 不改查询」小节（零新增查询、落点说明） |
| `docs/tasks/X10-table-semantic-edges/design.md` | §8 遗留 1 标注「已由 X17 解决（档 A）」+ 指向断言与本设计 |
| `docs/tasks/X13-table-relations-ui/design.md` | §8 遗留 5 追加「已由 X17 解决（档 A）」引注 |
| `docs/tasks/X17-relation-match-exact/{design.md,CHANGES.md,verification.md}` | 三件套 |