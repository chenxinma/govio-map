# 2026-11-08 巧克力图谱元数据去重与全量重建（BUGFIX-meta-naming-duplicate）

## 背景

`chocolate` 数据源执行 `govio-cli meta import-schema` 时校验虽 pass，但图库内同一批表存在两套节点：

| 命名 | 示例 node_id | Datasource 归属（OWNS） |
|---|---|---|
| 三段式 `datasource.schema.table`（现行 CLI 口径） | `PT8E8245FA` = `chocolate.chocolate.dim_product` | ✅ |
| 两段式 `schema.table`（2026-11-08 之前的历史口径） | `PT2D7E6455` = `chocolate.dim_product` | ❌ |

## 取证（重建前，`govio-cli query` 实测）

| 实体 | 真实数量 | 图库实际 | 说明 |
|---|---|---|---|
| PhysicalTable | 13（chocolate 4 + sales 5 + 旧 chocolate 4） | 13 | chocolate 部分 2×，sales 批次只有两段式一套 |
| Col | 106 | 123 | 旧 chocolate 17 列重复 |
| HAS_COLUMN | 106 | 123 | — |
| OWNS | 9 | 4 | 仅三段式那套被 `chocolate` 数据源拥有 |
| Metric | 6 | 6 | 节点不重复 |
| USES_TABLE | 4 | 8 | 每个指标同时指向两套 `fact_sales` |
| REFERS_COLUMN | 19 | 38 | 每条列引用同时指向两套 Col |
| RELATES_TO | 3 | 6 | 两套各 3 条 |
| Dimension / DIMENSION_USED / DERIVED_FROM | 5 / 21 / 4 | 5 / 21 / 4 | 无重复 |

同一套内部无重复列（每个 `full_table_name` 下列名唯一）→ 属「两套命名并存」，不是「同批导了两遍」。

## 根因

节点 id = `类型前缀 + SHA256(业务键)`，`PhysicalTable` 业务键即 `full_table_name`：

- 历史导入用两段式 `schema.table`（`docs/specs/11-datasource-schema-conventions.md` 第 50 行曾如此记载，已修正）；
- 现行 CLI（`govio-meta` skill「命名语义」）产出 `<datasource_name>.<schema>.<table>`；
- `meta graph --mode update` 是 MERGE 增量，**只 upsert 不删旧键** → 旧命名节点永久残留，且指标/关系边按旧键再挂一份。

## 处理

1. 备份图库：`C:\Users\Administrator\.govio\ontology.lbdb.bak-20261108171959`。
2. CSV 唯一事实源收敛到 `./data/meta`（gitignore，仅本机状态），全部由 CLI 子命令生成，未手写：
   ```bash
   govio-cli meta meta --source duckdb --db "D:/Work/gov-io/govio/data/chocolate.db" --schemas chocolate --datasource chocolate --output ./data/meta
   govio-cli meta meta --source duckdb --db "D:/Work/gov-io/data/sales.duckdb" --schemas sales --datasource sales --output ./data/meta
   govio-cli meta metric --file "D:/Work/gov-io/govio/data/chocolate_metrics.normalized.json" --output ./data/meta
   govio-cli meta rel --file "D:/Work/gov-io/govio/data/chocolate_relationships.normalized.json" --output ./data/meta
   ```
   > 指标/关系输入必须用 `*.normalized.json`——原始 `chocolate_metrics.json` / `chocolate_relationships.json` 内是两段式表名，会再制造旧键。
3. 重建前 CSV 去重审计（全绿）：9 表 / 106 列 / 6 指标 / 5 维度 / 3 关系；`full_table_name`、`(表,列)`、`Metric.code`、`Dimension.code`、各边行均无重复；所有边端点都能在 `PhysicalTable.csv` 找到。
4. 全量重建：
   ```bash
   govio-cli meta graph --output ./data/meta --mode rebuild
   ```

## 重建后验证

| 项 | 值 |
|---|---|
| PhysicalTable | 9（`chocolate.chocolate.*` 4 + `sales.sales.*` 5） |
| Col / HAS_COLUMN | 106 / 106 |
| Datasource / OWNS | 2（chocolate 4 + sales 5）/ 9 |
| Metric / Dimension | 6 / 5 |
| RELATES_TO / USES_TABLE / REFERS_COLUMN | 3 / 4 / 19 |
| DIMENSION_USED / DERIVED_FROM | 21 / 4 |
| 旧两段式节点残留 | 0 |
| `import-report.json` | `summary.status = pass`（重复 node_id / 缺失必填 / 孤儿边均为 0），`added 251 / skipped 60` |

## 连带变更

- `sales` 数据源本轮首次按现行口径重导，命名从 `sales.order_items`（两段式）变为 `sales.sales.order_items`（三段式）；SQL 引用本就应写三段式（库名 `sales` = catalog，schema 也是 `sales`），旧两段式同样二义。
- 图库无 `Application` / `USE` 边（旧 CSV 目录 `D:/Work/gov-io/govio/data/meta` 里的 `Application.csv` / `USE.csv` 从未进本图库），本次重建不涉及丢失。
- `docs/specs/11-datasource-schema-conventions.md` 已同步为三段式口径，并记录「口径变更必须 rebuild，update 收敛不了」。
- `server/extensions/govio-canvas.ts` 的 `govio_create_source_table.qualifiedName` 描述同步为三段式。
- `spawn` 侧无需改代码：`server/prompt-injection.ts` 的表键匹配本就兼容 2↔3 段式（BUGFIX-injection-graph-key）。

## 遗留

1. ~~旧 CSV 目录清理~~（已执行 2026-11-08）：`D:/Work/gov-io/govio/data/meta`（旧两段式集，含 `Application.csv`/`Standard.csv`/`USE.csv`）与 `data/meta-rebuild` 已删除（两目录均 gitignore / 未跟踪，govio 仓工作区无变更）。删除前把 CLI 无法重建的三项归档到 `govio-map/data/meta-legacy-app/`（`Application.csv` 1 行、`Standard.csv` 0 行、`USE.csv` 4 条边）；其余均可由 `meta meta` / `meta metric` / `meta rel` 从源库与 `*.normalized.json` 重出。现在唯一事实源 = `govio-map/data/meta`（删除后图库复测：PT=9、Col=106、三段式表 9/9）。
   注：`govio/tests/regression/data/graph_csv/` 是测试夹具，不在清理范围。
2. 无 `Application`/`USE` 导入子命令，应用系统归属维度当前无法从 CLI 重建；若需要该维度，需 CLI 侧补子命令。
3. `meta graph --mode update` 不删旧键的行为仍在：今后任何命名口径调整都必须显式 `rebuild`。
