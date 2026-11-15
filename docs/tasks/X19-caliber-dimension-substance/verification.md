# X19-W5b 验证记录（map 侧消费收尾）

## 1. 所用 govio 版本与 commit

| 项 | 值 |
|---|---|
| 交付 commit | `c621de90871f6422d4761cdc12794a57a0e82609`（`feat(caliber): 维度限定条件升级为结构化实质比对（X19-W5a）`，2026-11-14 12:24 +08:00） |
| PR / 合并 | govio PR #24 → merge `a92a291`（2026-11-14，用户合并） |
| 算法事实源 | govio `src/govio/metadata/caliber.py`（`c621de9` 版）：`_diff`(589)、`_values_desc`(1010)、`_dim_requirements`(1015)、`_compare_dimensions`(1073)、`_compare_time_grain`(1246)、`compare_metric`(1272) |
| 设计事实源 | govio `docs/tasks/X19-caliber-dimension-substance/design.md`（判定矩阵 §3、降噪 §4、time_scope 核查 §5、与方案 C 界限 §6、遗留 8 条 §7、契约与合并顺序 §8、8 档实测 §9） |
| 本机 `govio-cli` | `govio 0.7.2`（`C:/Users/Administrator/.local/bin/govio-cli.exe`）；安装产物 `…/uv/tools/govio/Lib/site-packages/govio/metadata/caliber.py` 共 808 行、`grep -c dim_predicates` = **0** → **未含 W5a** |

因本机 CLI 仍是 0.7.2 发布产物（W5a 未发版），按任务书纪律**不重建/不安装 govio**，
8 档判定引用 govio 侧测试断言，真实 CLI 输出标「待发版补录」（§3）。

## 2. govio 侧证据（只读引用）

- `tests/test_caliber_dimension_compare.py`（`c621de9`，**42 例**）分段：
  - 三元组解析 11 例（等值/IN/LIKE/BETWEEN/`IS NULL`/子查询/参数占位/列间等值/`OR` 组展开/
    `NOT (...)` 丢弃/`GROUP BY 1`）
  - 维度声明生成 6 例（`usage_type=filter|slice` 为显式限定、`group` 需正向线索词、
    无枚举即无声明、短数字枚举不作证据）
  - 判定矩阵 14 例（覆盖 §2 表 #1-#11 与时间粒度 T1-T3）
  - 「不误报」反例 3 例（不可归属列 / 限定在子查询里 / 实质证据与 aspect 稳定性）
  - PD-2 8 档 3 例（`test_pd2_eight_samples_match_expectation`、
    `test_pd2_samples_after_are_declared_expectations`、
    `test_pd2_dimension_aspect_does_not_dilute_correct_caliber`）
  - 维度声明读取 3 例（networkx / cypher / 读取失败降级为无声明）
  - **输出契约 1 例**（`test_output_contract_unchanged_for_dimension_conflict`：
    键集合 ⊆ `{aspect, expected, found, detail}`、`status` ∈ 三态、维度差异 `aspect == "filter"`）
- govio 全量测试（W5a 验收复跑）：`pytest` 526 passed / 18 skipped，`ruff check`/`format --check` 0。
- map 侧独立复核（本任务，只读扫描 `c621de9` 版 caliber.py 全部 `_diff(` 调用点）：
  实际产出 aspect = `aggregation, column, filter, sql, time_scope` → 与
  `CALIBER_ASPECT_LABELS`（`src/utils/caliber.ts:20`，含历史 `metric`）取并集无缺口 → **零改动成立**。

## 3. 8 档样本逐档判定记录

SQL 与判定取自 govio `tests/test_caliber_dimension_compare.py` 的 `PD2_SAMPLES`
与 govio design.md §9；「真实 CLI」列为待发版补录（本机 CLI 无 W5a）。

| 档 | SQL 要点 | SQL（用例原文，节选） | 改动前 | 改动后（govio 断言） | 真实 CLI | map 侧对应断言 |
|---|---|---|---|---|---|---|
| s1 | 乘法别名冒充口径 | `SELECT country_id, SUM(price_per_box * boxes_shipped) AS sales_amount FROM fact_sales GROUP BY country_id` | conflict | **conflict** ✓（aggregation + column） | 待发版补录 | 「维度存疑 + 聚合冲突共存 → conflict 优先」 |
| s2 | 正确口径（ROUND 包装 + 国家分组） | `SELECT c.country_name, ROUND(SUM(f.amount), 2) AS revenue_amount FROM fact_sales f JOIN dim_country c … GROUP BY 1` | unknown | **consistent** ✓（#10/#1 无声明要求即不产条目） | 待发版补录 | 「无维度声明不产条目：consistent 且 differences 空」「维度无声明（consistent）→ 建键但零条目」 |
| s3 | 不含 amount 的其它金额列 | `SELECT SUM(total_price) AS sales_amount FROM fact_orders` | conflict | **conflict** ✓ | 待发版补录 | 同 s1 |
| s4 | AVG 取代 SUM | `SELECT AVG(amount) FROM fact_sales` | conflict | **conflict** ✓ | 待发版补录 | 同 s1 |
| t1 | AVG 改名 revenue_calc | `SELECT AVG(amount) AS revenue_calc FROM fact_sales` | conflict | **conflict** ✓ | 待发版补录 | 同 s1 |
| t2 | 正确口径（同 s2 第二轮） | `SELECT ROUND(SUM(f.amount), 2) AS revenue_amount FROM fact_sales f` | unknown | **consistent** ✓ | 待发版补录 | 同 s2 |
| t3 | 不含 amount（第二轮） | `SELECT SUM(net_amount) AS revenue FROM fact_sales` | conflict | **conflict** ✓ | 待发版补录 | 同 s1 |
| t4 | 算术修饰 amount | `SELECT ROUND(SUM(f.amount * (1 - f.discount_pct / 100)), 2) AS revenue_calc FROM fact_sales f` | conflict | **conflict** ✓（聚合参数表达式） | 待发版补录 | 同 s1 |

