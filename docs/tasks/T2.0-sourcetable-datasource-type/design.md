# T2.0 设计：SourceTable 数据源类型与 schema 标注约定

> 任务：docs/task-plan.json phases[1] T2.0 · 分支 feature/phase2-semantic-layer
> 动机：docs/tasks/BUGFIX-load-parse.md（agent 盲猜表名三次试错）· 前置分析：docs/tasks/CLI-cross-schema-analysis.md

## 1. 问题与目标

sourceTable 节点此前只有 `tableName/database/fields(/rowCount)`：既没有数据源类型，也没有 SQL 应使用的
全限定名。agent 拿到节点上下文后不知道该用几段式引用表，只能向 CLI 盲试（chocolate 案例：裸名 does not
exist → 两段 Ambiguous → 三段成功）。目标：把类型信息固化进节点（可选字段，旧节点完全兼容），并建立
各数据源类型的 schema 标注约定文档（docs/specs/11-datasource-schema-conventions.md）。

## 2. 数据模型

`src/types/index.ts`：

- `DATASOURCE_TYPES` 常量数组（单一事实源）：`duckdb / postgres / mysql / oracle / hive / trino /
  sqlalchemy-generic / unknown`；`DatasourceType` 由它派生。前六个对应 CLI `DatasourceDef.source_type`
  枚举（govio/metadata/datasource.py）；`sqlalchemy-generic` 覆盖"observe 走 SQLAlchemy 但类型判不了"；
  `unknown` 覆盖"确认有数据源但类型未知"。
- `SourceTableNodeData` 新增四个**可选**字段：`datasource`（observe config.yaml datasources 键）、
  `datasourceType`、`schema`（图谱 PhysicalTable.schema）、`qualifiedName`（SQL 引用名）。每个字段有
  字段级注释写明取值来源与缺省语义。

兼容决策：**缺失时不写键**（而非写 `undefined`/空串）。与 `database` 的历史兜底（`|| ""`）不同，新字段
用条件展开 `...(v ? { k: v } : {})`——旧节点、旧事件、旧 sidecar 的形状一个键都不多，UI 以键存在与否
决定回退，`verify-source-table.ts` 用 `!("qualifiedName" in data)` 断言。

## 3. 事件链贯通（对照 dataFrame manifest 的贯通方式）

```
govio_create_source_table(工具参数, 全 Optional)
  → pushGovioNode(GovioNodeCreateEvent + datasource/datasourceType/schema/qualifiedName)   [server/govio-node-queue.ts]
  → ws.send({type:"govio_node_create", ...node})                                            [server/ws-handler.ts:525, 原样 spread, 无需改]
  → CanvasEvent（同名可选字段）                                                              [src/services/canvas-service.ts]
  → createGovioNode 条件展开写入 node.data                                                   [src/store/canvas-store.ts]
  → canvas_save → sidecar → loadCanvas → hydrateSession（node.data 整体走，无需改）
```

工具端加了一层 `normalizeDatasourceType`：值不在 `DATASOURCE_TYPES` 联合内（如 CLI 开放枚举里的 `tds`）
时**丢弃该字段**而非落盘任意字符串——节点契约保持封闭联合，宁可省略不造值。execute 回执附带
`qualified: <值>`，agent 可确认落盘的限定名。

## 4. agent 取值来源分层（图谱 vs 声明文件 vs 省略）

设计原则：**禁止猜测，拿不到就省略**。工具 description 与参数 description、specs/11 均按同一分层表述：

| 层 | 来源 | 能拿到什么 | 本机实证 |
|---|---|---|---|
| 1. 图谱 | `govio-cli query` PhysicalTable / Datasource 节点 | `PhysicalTable.schema`、`full_table_name`（两段式 `schema.table`）；`Datasource.datasource_name/source_type`（若已 meta 导入） | `full_table_name="chocolate.dim_product"`、`schema="chocolate"`（实测）；**Datasource 节点不存在**（`MATCH (d:Datasource)` 报 Binder exception: Table Datasource does not exist） |
| 2. 声明/配置 | 元数据侧 datasource 声明文件（datasource_schema.json 校验，含 `source_type`）；observe `config.yaml` datasources url scheme | 类型（`duckdb://` → duckdb；其他 SQLAlchemy URL 能判则判，判不了 `sqlalchemy-generic`）；duckdb catalog 段（url 库文件名） | config.yaml：chocolate/sales 均为 `duckdb://` 文件库 |
| 3. 省略 | — | 字段不落键，UI 回退旧显示，agent 不得构造 SQL 引用名 | — |

取舍说明：

