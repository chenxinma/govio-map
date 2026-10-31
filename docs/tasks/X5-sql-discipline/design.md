# X5 设计：SQL 生成纪律与 CLI 输出契约加固

> 任务：docs/task-plan.json crossCutting X5 · 分支 feature/phase2-semantic-layer · 前置 T2.0（已验收）
> 动机：docs/tasks/BUGFIX-load-parse.md（盲猜限定名三次试错 + jq 摘要抹掉 success:false，固化错误 SQL）
> 关联：docs/specs/11-datasource-schema-conventions.md · docs/tasks/CLI-cross-schema-analysis.md（P1 两条落地于本任务）

## 1. 问题与目标

BUGFIX-load-parse 的根因链有两段：**生成端**——agent 不知道表的全限定名，向 CLI 盲试三段变体；
**解析端**——失败输出被摘要管道投影成全 null 后，三处消费方（handleLoadResult / parseLoadOutput /
execute-sql）各自手写的形状判断口径不一、无正式契约，字段改名或形状漂移只能靠运行时暴露。T2.0 已把
qualifiedName/datasourceType 固化进 sourceTable 节点；X5 补上剩余三块：

1. 项目级提示词把「表引用必须取 qualifiedName」等纪律写成硬规则（AGENTS.md，pi 会话作为项目指令加载）；
2. jq 摘要配方保留失败信号（`{success, error, name, rows, columns}`），旧配方 `{name, rows, columns}` 是诱因之一；
3. ObserveLoadOutput 共享 schema 校验器（typebox），一处定义、三处消费。

## 2. SQL 生成纪律（AGENTS.md 新章节）

位置：`## Govio Skills 同步` 之后、`## Commands` 之前，共 6 条硬规则：

| 条 | 规则 | 依据 |
|---|---|---|
| 1 | 表引用必须取 sourceTable 节点 `qualifiedName`（或图谱/声明的全限定名），禁止猜；缺字段先补查图谱与声明 | specs/11「agent 取值来源分层」 |
| 2 | 各数据源类型限定名规则**引用** specs/11，不重复展开；`unknown`/缺失不得凭类型构造引用名 | 单一事实源，避免两处文档漂移 |
| 3 | Catalog/Binder Error 先查元数据再改 SQL，禁止穷举变体；DuckDB `Did you mean` 提示直接采纳 | BUGFIX 案例第 1、2 次试错均有明确报错可循 |
| 4 | 跨数据源 join 必须两段式：分别 `observe load` 各源，再 `--memory` join；禁止假设单条 SQL 跨 `--datasource` | CLI-cross-schema-analysis 场景 B（CLI 单连接执行，无联邦能力） |
| 5 | jq 摘要配方必须为 `\| jq '{success, error, name, rows, columns}'`，显式禁用旧配方 | 旧配方把失败投影成全 null、抹掉 success:false |
| 6 | 禁止 head/tail/sed 截断 load 输出（既有纪律重申）；控量只用 CLI 参数或 jq 字段投影 | 后端依赖完整 JSON 建节点/固化 Manifest |

范围纪律：**不改用户级 pi 配置/addendum**（用户级 jq 配方文档由主 session 提请用户更新）；不动 CLI 上游、
不动 T2.1 图谱注入。AGENTS.md 是项目级指令，pi 会话每次加载，规则对该项目内所有会话生效。

## 3. 共享 ObserveLoadOutput schema 校验器（server/observe-load-schema.ts）

### 3.1 契约设计（typebox v1）

```
ObserveColumnSchema   { name? column? col? dtype? }        列名三键 Optional 互补（load=name/info=column/历史=col）
ObserveLoadOutputSchema { success? name? rows? columns? column_info? schema? error? message? source_tables? }
```

- **宽松**：全字段 Optional、对象开放额外属性（TypeBox 默认）——CLI 新增输出字段不误杀；
- **null 容忍**：标量/数组字段均为 `T | null` 联合——jq 摘要投影产生的显式 `null` 是**合法形状**，
  必须能通过校验（它「合法但不可信」，见 3.2 的分层）；
