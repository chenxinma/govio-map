# X17 设计：表间关系匹配精确化（档 A：全限定名全等优先）

> 计划事实源：`docs/task-plan.json → crossCutting[X17]`。用户裁决（2026-11-14）：**只做档 A**，
> 档 B（图谱 `PhysicalTable` id 匹配）不实施。

## 1. 背景与动机

X10 建立表间语义边时，目标表匹配一律走「点号后缀变体集合求交」（`tableKeyVariants`）：
`sales.a.dim_product` 与 `sales.b.dim_product` 都会被裸表名变体 `dim_product` 命中，同名表跨
catalog/schema 时边可能连错表（X10 design §8 遗留①、X13 design §8 遗留⑤）。主会话取证：
现有 `buildRelatesToCypher` **早已 `RETURN b.full_table_name AS target`**——全限定名一直在手，
只是没有作为全等优先键使用。档 A 零新增图谱查询，把该原值落成关系上的可选键并前置全等比较。

## 2. 方案

### 2.1 数据形状（`src/types/index.ts`）

`TableRelation` 新增可选键：

```ts
targetQualifiedName?: string;  // 图谱 b.full_table_name 原值；缺失不建键、禁止猜测
```

- 仅图谱路径且行确实给出 `target` 列时携带；字段级降级路径（`relationsFromFields`）没有
  全限定名可落，**不建新键**，行为保持现状。
- 新字段全可选：旧节点、旧 sidecar、旧事件无该键 → 匹配自动退第②级，不报错（acceptance 4）。

### 2.2 落键（`server/table-relations.ts`）

新增导出 `withGraphQualifiedNames(relations, rows)`：从行的 `target` 列（`b.full_table_name AS
target` 原值列）收集归一集合，`targetTable` 命中集合的关系浅拷贝补 `targetQualifiedName`；
仅靠 `tgt` / `full_table_name` 兜底列名产出的 `targetTable` 不建键（归因纪律，禁止猜测）。
调用点在 `resolveTableRelations` 图谱分支：

```ts
relations = withGraphQualifiedNames(relationsFromGraphRows(rows, key), rows);
```

**落点取舍（与任务书 §4.2 字面差异，如实记录）**：任务书写「`relationsFromGraphRows` 落该键」。
实现把落键放在取数层（同文件、图谱路径唯一入口）。原因：验收契约明确「既有
`table-relations.test.ts`（server 27 例）**不修改即通过**」，而其中
`「图谱行 → TableRelation：3 行星型关系字段逐一映射」` 用 `toEqual` 锁死了
`relationsFromGraphRows` 的输出形状（实证：在该函数本体加键 → 1 例失败
`AssertionError: expected { …(6) } to deeply equal { …(5) }`）。两条款字面冲突时，本实现服从
acceptance（验收契约），函数本体输出形状保持不变，键值语义与任务书完全一致（图谱路径关系
带 `b.full_table_name` 原值）。新增断言同时**锁定该形状**（形状锁定用例），防止将来误挪落点
悄悄改行为。

### 2.3 前端三级匹配（`src/utils/table-relations.ts`）

`tableSemanticEdgeCandidates` 两个方向同规则：

- **第①级（全等优先）**：关系带 `targetQualifiedName` 且与既有节点 `qualifiedName` 全等
  （两侧 `normalizeTableKey` 归一）→ **命中即止**：该关系不再进入第②级。
- **第②级（变体兜底）**：第①级未命中——关系无该键、节点无 `qualifiedName`、或全限定名对不上
  ——才退回既有 `tableKeyVariants` 点号后缀变体集合求交。**既有匹配/去重语义一字不改**
  （无向 pairKey、① 优先于 ②、自环丢弃、既有语义边不重建）。
- **第③级**：都不中不建边。

