# T2.0 验证记录

日期：2026-10-31 · 分支 feature/phase2-semantic-layer · Windows Git Bash

## 门槛命令（全绿）

| 命令 | 结果 |
|------|------|
| `npm run build` | ✓ tsc -b（app/node/scripts 三 project）+ vite build 通过（chunk 体积 warning 为既有） |
| `npm run lint` | ✓ 0 error 0 warning |
| `npm run verify` | ✓ 聚合全绿：manifest **61** / rerun **71** / audit **97** / export **126**（与任务前基线一致，无回归）+ source-table **39** |
| `npm run verify:source-table` | ✓ 39 项断言，失败 0 项 |
| `git status --porcelain`（verify 全跑后） | 干净（验证脚本自建/自删临时目录，无残留） |

## verify-source-table 断言分布（39）

| 段 | 断言数 | 覆盖 |
|----|--------|------|
| [1] 工具契约 | 13 | stub 完整性；required 仍只有 `["tableName","fields"]`（新参数全 Optional）；4 个新参数在 schema；description 含来源分层（Datasource 节点/config.yaml）、NEVER guessed、OMIT、duckdb 三段式 + chocolate 实证、postgres/mysql 规则；DATASOURCE_TYPES 与任务契约枚举一致 |
| [2] execute → 事件 | 12 | 全参数透传 datasource/datasourceType/schema/qualifiedName；原有字段不受影响；回执含 qualified 值；旧参数调用不产生新键；枚举外 `tds` 被丢弃且不影响其余标注字段 |
| [3] ws 广播形状 | 2 | `{type:"govio_node_create", ...event}` JSON 序列化后 4 字段不丢 |
| [4] store 写入 | 5 | node.data 写入 4 字段；旧事件节点不建新键、原字段完整 |
| [5] sidecar 往返 | 3 | saveCanvas→loadCanvas 后标注字段深度相等；旧节点仍无新键 |
| [6] hydrateSession | 4 | 会话重开后 qualifiedName 与 datasource/datasourceType/schema 完整恢复；旧节点兼容 |

## 取证（设计依据，只读）

- CLI `govio/metadata/datasource.py`：`DatasourceDef.source_type`（duckdb/tds/mysql/postgres/oracle/hive/trino，开放扩展）、`qualify()` = `<datasource_name>.<schema>.<table>`、`resolve_datasource()`、声明文件 schema（datasource_schema.json）
- CLI `govio/observe_data/core/database.py`：`duckdb://` → DuckDB 连接（文件 read-only / 目录 in-memory + file_search_path），其他 URL → SQLAlchemy；单连接原样透传 SQL
- 本地图谱实测：`govio-cli query -c "MATCH (t:PhysicalTable) WHERE t.table_name='dim_product' ..."` → `full_table_name="chocolate.dim_product"`（两段式）、`schema="chocolate"`；`MATCH (d:Datasource)` → Binder exception（节点不存在）
- 上游 skills `assets/schema.md`（D:/work/gov-io/govio/skills/govio/assets/）：六类节点，PhysicalTable 属性含 `full_table_name/schema/table_name/database_name`
- 本机 observe `~/.govio/config.yaml`：chocolate/sales 均 `duckdb://` 文件库

## 人工冒烟（dev 环境，可选）

1. 让 agent 查询 chocolate.dim_product 列结构并调用 `govio_create_source_table` 传全 4 个新参数 → 节点头部出现紫色 DUCKDB 徽标，qualifiedName 行显示 `chocolate.chocolate.dim_product`，复制按钮可复制
2. 不传新参数（旧形状调用）→ 节点与 T2.0 之前完全一致，无徽标/无 qualifiedName 行、无 undefined 文案
3. 刷新页面/切换会话 → 标注字段随 canvas sidecar 恢复