- **类型严格**：已知字段类型漂移（`rows: "twelve"`）、非对象 JSON（数组/标量）被 `Value.Check` 拒绝；
- 派生 `ObserveLoadOutput` / `ObserveColumn` TS 类型，三处消费同一类型——CLI 字段改名编译期即报错
  （旧状：govio-canvas `ObserveInfo`、dataframe-rerun `ObserveLoadOutput` 两份手写 interface + parquet-api 裸 `any`）。

导出四个成员：`ObserveLoadOutputSchema`（schema 本体，verify 断言用）、`parseObserveLoadOutput(stdout)`
（JSON.parse + Value.Check，非法 JSON / 形状漂移 → null）、`isLoadFailure(parsed)`（显式 success:false 判定，
类型守卫用交叉型 `parsed is ObserveLoadOutput & { success: false }`——守卫若写成 `parsed is ObserveLoadOutput`，
消费方排除失败分支后会被 TS 收窄成 never）、`observeColumnName(col)`（列名归一，替代三处各自手写的
`name ?? column ?? col ?? "unknown"`）。

### 3.2 与 isTrustworthyLoadOutput 的取舍：**协同，不替代**

两层职责不同，缺一不可：

| 层 | 判定 | 拦截对象 | 拦截后动作 |
|---|---|---|---|
| schema 校验（parseObserveLoadOutput） | 形状合法？ | 非法 JSON（head/tail 截断）、字段类型漂移、非对象输出 | handleLoadResult 回退 ObserveStore 复核；parseLoadOutput/execute-sql 按失败处理 |
| trust 谓词（isTrustworthyLoadOutput） | 语义可信？ | **形状合法但无成功信号**的 jq 全 null 投影（没有 success:false 可拦截） | 同上回退复核 |

jq 全 null 投影 `{"name":null,"rows":null,...}` 是合法 JSON 且通过宽松 schema——若用 schema 校验替代
trust 谓词（例如把 null 从契约里剔除、靠校验失败拦截），会把「CLI 真输出了 null 值字段」与「jq 投影」
混为一谈，且 success:false 载荷同样 schema 合法，仍需独立失败判定。故 `isTrustworthyLoadOutput` 保留在
govio-canvas.ts，**内部逻辑一字未改**，仅参数类型从本地 `ObserveInfo` 换成共享 `ObserveLoadOutput`；
导出契约不变（verify-manifest-roundtrip 的既有导入与 61 项断言原样通过）。

### 3.3 三处消费的接线

- **govio-canvas.ts handleLoadResult**：`JSON.parse` try/catch → `parseObserveLoadOutput`（拒绝时保留
  console.warn 诊断：stdout 长度 + 前 120 字符）；`load && load.success === false` → `isLoadFailure(load)`；
  可信判定与 ObserveStore 回退链路不变。`readObserveInfo` / `mapColumnInfo` 同步换用共享类型与
  `observeColumnName`。
- **dataframe-rerun.ts**：删除本地 `ObserveLoadOutput` interface；parseLoadOutput / extractLoadError 的
  `JSON.parse as` 双写 → `parseObserveLoadOutput` + `isLoadFailure`，映射逻辑不变。
- **parquet-api.ts /api/execute-sql**：load 输出与后续 `observe info` 输出都过 `parseObserveLoadOutput`；
  解析为 null 时 throw（落入既有 catch → 500，与旧 JSON.parse 抛 SyntaxError 同类）；success:false → 400
  透传错误的行为不变；info 列映射改用 `observeColumnName` + `dtype ?? ""`（对齐 mapColumnInfo 容错口径）。

### 3.4 行为变化清单（全部为收紧，且都在五种回归输入之外）

