# BUGFIX-caliber-has-star：乘法被当 `SELECT *` 展开，口径冲突永远报不出来

- **日期**：2026-11-08
- **发现**：演示视频场景 3 实测（承接 BUGFIX-injection-graph-key 修复后）——「用每箱售价乘出货箱数算销售额」生成的 SQL 未亮黄灯
- **现象**：agent 把计算列改名 `calc_sales_amount`（同时保留 `SUM(amount) AS stored_amount` 对照）——改名本身是**正确行为**（主动区分口径），但实测发现即便不改名，`conflict` 也报不出来

## 实测证据（修复前）

`govio-cli sql caliber --metric m_sales_amount` 四档 SQL 全判 `unknown`（UI 对 unknown 不显示任何视觉，`src/utils/caliber.ts`）：

| 形态 | SQL 要点 | 修复前 | 应得 |
|---|---|---|---|
| A | `SUM(price*boxes) AS sales_amount` | unknown | conflict |
| B | `SUM(amount) AS sales_amount`（正确口径） | unknown | consistent |
| C | 不含 amount，仅 `price*boxes` | unknown | conflict |
| D | `AVG(amount) AS sales_amount` | unknown | conflict |

## 根因

**P0（govio）`has_star` 误判乘法**：`facts.has_star = "*" in stripped` 把算术乘号当星号展开，
`_compare_columns` 里「计量列缺失」只能走存疑分支（detail 原文「计量列 amount 未显式引用，
**SQL 含 * 展开**无法确认」），确定分支永不命中 → conflict 不可达。`COUNT(*)` 同样被计入
`has_star`，而本来专用于此的 `has_count_star` 算了却没被任何判定使用。

**P1（govio-map）注入间歇降级**：4 条图谱查询并发，实测单条已约 4.3s，超时阈值 6s，
叠加负载即集体超时 → `graphStatus=degraded` → 图谱实体未注入 → `semanticRefs` 空 →
T2.3 检测静默跳过（会话留痕实证：13:52 `graphError=DIMENSION_USED ... Command failed`）。

**P2（元数据）4 个原子指标 `formula` 为 null**：聚合口径比对只能走中文语义提示（弱证据），
`AVG(amount)` 这类聚合偏差也只能 unknown。

## 修复

| 优先级 | 文件 | 改动 |
|---|---|---|
| P0 | `govio/src/govio/metadata/caliber.py` | 新增 `_has_select_star`：只在 SELECT 列表内识别裸 `*` / `t.*`，按顶层逗号切分 SELECT 项判定；`COUNT(*)` 先替换掉再判定；乘法、字符串字面量、WHERE 内星号均不计入 |
| P0 | 同上 `_compare_columns` | 存疑分支区分原因：`has_star` vs `has_count_star`（`COUNT(*)` 计数对象不可确认保持 unknown），并让 `has_count_star` 真正参与判定 |
| P0 | `govio/tests/test_caliber_compare.py` | 新增 3 组断言：乘法不算星号 / 星号正确识别（`SELECT *`、`DISTINCT *`、`t.*`、`a, *`，WHERE 与字面量内不算）/ 乘法取代计量列应为 conflict |
| P1 | `govio-map/server/graph-query.ts` | `GRAPH_QUERY_TIMEOUT_MS` 6000 → 12000（含注释说明并发实测依据）；测试 mock 同步 |
| P2 | `govio/data/chocolate_metrics.json` | 4 个原子指标补 `formula`：`sum(amount)` / `sum(boxes_shipped)` / `sum(marketing_spend)` / `count(distinct order_id)`；重新 `meta metric` + `meta graph --mode update` 导入 |

## 验证

**CLI 判定（P0+P2 后，真实 CLI）**

| 形态 | 修复后 |
|---|---|
| A `SUM(price*boxes) AS sales_amount` | **conflict**（column 确定） |
| B `SUM(amount) AS sales_amount` | unknown（dimension_ref 存疑噪声，见 PD-2） |
| C 不含 amount | **conflict** |
| D `AVG(amount)` | **conflict**（aggregation + column） |

**map 侧端到端**（`runCaliberCheck` 走真 CLI）：A/C/D → `conflict`，B → `unknown`。

**测试门槛**

- govio：`pytest tests/` → **429 passed, 18 skipped**（新增 3 用例全绿）
- govio-map：`npm run build` / `npm run lint` / `npm run verify` 全绿零回归
  （manifest 119 / export 126 / source-table 39 / semantic-lineage 45 / prompt-injection 53/53 / 集成 59/59）

**环境动作**：`uv build` + `uv tool install --force govio --from dist/govio-0.7.1-py3-none-any.whl`，
使 P0 修复在当前演示环境生效（版本号仍 0.7.1，未发新版）

## 遗留问题

1. **别名可绕过**：保留 `SUM(amount)` 做对照、把计算列改名 `calc_*` 时判 unknown——
   口径比对按「列是否出现在 SQL」而非「输出列别名对应哪个表达式」。已记 **PD-2**（待讨论）
2. **存疑噪声**：`dimension_ref` 列缺失一律产出 `column` 存疑项，令「正确口径」也只能是 unknown
   而非 consistent，状态信号被稀释。同见 **PD-2**
3. **unknown 静默**：UI 按设计不显示 unknown，用户无法从界面区分「比对通过」与「比对不确定」。
   同见 **PD-2** 第 4 项
4. 本次为本地重装 CLI，未发版；正式发版需在 govio 仓 bump 版本（并把 `MIN_GOVIO_CLI_VERSION` 抬到新版）
5. govio 仓 `.venv` 的 ladybug 存储版本（v43）落后于当前图库文件（v49），仓内 CLI 直连图库会报
   `different version`；本次 CLI 行为验证走 uv tool 安装版（已用本地 wheel 重装），仓 venv 需另行 `uv sync`
