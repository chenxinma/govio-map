# X5 变更清单：SQL 生成纪律与 CLI 输出契约加固

> 设计见 design.md · 验证见 verification.md · 分支 feature/phase2-semantic-layer

## 新增

### server/observe-load-schema.ts（共享契约，一处定义）
- `ObserveColumnSchema` / `ObserveLoadOutputSchema`：typebox v1 定义的 `observe load` / `observe info`
  输出 schema。宽松契约：九字段（success/name/rows/columns/column_info/schema/error/message/source_tables）
  全 Optional、标量/数组 null 容忍（jq 摘要投影是合法形状）、对象开放额外属性（CLI 新增字段不误杀）；
  已知字段类型漂移与非对象 JSON 被拒。
- `ObserveLoadOutput` / `ObserveColumn`：schema 派生 TS 类型（替代此前两份手写 interface + 一处裸 any）。
- `parseObserveLoadOutput(stdout)`：JSON.parse + Value.Check；非法 JSON / 形状漂移 → null。
- `isLoadFailure(parsed)`：显式 `success:false` 判定；类型守卫用交叉型避免 false 分支被收窄成 never。
- `observeColumnName(col)`：列名三键（name/column/col）归一，替代三处手写容错。

## 修改

### AGENTS.md（项目级提示词，pi 会话加载）
- 新增 `## SQL 生成纪律` 章节（6 条硬规则）：① 表引用必须取 sourceTable.qualifiedName，禁止猜、缺则先
  补查图谱/声明；② 各数据源限定名规则引用 docs/specs/11（不重复展开），unknown 不得凭类型构造；
  ③ Catalog/Binder Error 先查元数据再改 SQL，禁止穷举变体，采纳 DuckDB `Did you mean` 提示；
  ④ 跨数据源 join 必须两段式（分别 observe load + --memory join），禁止假设单条 SQL 跨 --datasource；
  ⑤ jq 摘要配方必须为 `| jq '{success, error, name, rows, columns}'`，显式禁用旧配方 `{name, rows, columns}`
  （会抹掉 success:false）；⑥ 重申禁止 head/tail/sed 截断 load 输出。
- 不改用户级 pi 配置/addendum（范围纪律；用户级 jq 配方由主 session 提请用户更新）。

### server/extensions/govio-canvas.ts（消费方 1）
- 删除本地 `interface ObserveInfo`，改用共享 `ObserveLoadOutput` 类型。
- `handleLoadResult`：`JSON.parse` try/catch → `parseObserveLoadOutput`（拒绝时 console.warn 保留诊断：
  stdout 长度 + 前 120 字符）；`load && load.success === false` → `isLoadFailure(load)`；
  可信判定 + ObserveStore 回退链路不变。
- `readObserveInfo`：JSON.parse → parseObserveLoadOutput（info 输出同走契约校验）。
- `mapColumnInfo`：参数改 `ObserveColumn[]`，列名走 `observeColumnName`，`dtype ?? ""`。
- `isTrustworthyLoadOutput`：**内部逻辑一字未改**，仅参数类型换为共享类型；导出契约不变
  （取舍理由见 design.md §3.2：schema 管形状合法，trust 谓词管语义可信，两层协同）。

### server/dataframe-rerun.ts（消费方 2）
- 删除本地 `interface ObserveLoadOutput`，改用共享类型。
- `parseLoadOutput` / `extractLoadError`：`JSON.parse as` 双写 → `parseObserveLoadOutput` + `isLoadFailure`；
  行/列映射与错误透传逻辑不变（列名归一走 `observeColumnName`）。

### server/parquet-api.ts（消费方 3，/api/execute-sql）
- load 输出与后续 `observe info` 输出都过 `parseObserveLoadOutput`；解析 null → throw（落既有 catch → 500，
  与旧 JSON.parse 抛 SyntaxError 同类，文案更明确）。
- success:false → 400 透传 SQL 错误的行为不变（改用 `isLoadFailure`）。
- info 列映射：`col.column` 直读 → `observeColumnName(col)` + `dtype ?? ""`（对齐 mapColumnInfo 容错口径）。

### scripts/verify-manifest-roundtrip.ts（回归断言）
- 新增 `[6] 共享校验器（observe-load-schema）五种输入分类回归`：26 项断言，覆盖
  jq 全 null 投影 / success:false / 截断输出 / 成功全量 / 成功摘要五种输入在
  parse·isLoadFailure·isTrustworthy·parseLoadOutput·extractLoadError 上的分类判定与现行为完全一致
  （矩阵见 design.md §4），另加类型漂移拒绝、非对象拒绝、额外字段不误杀 3 项新能力断言。
- 61 → 87 项，既有断言零改动。

### docs/task-plan.json
- crossCutting X5：pending → in_progress → done（history 两条，by:"worker"）；顶层 updatedAt 刷新。

## 不改（范围纪律）
- 用户级 pi 配置/addendum、CLI 上游、T2.1 图谱注入、canvas-store/ws-handler/前端组件。
- isTrustworthyLoadOutput 判定逻辑、五种输入的生产行为（收紧仅发生在漂移形状等回归输入之外，清单见 design.md §3.4）。
