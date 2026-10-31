# BUGFIX：加载 DataFrame 时"observe load 输出无法解析"

## 现象
人工验收时，`govio-cli observe load --name dim_product --datasource chocolate --sql "SELECT product_id, product_name FROM chocolate.chocolate.dim_product"` 命令行执行正常，但前端加载报「observe load 输出无法解析（命令失败或输出被截断）」，复跑同样失败。

## 根因（三段式）
会话 transcript 显示 agent 对 dim_product 连续尝试了三条 SQL：
1. `FROM dim_product` → CLI 返回 `{success:false, error:"Table ... does not exist"}`（退出码 0）
2. `FROM chocolate.dim_product` → `{success:false, error:"Ambiguous reference ..."}`
3. `FROM chocolate.chocolate.dim_product` → `{success:true, rows:12}`

第 1 次尝试的命令带了摘要管道 `2>&1 | jq -c '{name, rows, columns, schema}'`，把失败输出投影成
`{"name":null,"rows":null,"columns":null,"schema":null}`——**合法 JSON，但既无 `success:false` 可拦截，也无任何行/列信息**。

`handleLoadResult` 旧逻辑 `const parsed = load ?? readObserveInfo(...)`：只要 JSON 解析成功就采用，于是把这次**失败加载**当作 0 行成功，建出节点并固化了错误 SQL（`FROM dim_product`，rowCount 0）。第 3 次真正成功的加载又因 dfName 去重（`event.manifest && !dupData.manifest` 只回填缺失、不覆盖）被丢弃，错误 Manifest 一直留存。复跑时用这条错误 SQL → CLI 再次 `success:false` → `parseLoadOutput` 返回 null → 报笼统的「输出无法解析」。

## 修复
- **A（根因）** `server/extensions/govio-canvas.ts`：新增导出谓词 `isTrustworthyLoadOutput(load)`——只有出现真实成功信号（数值型 `rows`、`column_info`/`schema` 数组、或显式 `success:true`）才可信。`handleLoadResult` 改为：可信载荷直接采用，否则回退 `readObserveInfo` 复核，复核不到就不建节点。jq 投影的全 null 失败输出不再被当作 0 行成功。
- **B（可诊断性）** `server/dataframe-rerun.ts`：新增 `extractLoadError(stdout)`，复跑遇到 `success:false` 时透传 CLI 的 `error`/`message`（如「Table dim_product does not exist」），不再统一糊成「输出无法解析」；仅在输出确实非合法 JSON 时才用通用文案。
- **C（同类路径）** `server/parquet-api.ts` `/api/execute-sql`：load 返回 `success:false`（退出码 0）时不再当成功建节点，返回 400 并把 SQL 错误透传给前端。

## 回归断言
- `scripts/verify-manifest-roundtrip.ts`（+6）：`isTrustworthyLoadOutput` 对 jq 全 null / success:false / null / 空对象判不可信，对成功全量载荷与成功 jq 摘要判可信；事件流层面 `success:false` 的 tool_result 不生成节点。
- `scripts/verify-rerun-drift.ts`（+4）：`extractLoadError` 透传 error/message、对非失败输出返回 null；复跑遇 `success:false` → outcome=error 且错误含真实 SQL 原因、不含「无法解析」。
- 全绿：build ✓ · lint 0 error · tsc（含 scripts）exit 0 · verify 聚合 manifest 61 / rerun 71 / audit 97 / export 126。

## 残留（已知，未在本次处理）
- 边角场景：若一条失败 load 的 dfName 恰好**已存在于 ObserveStore**（此前成功加载过同名 DF），回退 `readObserveInfo` 会取到旧存储信息建节点，而 Manifest.sql 是本次失败的 SQL——两者口径可能不一致。真实会话按尝试顺序发生（失败时 store 为空）不触发此路径；如需彻底消除，可在回退分支对"输出不可信但 store 命中"再校验 SQL 一致性。
- 已损坏的历史节点：本次修复防止再次发生，但**已存在的错误 dim_product 节点不会自动纠正**（去重不覆盖）。需在画布上删除该节点后重新加载，或用 SQL 编辑器重跑正确 SQL。
