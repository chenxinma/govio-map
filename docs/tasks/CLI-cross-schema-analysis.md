# 分析：不同 schema 多表结合的 SQL，govio-cli 应该怎么处理

> 主 session 分析（2026-10-31）· 基于本机 govio-cli 源码取证：
> `observe_data/core/database.py`（引擎解析）、`metadata/datasource.py`（DatasourceDef/qualify/resolve_datasource）
> 关联实证：`docs/tasks/BUGFIX-load-parse.md`（chocolate 三段式限定名试错案例）

## 1. 现状（源码取证）

`observe load --datasource X --sql "..."` 的执行路径：

```
DatabaseManager._ensure(name)
  ├─ url 以 duckdb:// 开头
  │    ├─ 目录形式 → duckdb.connect(":memory:") + SET file_search_path='<dir>'
  │    └─ 文件形式 → duckdb.connect(db_path, read_only=True)
  └─ 其他 URL → sqlalchemy.create_engine(url)
execute_sql(datasource, sql) → 单连接直接执行，SQL 原样透传
```

关键结论：
1. **一次 load 只连一个数据源**，SQL 在该数据源的单一连接内执行——CLI 层没有跨数据源联邦能力
2. **同数据源内跨 schema 是天然支持的**——SQL 原样透传，只要写对限定名（DuckDB 的 `catalog.schema.table`、PG 的 `schema.table`）
3. 元数据侧已有配套件但 observe 侧未使用：`metadata/datasource.py` 的 `qualify(datasource_name, "schema.table")` 与 `resolve_datasource(schema, datasource_map)`（schema→datasource 反查），以及 `DatasourceDef.filter.schemas`（治理范围声明）

## 2. 分场景建议

### 场景 A：同一数据源、不同 schema 的表 join（最常见）
**现状即可支持，问题只在"agent 写不写对限定名"。** 治理动作全在 govio-map 侧：
- T2.0：sourceTable 节点保存 `datasourceType` + `qualifiedName`，agent 拼 SQL 时直接引用节点上的全限定名，不再猜
- X5：提示词规则强制"SQL 中的表引用必须来自 sourceTable.qualifiedName"
- 上游可选优化（低优先）：`duckdb://` 目录模式（in-memory + file_search_path）下多文件即多 catalog，CLI 可在报错时附带 `Did you mean <catalog>.<schema>.<table>` 的全限定建议（DuckDB 自带此提示，本次实证中确实出现，agent 未利用——属提示词纪律问题）

### 场景 B：跨数据源 join（如 chocolate × sales）
**不要给 observe load 加多数据源参数**（连接生命周期、事务语义、凭据边界都会复杂化）。两条既有/低成本路径：

1. **推荐（零上游改动）：两段式加载 + `--memory` join** —— 这正是 `--memory` 的设计用途：
   ```bash
   govio-cli observe load --name df_product --datasource chocolate --sql "SELECT ... FROM chocolate.chocolate.dim_product"
   govio-cli observe load --name df_sales   --datasource sales      --sql "SELECT ... FROM ..."
   govio-cli observe load --name df_joined  --memory --sql "SELECT ... FROM df_product p JOIN df_sales s ON p.product_id = s.product_id"
   ```
   优点：每个 DataFrame 有独立 Manifest/血缘（画布上自然呈现三段血缘）；缺点：大表 join 受本机内存约束。
   → govio-map 侧动作：skill/提示词中把"跨数据源 join 必须走两段式 + --memory"写成硬规则（并入 X5）。

2. **上游中期能力（如确有库内联邦需求）：DuckDB 联邦 ATTACH** —— 以 DuckDB 为联邦引擎，`ATTACH 'postgres://...' AS pg (TYPE postgres)` 后单条 SQL 跨源 join。仅建议作为 govio-cli 的可选增强（`observe load --attach ds2`），前提：只读、凭据仍从声明文件取、明确不支持跨源写。DuckDB 的 postgres_scanner/mysql_scanner 成熟，但 oracle/hive/trino 无对应 scanner——**联邦能力天然只能覆盖部分 source_type 组合**，这是不建议作为主路径的原因。

### 场景 C：source_type 差异导致的方言问题（ join 之外的函数/类型差异）
`qualify()`/`resolve_datasource()` 已在元数据侧沉淀了 schema→datasource 归属。建议上游把 **source_type 暴露到 observe 侧**（如 `observe info --datasource` 从纯名称列表升级为 `[{name, source_type, schemas}]`），govio-map 的 T2.0 即可直接消费该输出而非依赖图谱查询——两个上游小改动（本条 + 失败退出码非 0，后者用户已提交）能让整条链路无猜测。

## 3. 结论排序

| 优先级 | 动作 | 归属 |
|---|---|---|
| P0 | sourceTable 存类型+全限定名，SQL 引用不靠猜 | govio-map T2.0（进行中） |
| P0 | 失败退出码非 0 | govio-cli 上游（用户已提交） |
| P1 | 提示词硬规则：跨源 join 走两段式 + --memory；表引用必须来自 qualifiedName | govio-map X5 |
| P1 | `observe info --datasource` 输出带 source_type/schemas | govio-cli 上游（建议新提 issue） |
| P2 | DuckDB ATTACH 联邦作为可选增强 | govio-cli 上游（暂缓，覆盖面有限） |