| 输入 | 旧行为 | 新行为 | 说明 |
|---|---|---|---|
| 合法 JSON 但类型漂移（`rows:"twelve"`） | parseLoadOutput 当 0 行成功 | 校验器拒绝 → null → 复跑报「无法解析」 | X5 目标本身（形状漂移被抓住） |
| 合法 JSON 非对象（`5`、`[1,2]`） | parseLoadOutput 当 0 行成功 | 同上拒绝 | 同上 |
| execute-sql 的 info 输出非法 JSON | 500（SyntaxError 文案） | 500（自定义文案） | 状态码同类，文案更明确 |
| handleLoadResult 收到漂移形状 | 不可信 → 回退复核 | 校验拒绝 → 回退复核 | **分类结果相同** |

五种回归输入（jq 全 null / success:false / 截断 / 成功全量 / 成功摘要）的分类判定**逐一断言与现行为一致**
（见 §4），BUGFIX 修复未放松。

## 4. 回归断言（verify-manifest-roundtrip.ts 新增 [6] 节，+26 项 → 87）

放 verify-manifest-roundtrip 而非 verify-source-table：该脚本已承载 isTrustworthyLoadOutput 与
success:false 事件流断言（BUGFIX 回归的既有归属），共享校验器是同一契约面的延伸；verify-rerun-drift
的 parseLoadOutput/extractLoadError 断言（71 项）原样通过，不重复。

五种输入 × 消费方分类矩阵（每格与改前行为逐一对照）：

| 输入 | parse 结果 | isLoadFailure | isTrustworthy | parseLoadOutput | extractLoadError |
|---|---|---|---|---|---|
| jq 全 null 投影 | 合法（null 宽容） | false | **false**（回退复核） | `{0,0,[]}`（保持现行为¹） | null |
| success:false | 合法 | **true** | false | null | 透传 error |
| 截断（非法 JSON） | null | — | false | null | null（通用文案兜底） |
| 成功全量 | 合法 | false | **true** | `{12,2,[product_id,product_name]}` | null |
| 成功 jq 摘要 | 合法 | false | **true** | `{12,2,[]}`（columns 字段兜底） | null |

¹ 复跑路径经 execFile 直连 CLI、不经 jq 管道，生产不会出现该输入；断言只为钉死「分类与现行为一致」。

另加 3 项新能力断言：类型漂移拒绝、非对象 JSON 拒绝、未知额外字段不误杀（宽松契约）。

## 5. 遗留问题

1. **用户级 addendum 的 jq 配方仍是旧的** `{name, rows, columns}`（本任务范围纪律明确不改用户级配置）。
   AGENTS.md 第 5 条已写正确配方并显式禁用旧配方，项目级指令会覆盖会话行为；用户级文档由主 session 提请用户更新。
2. **addReference 引用上下文仍未携带 qualifiedName/datasourceType**（T2.0 design §7.3 标注"属 X5 决策"，
   但 X5 任务书三项范围不含引用载荷改动，且涉及 ws-handler 序列化与前端引用芯片展示，超出本次窄改边界）。
   现状：用户显式引用 sourceTable 节点时 agent 只拿到 `{full_table_name, fields}`；AGENTS.md 第 1 条要求
   agent 缺 qualifiedName 时先补查图谱/声明，纪律可兜底但多一跳。建议单独立小任务。
3. **BUGFIX 两条残留未动**（非本次范围）：失败 load 遇 store 已有同名 DF 的口径校验；存量损坏
   dim_product 节点不自动纠正。
4. **parquet-api execute-sql 未做 trust 复核**：load 形状漂移被拒后走 500，而非像 handleLoadResult 那样
   回退 ObserveStore——SQL 编辑器是同步请求/响应，500 让用户重试即可，无需引入异步复核；维持现状。
5. **schema 契约基于本机 CLI 实测形状**（load: name/rows/columns/column_info/source_tables；info:
   schema[{column,dtype}]）。上游若改字段名，校验器会拒绝而非静默错读（这正是目标），届时单点更新
   observe-load-schema.ts 即可。
