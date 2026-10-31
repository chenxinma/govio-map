# T2.0 变更清单（CHANGES）

## 代码

| 文件 | 变更 |
|------|------|
| `src/types/index.ts` | 新增 `DATASOURCE_TYPES` 常量数组（单一事实源）与派生联合类型 `DatasourceType`（duckdb/postgres/mysql/oracle/hive/trino/sqlalchemy-generic/unknown）；`SourceTableNodeData` 新增可选字段 `datasource/datasourceType/schema/qualifiedName`，字段级注释写明取值来源与缺省语义（旧节点 undefined，UI 回退） |
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent` sourceTable 段新增同名可选字段（`datasourceType` 引用 `src/types` 的联合类型），注释指向字段语义出处 |
| `server/extensions/govio-canvas.ts` | `govio_create_source_table` 参数扩展（4 个全 Optional，required 仍只有 tableName/fields）；description 增加取值来源分层指导（图谱 Datasource/PhysicalTable、声明文件 source_type、config.yaml url scheme）、duckdb 三段式/postgres/mysql 引用规则、"NEVER guessed / 拿不到就 OMIT"；新增 `normalizeDatasourceType`（枚举外取值如 tds 丢弃不落盘）；execute 条件展开透传新字段，回执附 `qualified: <值>` |
| `src/services/canvas-service.ts` | `CanvasEvent` 新增 4 个可选字段（ws-handler 广播为原样 spread，无需改 server） |
| `src/store/canvas-store.ts` | `createGovioNode` sourceTable 分支条件展开写入 4 个新字段（缺失不写键，旧事件形状不变） |
| `src/components/Nodes/SourceTableNode.tsx` | 头部新增 datasourceType 徽标（node-source 紫色、等宽大写，tooltip 带 datasource 名）；头部与字段列表间新增 qualifiedName 行（等宽 truncate + title 提示 + Copy/Check 一键复制，1.5s 复位，stopPropagation）；两者字段缺失时均不渲染 |

## 验证

| 文件 | 变更 |
|------|------|
| `scripts/verify-source-table.ts` | 新增（39 断言）：工具契约（Optional/description 指导/枚举）→ stub pi 驱动 execute → 事件透传（含 tds 丢弃、旧调用不建键）→ ws 广播 JSON → store 写入 → saveCanvas/loadCanvas 往返 → hydrateSession；每段含旧节点兼容断言 |
| `package.json` | 新增 `verify:source-table`；`verify` 聚合追加该脚本 |

## 文档

| 文件 | 变更 |
|------|------|
| `docs/specs/11-datasource-schema-conventions.md` | 新增：CLI 权威依据（datasource.py qualify/resolve_datasource/source_type 枚举；database.py duckdb:// vs SQLAlchemy）、术语区分（datasource 名 / 元数据全限定标识 / SQL 引用名）、各类型 SQL 引用规则表、chocolate 三次试错实证与报错对照表、agent 取值来源分层（图谱→声明→省略，禁止猜测）、与画布节点的契约（qualifiedName 为 SQL 表引用唯一权威，提示词落地属 X5） |
| `docs/specs/02-nodes.md` | SourceTableNodeData 字段表补 4 个 T2.0 可选字段 + 指向 specs/11；SourceTableNode 详情布局补徽标与全限定名行（含回退语义） |
| `docs/task-plan.json` | T2.0 status pending → in_progress → done，history 两条，顶层 updatedAt 刷新 |

## 明确不改（范围纪律）

- dataframe/manifest/rerun/permission 逻辑零改动（verify 聚合 61/71/97/126 无回归）
- CLI 上游不动；`.agents/skills/` 运行时副本不动（assets 缺失记入 design.md 遗留问题）
- X5 提示词/jq 配方不动；`addReference` 引用载荷不动（qualifiedName 是否入引用上下文留 X5 决策）
