# BUGFIX-sql-columns-unicode-and-table-segment：中文别名兜底失效 + 三段式表名取错段

- **日期**：2026-11-14（X22；承接 X19-W5b worker 在其 worktree 内发现并修好的 `94bc841`，
  由主会话移植到 X21 之后的新架构）
- **触发**：用户实测截图里 sqlQuery 节点标题是 `Q: chocolate`；同轮问询「销售额和订单量」时
  输出列/口径显示不全。
- **现象**（两个独立缺陷，叠加时最刺眼）：

  ```sql
  SELECT c.country_name AS 国家,
         SUM(f.amount)              AS 销售额,
         COUNT(DISTINCT f.order_id) AS 订单数
  FROM chocolate.chocolate.fact_sales AS f
  JOIN chocolate.chocolate.dim_country AS c ON f.country_id = c.country_id
  ```

  期望输出列 `["国家","销售额","订单数"]`、标题 `Q: fact_sales`；实际标题 `Q: chocolate`，
  且当 SQL 含 DuckDB 特有语法（`QUALIFY` / `* EXCLUDE` / `GROUP BY ALL`）时输出列退化成 `chocolate.*`。

## 根因 1：兜底正则管道的标识符字符类是 ASCII-only

`3d848de`（BUGFIX-sql-columns-and-graph-cache ①）为消灭 `amount)`、`0)` 碎片，把
`columnNameOf` 的三处标识符匹配收紧成 `[A-Za-z_][A-Za-z0-9_$]*` → 中文别名（`AS 国家`）、
中文隐式别名（`SUM(amount) 总额`）、中文裸列（`SELECT 国家`）全部落空 →
`extractSelectColumns` 返回空数组 → 上层兜底 `[`${tableName}.*`]` 生效。

X21 引入 `node-sql-parser` 主解析后，**中文别名在主路径已正常**（实测
`extractSelectColumns(zhSql)` → `["国家","销售额","订单数"]`），但**兜底管道没同步放宽**：
主解析对 DuckDB 特有语法会失败并回落正则，此时中文别名仍然丢。主会话在 main（`af3dfca`）实测：

| 用例 | 修复前 | 修复后 |
|---|---|---|
| 中文别名（普通 SQL，走 parser） | `["国家","销售额","订单数"]` ✅ | 同 ✅ |
| 中文别名 + `QUALIFY`（走兜底） | `[]` ❌ | `["国家","销售额"]` ✅ |

**修复**（`src/utils/sql-columns.ts`，X21 后 `columnNameOf` 已在此文件）：

- 标识符字符类改为 Unicode 感知 `\p{L}\p{N}_$`（`u` 标志）：新增 `IDENT_SRC` /
  `ALIAS_TOKEN_SRC` / `AS_ALIAS_RE` / `IMPLICIT_ALIAS_RE` / `BARE_COLUMN_RE` 常量，
  `columnNameOf` 三个分支统一改用它们；
- 引号别名补单引号形式（`AS '销售额'`），`stripIdentQuotes` 同步去 `'`；
- 允许别名带非 ASCII 标点尾缀（`销售额（万元）`，全角括号是常见业务命名）；
- 隐式别名分支补 `stripIdentQuotes`（旧实现漏了，引号形式隐式别名会带引号返回）；
- **反垃圾约束保留**：别名 token 内仍禁止 ASCII 括号/引号/方括号/逗号/星号与空白，
  所以 `amount)`、`0)`、`CAST(x AS DECIMAL(18,2))` 不会因放宽而复现（用例已断言）。

## 根因 2：三段式 qualifiedName 取错段（**X21 后仍存在于 main**）

`server/extensions/govio-canvas.ts` 的 `extractTableName` 对 `FROM a.b.c` 取 `parts[1]`：
两段式（`schema.table`）恰好正确，但本仓 qualifiedName 约定是 `datasource.schema.table`
三段式（见 `docs/specs/11-datasource-schema-conventions.md`、X10/`16742f1`），
`chocolate.chocolate.fact_sales` → 取到 **schema 段** `chocolate`，于是：

- 节点标题 `Q: chocolate`（应为 `Q: fact_sales`）——用户截图里就是这个；
- 输出列兜底文本 `chocolate.*`（应为 `fact_sales.*`）。

**修复**：取最后一个非空分段；`FROM` 捕获正则同步 Unicode 感知（`[\p{L}\p{N}_$.]+` + `iu`）。
单段式与两段式行为不变（都取末段 = 表名）。

## 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/integration/select-columns.test.ts` | 18 例通过（14 旧零回归 + 4 新：端到端中文别名、兜底管道中文别名（先断言 `extractSelectColumnsByParser` 返回 null 证明确实走兜底）、中文裸列/隐式别名/全角尾缀/四种引号、放宽后不产碎片） |
| `npx vitest run tests/integration/govio-canvas-extension.test.ts` | +1 端到端：`outputColumns` = `["国家","销售额","订单数"]` 且 `title` = `Q: fact_sales`；`QUALIFY` 兜底路径同样不退化；`SELECT *` 才回退 `fact_sales.*` |
| `npm run build` / `lint` / `verify` | 退出 0 / 0 / 0；脚本断言 671 项不变、vitest 20 文件 273 → **278** 例、UI 4 文件 37 例不变 |

## 影响面与遗留

1. **历史节点**：`outputColumns` 是 message_end 建节点时写入的快照。X21 已让「保存 SQL 时重抽取」
   （`commitSQL`），所以旧节点**编辑并保存一次即自愈**；不编辑则保持旧值（原 worker 文档里的
   「不会自愈」遗留在 X21 后已大幅缓解）。
2. `SELECT *` / `t.*` 仍按设计回退 `表名.*`（不是 bug）；修复后表名取末段，兜底文本也随之正确。
3. 别名含**半角**括号/逗号（如 `AS 收入(元)`）仍不产列名 → 回退兜底。刻意保守：半角括号正是
   历史碎片的特征字符；业务侧建议用全角或引号形式。
4. parser 主路径与兜底管道的能力差（DISTINCT 前缀、子查询项等）仍如 X21 design.md 所述，
   本次只补齐 Unicode 标识符这一项，未扩大兜底能力面。
5. 同车收编：X18 worktree 内未推送的 `17ab411`（记录用户裁决「口径徽标暂时保留 code 显示」，
   纯注释与文档，逻辑零改动）已 cherry-pick 进本 PR。