大小写归一规则：两侧统一走既有 `normalizeTableKey`（`trim` + `toLowerCase`）。DuckDB/Postgres
表名大小写不敏感，全等比较必须同口径，否则图谱 `Sales.A.Dim_Product` 会漏配节点
`sales.a.dim_product`。归一仅用于比较键；`targetQualifiedName` 落盘/下发的是原值，不改写。

新导出纯函数（可单测）：`relationExactTargetKey(rel)`（关系第①级比较键，空/非法 → undefined）、
`sourceTableQualifiedNameKey(node)`（节点第①级主体，非 sourceTable/缺失 → undefined）。
`nodeTableRelations` 清洗器透传合法字符串 `targetQualifiedName`、过滤非法形状。

### 2.4 残余风险（第②级兜底的已知边界）

全限定名指向的表**不在画布上**而另一张同名表在时，第②级变体仍可能把边连到同名表——这是
X10 兜底语义的刻意保留（图谱 `full_table_name` 段数与节点 `qualifiedName` 段数随导入环境
不一致，BUGFIX-injection-graph-key 教训：全等失败就拒建会把合法边也杀掉）。彻底消解需档 B
（id 匹配）。live 图谱当前无重名（主会话取证），残余属潜在风险。

## 3. 与档 B 的边界

档 B（`targetGraphId`/`graphNodeId` + `a.id`/`b.id` 同批返回）**未实施**（用户裁决 2026-11-14）。
后续路线（仅记录，不实现）：`PhysicalTable.primary_key = id`（schema.md 实证，形如 `PT11B596C1`
且逐表唯一）；若立项，优先并入既有 RELATES_TO 查询避免节点创建延迟（X10 遗留⑤冷启动
2.5~4.3s、最坏 8s 本地超时闸），匹配升级为 id 全等 → 全限定名全等 → 变体兜底。

## 4. 范围纪律遵循

- 未改展示层口径（X15/X15.1）；未动 `lineage.ts` APPEARANCE、`layout.ts` 方案B、
  `PROTOCOL_VERSION`（新键走既有 `tableRelations` 载荷，`Type.Unknown()` 约定）；无新依赖。
- 未执行任何图谱查询/Cypher（fake runner 断言已覆盖；schema.md 属性名沿用主会话取证，未凭
  记忆构造新属性）。
- 未动 `docs/task-plan.json`（主会话记账）；未动 W1/W2/W4 文件（`SQLQueryNode.tsx` 等）。
- `docs/specs/02-nodes.md` 只改 `SourceTableNodeData`/匹配语义小节（55-70 行区），与 W4 小节无重叠。

## 5. 验证概要

见 `verification.md`（逐条列出新增断言与门槛结果）。核心场景：fake runner 灌同名跨库两行
（`sales.a.dim_product` / `sales.b.dim_product`），边各自连到正确目标；对照组（无键）复现 X10
误配基线，证明全等优先确实消除了它。

## 6. 遗留问题

1. **第②级兜底保留跨库同名误连残余**（§2.4）：正确表不上画布、同名错误表在画布时仍可能误连。
   彻底解法是档 B（id 全等），用户裁决暂不实施；再立项时按 §3 路线评估。
2. **落点与任务书字面差异已按 acceptance 裁决**（§2.2）：若主会话验收时认为应改按任务书字面
   （键直接落 `relationsFromGraphRows`），则需同步更新 `table-relations.test.ts:147` 的 `toEqual`
   期望对象（+1 键）——属「既有用例修改」，需主会话明示豁免后才可做。
3. **`src/utils/table-relations-ui.ts` 展示层不消费新键**：节点小节行 title 已展示目标表全限定名
   （来自 `targetTable`），与 `targetQualifiedName` 图谱路径同值，暂不重复；若将来两键分叉
   （如档 B 回填修正），再评估 title 口径。
4. **hydrate/旧 sidecar 无第①级**：X17 前落盘的图谱关系不带键，恢复后走变体兜底（不报错、
   行为同 X10）。重开一次 agent 会话重建节点即可获得新键；不做批量迁移。