结论：s2/t2 `unknown → consistent`、t4 仍 conflict、s1/s3/s4/t1/t3 conflict 零回归——
与 acceptance 第 1 条的预期表一致；「无别名启发式」由 govio 侧 grep 与反例测试锁定（design.md §6）。

## 4. map 侧 stub 断言增量（46 → 77，+31）

`npm run verify:caliber-conflict`：**77/77 checks passed**（基线 46 项逐条零回归）。
新增 31 项按 acceptance 三组归类：

- **三态透传与展示映射（22 项）**
  - [2b] 10 项：实质矛盾汇总 conflict；解析结果与期望对象深度相等；aspect 复用 `filter`；
    三元组取值逐字透传（`expected="'中国'"` / `found="c.country_name = '德国'"`）；
    存疑不误报（只有存疑条目 → unknown）；unknown 下两条条目不丢不合并；无声明不产条目；
    时间粒度差异走 `time_scope` 且判 conflict；维度存疑 + 聚合冲突共存 conflict 优先；
    维度差异形状非法同受形状纪律约束（该条计入降级组见下）
  - [3] 2 项：`runCaliberCheck` 维度 conflict 成功透传（深度相等）、维度存疑透传不升级
  - [4] 3 项：message_end 事件维度 conflict 深度相等；维度存疑事件仍建键且条目/ reason 完整；
    维度无声明建键但零条目
  - [5] 1 项：维度事件经 WS JSON → `createGovioNode` → `node.data.caliberCheck` 深度相等
  - [6] 1 项：sidecar `saveCanvas → loadCanvas` 往返后维度条目与 reason 完整保留
  - [7] 5 项：W5a 实际产出 aspect 全部已有展示名；`filter`=「过滤/统计范围」且
    `time_scope`=「时间窗」；维度 conflict 亮警示 + 徽标 + 同一警示色；维度存疑不打扰；
    维度 consistent 不打扰
- **降级路径补强（6 项）**
  - [2b] 1 项：维度差异条目缺 `found` → `undefined`（省略键）
  - [3] 3 项：空输出 → undefined；空 `results` → undefined（不建空 check）；差异形状非法 → undefined
  - [4] 2 项：空输出 / 空 `results` → 省略 `caliberCheck` 键**且不阻断建节点**（`events.length === 1`）
- **reason 文案可读性（3 项）**
  - [2b]：维度 conflict 的 `detail` 原样保留不被改写；全部维度条目 `detail` 非空；
    conflict 与存疑文案可区分（「实质矛盾」 vs 存疑措辞）

降级契约的「空 differences」二分口径（省略键 vs 保留键零条目）见 design.md §7。

## 5. 验证门槛执行记录

| 命令 | 结果 |
|---|---|
| `npm run build` | 退出 0（`tsc -b` 四个 project + vite build + esbuild server；仅既有 chunk 体积告警） |
| `npm run lint` | 退出 0（`eslint .` 无输出） |
| `npm run verify:caliber-conflict` | `77/77 checks passed` |
| `npm run verify` | 全绿：脚本断言合计 **655**（基线 624 + 31）；`vitest` 15 文件 194 例；UI 4 文件 31 例 |
| `git status --porcelain`（verify 全跑后） | 干净（dist/ 与 node_modules 均被 gitignore） |

`npm run verify` 各脚本小结（合计 655）：manifest 92 / rerun 71 / audit 119 / export 138 /
source-table 39 / semantic-lineage 48 / **caliber-conflict 77** / cwd 13 / prompt-injection 58，
其后为 `verify:integration`（194 例）与 `verify:ui`（31 例）。

基线对照口径：只对照派发时分支点 **624 / 15 文件 194 例 / 4 文件 31 例** + 本任务增量。
PR #36/#37/#38/#39 的 merged 态数字（210/215/219 例）不在本任务范围内，合并顺序由主会话协调。

## 6. 运行时代码改动清单

零改动。本任务只动验证脚本与文档：

- `server/caliber-check.ts`：未改（契约未变，§4 of design.md）
- `src/utils/caliber.ts`：未改（`CALIBER_ASPECT_LABELS` 已覆盖 W5a 全部 aspect）
- `src/components/Nodes/SQLQueryNode.tsx`：未改（警示区现状已覆盖维度条目与 reason，且 X18 PR #39 在改同文件）
- `src/types/semantic.ts` / `server/extensions/govio-canvas.ts` / `lineage.ts` / `PROTOCOL_VERSION`：未改