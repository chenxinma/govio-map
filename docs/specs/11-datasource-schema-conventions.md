# 数据源类型与 Schema 标注约定

> T2.0（Phase 2 语义层集成）。动机案例：`docs/tasks/BUGFIX-load-parse.md`——agent 对同一张表连试
> `FROM dim_product`（does not exist）→ `FROM chocolate.dim_product`（Ambiguous reference）→
> `FROM chocolate.chocolate.dim_product`（成功），根因之一是 sourceTable 节点此前不携带数据源类型
> 与 SQL 全限定名，agent 无从知道该用几段式引用。跨 schema SQL 的 CLI 侧分析见
> `docs/tasks/CLI-cross-schema-analysis.md`。

## 权威依据（CLI 源码取证，2026-10-31）

- `govio/metadata/datasource.py`
  - `DatasourceDef.source_type`：数据源类型枚举，已知取值 `duckdb/tds/mysql/postgres/oracle/hive/trino`，开放扩展；
  - `qualify(datasource_name, "schema.table")` → `<datasource_name>.<schema>.<table>`：**元数据层**的全局唯一标识（治理口径），不等于 SQL 引用名；
  - `resolve_datasource(schema, datasource_map)`：schema → datasource 反查；声明文件中同一 schema 只能归属一个 datasource；
  - 数据源声明文件（JSON，`datasource_schema.json` 校验）：`datasource_name / source_type / comment / filter{schemas, include_tables, exclude_tables}`。
- `govio/observe_data/core/database.py`
  - `duckdb://` URL → DuckDB 连接（文件形式以 read-only 直连；目录形式 in-memory + `SET file_search_path`）；
  - 其他 URL → `sqlalchemy.create_engine(url)`；
  - `observe load --datasource X --sql "..."` 在**单数据源单连接**内执行，SQL 原样透传——写对限定名是调用方（agent）的责任，CLI 不做改写。

## 术语区分

| 概念 | 含义 | 示例 |
|------|------|------|
| datasource 名 | observe `config.yaml` 的 `datasources` 键，即 `observe load --datasource` 取值；与声明文件 `datasource_name` 同名契约 | `chocolate` |
| 元数据全限定标识 | `qualify()` 输出：`<datasource_name>.<schema>.<table>`，治理层全局唯一 | `chocolate.chocolate.dim_product` |
| SQL 引用名（qualifiedName） | 在执行引擎里唯一定位表的写法，**随 source_type 变化** | duckdb：`chocolate.chocolate.dim_product` |

对 DuckDB 文件库，datasource 名与库文件名（catalog 名）按惯例一致，故 qualifiedName 与 `qualify()` 输出同形；
其他类型两者**不同形**（如 postgres 的 SQL 引用名没有 datasource 前缀），不可混用。

## 各数据源类型的 SQL 表引用规则

| datasourceType | qualifiedName 形式 | 示例 | 说明 |
|---|---|---|---|
| `duckdb` | 三段式 `catalog.schema.table` | `chocolate.chocolate.dim_product` | 文件库 catalog = 库文件名（`chocolate.db` → `chocolate`），取自 observe `config.yaml` 该数据源的 url；`duckdb://` 目录模式（in-memory + file_search_path）下多文件即多 catalog，同理按文件名取 |
| `postgres` | 两段式 `schema.table` | `sales.orders`、`public.orders` | 单连接绑定一个 database，catalog 层不可跨库引用；不要依赖 `search_path`，显式写 schema |
| `mysql` | 裸表名 或 `db.table` | `orders` 或 `shopdb.orders` | 连接 URL 通常已含默认库；显式 `db.table` 更稳 |
| `oracle` | 以声明为准（通常 `SCHEMA.TABLE`） | `HR.EMPLOYEES` | 缺省 schema 为连接用户；大小写以库内实际为准 |
| `hive` / `trino` | 通常两段式 `db.table`（trino 可三段 `catalog.db.table`） | `dw.fact_sales` | 以声明与集群实际为准 |
| `sqlalchemy-generic` | 以声明文件 `filter.schemas` 为准，默认两段式 `schema.table` | — | observe 走 SQLAlchemy 但类型无法进一步判定时使用 |
| `unknown` | **省略 qualifiedName** | — | 确认存在数据源但类型未知；agent 不得凭类型构造 SQL 引用名 |

