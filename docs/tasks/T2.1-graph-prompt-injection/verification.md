# T2.1 验证记录：图谱定义自动注入 Prompt

> 复跑命令均为 worktree 根目录执行（Windows Git Bash）；任一非零退出即失败。

## 验证门槛（全绿）

| 命令 | 结果 |
|---|---|
| `npm run build` | ✓ tsc -b + vite build 通过（chunk size 警告为既有现象） |
| `npm run lint` | ✓ 0 error 0 warning |
| `npm run verify` | ✓ 聚合全绿：verify:manifest 92 / verify:rerun 71 / verify:audit 119 / verify:export 126 / verify:source-table 39 / verify:cwd 13 / **verify:prompt-injection 47（新增）** / verify:integration 40 用例 |

- 脚本断言 460 → **507**（+47，全部来自新增 `verify-prompt-injection`，既有断言零回归）
- 集成用例 38 → **40**（+2，`tests/integration/ws-handler.test.ts`）
- verify 全跑后 `git status --porcelain` 仅含本任务变更文件，无杂散产物（`.govio/` 已 gitignore）

## 关键输出（`npm run verify:prompt-injection`）

```
[A] makePrompt/REF 序列化（引用 sourceTable 注入 qualifiedName/datasourceType）
  ✓ REF envelope 形态逐字保持（^REF:[ + content，旧断言兼容）
  ✓ CTX 行注入且含 qualifiedName
  ✓ CTX 行注入且含 datasourceType
  ✓ CTX 行含 datasource/schema 与表限定名纪律指令
  ✓ CTX 在 REF 之后、用户内容之前
  ✓ CTX 行为单行合法 JSON（含 tables/graphStatus/instructions 键）
  ✓ 注入后用户内容原样保留
  ✓ 无注入内容时 prompt 与现状逐字一致（无 CTX 行，降级为现状行为）
  ✓ 无 referencedNodes 但命中问题实体时只出 CTX 行（无 REF）
  ✓ 图谱降级时 CTX 仍注入表事实且标记 degraded
[B] 表事实解析（禁止猜测、字段可追溯）        5 项 ✓
[C] 图谱实体注入与降级（图谱不可达不阻断会话） 15 项 ✓
   （含：Cypher 全部 MATCH 开头 + LIMIT 300；Col 按 full_table_name 两段式匹配；
     整体降级 / 单查询失败 partial / 空实体 → 现状行为 等降级矩阵全分支）
[D] 注入留痕（节点 ID + 图谱实体 ID 列表随会话持久化） 8 项 ✓
   （append-only 两条、坏行跳过、随会话删除、无会话文件跳过不抛错）
[E] 口径命中率测量（生成 SQL 表引用 vs 注入的 qualifiedName） 6 项 ✓
   （fixture：2 hit / 1 miss（裸表名）/ 1 unrelated（CTE）→ rate=2/3；
     bash --sql 与工具参数 sql 双来源；无 CTX 轮次跳过；sidecar 不误扫）
[F] 会话 transcript：CTX 注入行剥离            3 项 ✓

verify-prompt-injection: 47/47 通过
```

集成测试（`npm run verify:integration`）：`Test Files 4 passed (4) / Tests 40 passed (40)`，
新增两例：

- `prompt 注入：CTX 行含 qualifiedName/datasourceType，用户内容原样保留`（断言 session.prompt
  收到 `^REF:[` + `CTX:` + `chocolate.chocolate.dim_product` + `"datasourceType":"duckdb"`）
- `T2.1 降级：图谱不可达时 prompt 照常派发（不阻断会话），CTX 仍含表事实并标记 degraded`
  （mock graph-query 全部 reject → prompt 仍派发、无 error 帧、`"graphStatus":"degraded"`）

## 图谱查询实测（ladybug 后端，2026-11-05）

注入所用 Cypher 均在本机 `govio-cli query -c` 实测通过（schema.md 属性名核对）：

- `MATCH (m:Metric) RETURN m.id, m.code, m.name, m.business_definition, ... LIMIT 5` → 5 行（销售额/出货箱数/…）
- `MATCH (m:Metric)-[:USES_TABLE]->(t:PhysicalTable) RETURN ...` → `chocolate.fact_sales`
- `MATCH (m:Metric)-[r:DIMENSION_USED]->(d:Dimension) RETURN ...` → `dim_time`（values_example=2024-01-01）
- `MATCH (c:Col) WHERE c.full_table_name = "chocolate.dim_product" RETURN ...` → product_id/product_name（BIGINT/VARCHAR）

stdout 解析形态（状态行 + 紧凑 JSON 行）已固化进 `graph-query.parseQueryRows` 断言路径。

## Acceptance 对照

| acceptance | 落点 |
|---|---|
| ① 引用 sourceTable 时 prompt 含 qualifiedName/datasourceType（makePrompt/REF 序列化可断言） | [A] 3 项 + 集成用例 1 |
| ② 图谱实体注入可追溯（实体 ID 列表随会话持久化） | [D] 8 项（injection.jsonl sidecar） |
| ③ 口径命中率测量脚本（抽样比对 SQL 表引用与注入 qualifiedName） | [E] 6 项 + 真实会话抽样输出 |
| ④ 注入失败降级为现状行为且不阻断会话 | [A] 1 项 + [C] 降级矩阵 4 项 + 集成用例 2 |