- **图谱优先但不充分**：本机图库 schema（上游 skills 的 assets/schema.md：Dimension/PhysicalTable/Col/
  Application/Metric/Standard 六类节点）没有 Datasource；PhysicalTable 也只有两段式 full_table_name。
  因此 duckdb 的三段式 qualifiedName 必须由"层 1 的 schema.table + 层 2 的 catalog（库文件名）"拼出，
  两段来源都有据可查，不属于猜测。CLI 元数据层 `qualify()` 的 `<datasource_name>.<schema>.<table>` 是
  治理口径的全局标识，恰与 duckdb 文件库场景（datasource 名 = catalog 名）同形——specs/11 明确区分了
  两者，避免 postgres 等类型误加 datasource 前缀。
- **不引入运行时探测**：govio-map 侧不新增"读 config.yaml / 查图谱"的服务端逻辑（那会把 CLI 配置耦合
  进画布后端）；取值责任在 agent（有文件系统与 govio-cli），工具只负责校验枚举与透传。上游若落地
  `observe info --datasource` 带 source_type（CLI-cross-schema-analysis P1 建议），agent 取值可再简化，
  节点契约不变。

## 5. UI（SourceTableNode.tsx，Green Deck 令牌）

- **datasourceType 徽标**：头部表名右侧，`bg-node-source/10 text-node-source`（紫色 = sourceTable 类型色，
  与 FK 徽标同款），等宽大写 10px；tooltip 带 datasource 名。缺失不渲染。
- **qualifiedName 行**：头部与字段列表之间独立一行，等宽 11px `text-text-muted` truncate + title 提示
  "SQL 表引用"，右侧复制按钮（Copy/Check 图标切换 1.5s，沿用 WideContentModal 的一键复制模式），
  `stopPropagation` 避免触发画布交互。缺失整行不渲染。
- 不显示 `undefined` 文案：所有新 UI 都以字段存在为渲染条件。

## 6. 验证设计（scripts/verify-source-table.ts，39 断言）

沿 verify-manifest-roundtrip.ts 的 stub-pi 模式，六段：工具契约（required 仍只有 tableName/fields、
description 含来源约束/NEVER guessed/OMIT/三段式规则）→ execute 事件透传（含 tds 丢弃、旧调用不建新键）
→ ws 广播 JSON 形状 → store 写入 → saveCanvas/loadCanvas 往返 → hydrateSession 会话重开；每段都带旧
节点（无新字段）兼容断言。已入 `npm run verify` 聚合。

## 7. 遗留问题

1. **`.agents/skills/govio/` 缺 `assets/`**（schema.md/names/metrics_index 都没有）；AGENTS.md 写的同步源
   `D:/work/python/govio/skills/` 不存在，实际源在 `D:/work/gov-io/govio/skills/`。agent 会话按 SKILL.md
   指引读 `../govio/assets/schema.md` 会落空，只能靠 govio-query SKILL.md 内嵌信息兜底。需按 AGENTS.md
   的手动同步流程用真实上游路径补齐（本任务未动 .agents/，避免把运行时副本变更混进功能提交）。
2. **本机图库无 Datasource 节点**：取值分层第 1 层的 source_type 来源缺位，依赖第 2 层（声明文件/
   config.yaml）。上游执行 `meta meta` 导入（生成 Datasource + OWNS）后第 1 层自动可用，节点契约不变。
3. **addReference 的引用上下文未携带新字段**：`case "sourceTable"` 仍只序列化
   `{full_table_name: tableName, fields}`。用户引用节点后 agent 拿不到 qualifiedName——是否把
   qualifiedName/datasourceType 加进引用载荷，与"SQL 表引用必须取 qualifiedName"的提示词规则一起属 X5
   决策（本任务范围纪律明确不做提示词改动）。
4. **枚举外 source_type（如 `tds`）被丢弃**：字段省略、UI 回退。若治理侧确需展示 tds 等类型，扩展
   `DATASOURCE_TYPES` 即可（单点修改），但需同步 specs/11 的 SQL 引用规则表。
5. **存量损坏节点不回填**：BUGFIX 里固化了错误 SQL 的 dim_product 节点不会被本任务自动纠正/标注
   （与 BUGFIX 文档"残留"节一致：删节点重建或 SQL 编辑器重跑）。
6. **既有显示小瑕疵未动**：rowCount 缺省时头部仍渲染 " rows"（空值 + 单位），属 T2.0 之前行为，
   不在本任务范围。
7. **qualifiedName 无人工编辑入口**：仅 agent 工具写入；人工修正需删节点重建。若验收反馈需要，可在
   节点 UI 加双击编辑（同 SQLQueryNode 模式），留待后续任务。