注意：CLI `source_type` 枚举是开放扩展的（含 `tds` 等）；画布节点的 `datasourceType` 联合类型
（`src/types/index.ts` 的 `DATASOURCE_TYPES`）之外的取值**不落盘**（字段省略），不猜测映射。

## 实证案例：chocolate（本机 DuckDB 文件库）

数据源声明（observe `config.yaml`）：`chocolate: { url: duckdb://D:\Work\gov-io\govio\data\chocolate.db }`。
图谱侧 `PhysicalTable.full_table_name = "chocolate.dim_product"`（两段式 `schema.table`，**不含 catalog**）、
`schema = "chocolate"`（`govio-cli query` 实测）。

`observe load --datasource chocolate` 三次试错对照（2026-10-31 真实会话）：

| SQL 表引用 | CLI 结果 | 原因 |
|---|---|---|
| `FROM dim_product` | `success:false`，`Table ... does not exist` | DuckDB 无默认 schema 命中该表，裸名解析失败 |
| `FROM chocolate.dim_product` | `success:false`，`Ambiguous reference` | 两段式可被解读为 `catalog.table` 或 `schema.table`，恰遇 catalog 与 schema 同名（都叫 chocolate）产生二义 |
| `FROM chocolate.chocolate.dim_product` | `success:true`，`rows:12` | 三段式 `catalog.schema.table` 唯一定位 |

结论：**DuckDB 文件库一律写三段式**。catalog 段来自 config.yaml url 的库文件名，schema 段来自图谱
`PhysicalTable.schema`，两段拼接即 qualifiedName——全部有据可查，无需试错。

## agent 取值来源分层（禁止猜测）

sourceTable 节点四个标注字段（`datasource/datasourceType/schema/qualifiedName`）的取值只能来自：

1. **图谱查询结果**（`govio-cli query`，节点/属性名以 govio skill `assets/schema.md` 为准）：
   - `PhysicalTable` 的 `schema`、`full_table_name`（两段式 `schema.table`）；
   - `Datasource` 节点的 `datasource_name`、`source_type`（仅当图谱已执行 `meta` 导入时存在；本机当前图库无此节点，查询会报 Binder exception——此时跳到第 2 层）。
2. **数据源声明/配置**：
   - 元数据侧 datasource 声明文件的 `source_type`；
   - observe `config.yaml` 的 `datasources.<name>.url` scheme（`duckdb://` → `duckdb`；其他 SQLAlchemy URL 能判定则填对应类型，判不了填 `sqlalchemy-generic`）。
3. **省略**：以上都拿不到就省略该字段（`govio_create_source_table` 的参数全部 Optional，节点 UI 回退旧显示），**不得编造**。

qualifiedName 构造规则：由第 1 层给出 `schema.table`，第 2 层给出类型与 catalog/库名，按上表拼接。
构造不出（类型未知、缺 schema）就省略；agent 写 SQL 遇到 sourceTable 缺 qualifiedName 时，应先补查
图谱与声明，而不是向 CLI 盲试表名。

## 与画布节点的契约

- 节点字段定义见 `docs/specs/02-nodes.md` 的 SourceTableNodeData（四字段全部可选，旧节点无这些字段时 UI 回退旧显示）；
- **agent 写 SQL 时，表引用必须取 `sourceTable.qualifiedName`**；该规则的提示词落地属 X5，不在本文档范围；
- 跨数据源 join 不支持单条 SQL：走两段式加载 + `--memory` join，见 `docs/tasks/CLI-cross-schema-analysis.md` 场景 B。
