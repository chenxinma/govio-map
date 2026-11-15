# X21 verification

## 1. 主案例前后对比（实跑，2026-11-14）

输入（用户实测案例）：

```sql
SELECT
  SUM(amount)     AS m_sales_amount,  -- 销售额：SUM(amount)
  COUNT(order_id) AS m_order_count    -- 订单数：COUNT(order_id)
FROM chocolate.chocolate.fact_sales;
```

| 管道 | 结果 |
|---|---|
| X21 前（旧正则，逐字复制 HEAD 版本函数跑） | `["m_sales_amount"]` ← 只剩第一列 |
| X21 前（同一条去掉注释） | `["m_sales_amount","m_order_count"]`（复现主会话取证） |
| X21 后 `extractSelectColumns()` | `["m_sales_amount","m_order_count"]` |
| X21 后 `extractSelectColumnsByParser()`（仅主解析） | `["m_sales_amount","m_order_count"]` |

落为断言：`tests/integration/select-columns.test.ts` ›「X21 主案例：行内 -- 注释不吞列（两列全出）」。

## 2. 零回归（旧坏例）

`BUGFIX-sql-columns-and-graph-cache.md` 的 gov-104/105 坏例逐字保留为断言，且新增
`assertNoGarbage()`（任何列名不得以 `)` 结尾、不得含逗号、不得带空白）：
- 「函数内逗号不切碎表达式（ROUND 第二参数不产列名）」✓
- 「真实坏例（gov-105）：不再出现 amount) / 0) 碎片」✓
- 新增「DuckDB 专有写法（* EXCLUDE / GROUP BY ALL）解析失败时也不产垃圾名」✓（两方言 astify 均抛错 → 回落，无碎片）
- 新增「方言不支持（QUALIFY 等）回落正则」：断言 `extractSelectColumnsByParser() === null`
  证明确实走回落，且结果 `["one","two"]` ✓

主解析严格不弱于兜底（同一断言文件里的对照例）：`SELECT DISTINCT a, b` 兜底只剩 `["b"]`、
`(SELECT MAX(y) FROM i) AS m` 兜底漏 `m`、`WITH ... SELECT one` 兜底为空 —— 主解析全部取全 ✓

## 3. 高亮统一

- 分类同源断言（`tests/integration/sql-highlight.test.ts`，9 例）：
  - 行/块注释成 comment，**注释里的 `SELECT`/`FROM` 不再被标成关键词**（旧实现会）
  - `'x'` = string；`"x"` / `` `x` `` / `[x]` = plain（与 lang-sql 的 QuotedIdentifier 口径一致）
  - `chocolate.chocolate.fact_sales.amount` 限定名整体 plain（不冒充关键词）
  - `SQL_KEYWORDS` 60 词逐个断言为 keyword
  - 弹窗侧 `SQL_TOKEN_TAG_KINDS` 产出的 class **全部 ∈ `Object.values(SQL_TOKEN_CLASS)`**，
    且 keyword/string/comment/number 四类都在映射里（两端共用一份 class 调色板）
- 人工目视（待用户复核）：卡片 `<pre>` 与 SQLModal 编辑器对同一条带注释 SQL 的
  关键词/字符串/注释/数字着色是否同一色相；卡片浅底、编辑器 oneDark 深底，明度按背景各调一档。

## 4. 编辑跟手

X21 前：卡片就地编辑与弹窗保存都只写 `{ sql }`，`outputColumns` 保持旧值 → 不跟手（代码取证
`SQLQueryNode.tsx` 原 `handleSave` / `onSave`）。X21 后两条路径统一走 `commitSQL()`：
`await import('../../utils/sql-columns')` → `extractSelectColumns(trimmed)` → 非空才覆盖，
空结果保留服务端给的 `tableName.*` 兜底。`PROTOCOL_VERSION`、store 协议、节点数据形状未动。

## 5. 导出同步

`scripts/verify-export-report.ts` 新增 1 条（只增不削）：
`✓ X21：导出侧输出列与抽取器同源（行内注释 SQL 两列全出）`；导出 HTML 的 chips 直接消费
`nodeData.outputColumns`（`src/utils/export-report.ts:749`），因此与节点侧同一结果。

## 6. 门槛

| 命令 | 结果 |
|---|---|
| `npm run build`（`tsc -b` + vite + compile:server） | RC=0；主 chunk 1,452.00→1,453.90 kB（gzip 448.75→449.25 kB）；新增懒加载 `sql-columns-*.js` 2,436.85 kB（gzip 435.80 kB）；`plotly.min-*.js` 4,646.12 kB 未回退 |
| `npm run lint` | RC=0（无输出） |
| `npm run verify` | RC=0：manifest 92 / rerun 71 / audit 119 / export 147→148 / source-table 39 / semantic-lineage 54 / caliber-conflict 77 / cwd 13 / prompt-injection 58 = **671**（基线 670，+1）；vitest 集成 **20 文件 / 273 例**（基线 19/256，+1 文件、+17 例：select-columns 6→14、新增 sql-highlight 9）；UI **4 文件 / 37 例**（未变） |
| `git status --porcelain`（verify 全跑后） | 只剩本任务改动（含 `package.json` / `package-lock.json` 依赖变更，属交付物），无残留临时文件 |

## 7. 复跑方式

```bash
npm install                      # 拉 node-sql-parser（lockfile 已更新）
npx vitest run tests/integration/select-columns.test.ts tests/integration/sql-highlight.test.ts
npm run verify:export            # 含新增的 X21 同源断言
npm run build && npm run lint && npm run verify
```
