# X21 design — 输出列抽取升级（node-sql-parser）+ SQL 高亮统一

## 1. 问题与实证

- 用户实测（2026-11-14）：SELECT 带行内 `--` 注释时，SQLQuery 节点「输出列」只剩第一列。
  主会话复现：带注释 → `["m_sales_amount"]`，去注释 → 两列齐全。
- 根因（`server/extensions/govio-canvas.ts` 旧管道）：`extractSelectColumns` 不剥注释，
  `columnNameOf` 的显式别名正则 `/AS alias\s*$/` 锚定串尾——注释尾巴把 `$` 前的匹配顶掉，
  该项返回 null 被过滤掉。
- 另一问题：卡片自写 `highlightSQL()`（关键词正则 split，不认识注释，注释里的 SELECT 照样上色）
  与弹窗 CodeMirror `@codemirror/lang-sql`（Lezer tag 分类）两套高亮，token 分类与配色都不一致。

## 2. 抽取：node-sql-parser 主解析 + 正则兜底

**选型**：`node-sql-parser@5.4.0`（纯 JS、无原生依赖、CJS 单包）。它是 PEG 生成的多方言解析器，
AST 里 `select.columns[i] = { expr, as }` 正是我们要的「表达式 + 别名」结构，注释/多行排版/CASE/
DISTINCT/子查询由解析器统一处理，不再靠正则猜测。

**放弃的方案**：继续修补正则（`stripComments` + 放宽 `$` 锚定）。理由：正则只能修掉「注释」这一类，
`WITH`/子查询项/函数内逗号仍是启发式；`SELECT (SELECT MAX(y) FROM i) AS m` 旧管道直接漏列。
用户已批准引入解析器（2026-11-14 裁决）。

**分层策略（任何输入不得比现状差）**：

1. `extractSelectColumnsByParser()`：依次试 `postgresql` → `mysql` 方言。
   - 解析成功 → **以 AST 为准**（含「成功但取不出列名」= 空数组，例如 `SELECT *`、`t.*`、
     无别名表达式、非查询语句）。不回落正则，避免把引号里的逗号再切成垃圾名。
   - 解析抛错（两方言都失败）→ 返回 `null` = 「不可用」，交给兜底。
2. `extractSelectColumnsByRegex()`：原正则管道（`splitTopLevelCommas` + `columnNameOf` 三分支），
   只是**先 `stripSqlComments()`**——所以 QUALIFY / `* EXCLUDE` / `GROUP BY ALL` / struct 字面量
   这些 DuckDB 专有写法仍然能出列名，且不会比 X21 之前更差。
3. 方言选择理由：项目实际数据源是 DuckDB（三段名 `catalog.schema.table`，pg 方言能吃）与 Postgres；
   `mysql` 作为第二顺位只为反引号标识符。`DATE_TRUNC` 在 pg 方言可解析（实测），故没有为它开特例。
4. 语句形态覆盖：`select` 直接取 `columns`；`insert` 递归 `values`（INSERT ... SELECT）；
   `create` 递归 `query_expr`（CTAS/VIEW）；带 `selects` 数组的 UNION 分支取首个非空。
   多语句 AST 取首个有列名的语句，与旧正则「匹配第一个 SELECT」的行为一致。
5. 解析器单例懒初始化；`new Parser()` 抛错（依赖缺失）时置 null → 永久走兜底管道，不抛到调用方。

**不产垃圾名列**（BUGFIX-sql-columns-and-graph-cache.md 的坏例）：别名缺失时只有 `column_ref`
产名字，函数/CASE/二元表达式/字面量一律跳过；`*`（含 `t.*`）归一化为 null。调用方
（`govio-canvas`）继续按原逻辑回退 `tableName.*`。

**契约**：`outputColumns: string[]` 形状不变；`PROTOCOL_VERSION` 不变。

## 3. 编辑跟手（SQLModal / 卡片就地编辑）

核实结论：**X21 之前不跟手**——`SQLQueryNode` 的两条保存路径（就地 textarea 的 `handleSave`、
弹窗 `onSave`）都只 `updateNodeData(id, { sql })`，`outputColumns` 保持建节点时的旧值，
所以改完 SQL「输出列」不动。

取舍：**保存时重抽取**（而不是显示端派生）。理由：
- 显示端派生会改写既有语义——历史节点的 `outputColumns` 是服务端给的（可能是 `tableName.*`
  兜底、也可能来自 observe 的真实列），渲染时重算会把它们覆盖掉，`tests/ui/sql-query-node.test.tsx`
  里「outputColumns 由服务端事件驱动」的断言也会连带失真；
- 保存时重抽取只影响用户主动改 SQL 的路径，改动面最小，不动 store 协议、不动 PROTOCOL_VERSION。
- 抽不出列名时**保留原值**（不清空），避免把 `tableName.*` 兜底降级成空 chips。

前端抽取器走 `await import('../../utils/sql-columns')` 懒加载：服务端建节点用的是同一模块
（静态 import），前后端只有一份实现，不会漂出两套口径。

## 4. SQL 高亮统一

三条候选（任务书给的）：

| 方案 | 结论 |
|---|---|
| Lezer 共享高亮（卡片也跑 lang-sql 的解析） | **否**。`@lezer/sql`/`@lezer/highlight` 是 `@codemirror/lang-sql` 的传递依赖，直接引会变成未声明依赖；卡片是静态 HTML，起 CM 语言栈只为拿 token 分类不划算。 |
| 卡片内嵌 CodeMirror 只读视图 | **否**。CodeMirror 已在主 chunk（SQLModal 静态引），bundle 影响小，但画布上每个 SQL 节点一个 EditorView，几十节点时挂载/布局成本不可控，且要改双击编辑的交互。 |
| 升级共享 tokenizer（本方案） | **是**。分类与配色收敛到一处，卡片与弹窗各自渲染同一批 class。 |

**实现**：`src/utils/sql-highlight.ts` 是唯一事实源。
- `tokenizeSQL()`：卡片用的词法扫描，五类 token（keyword / string / comment / number / plain），
  注释感知（`--`、`#`、`/* */`），单引号算字符串字面量，`"` `` ` `` `[]` 算引号标识符 → plain。
- `SQL_TOKEN_CLASS`：分类 → CSS class（`sqltok-*`），颜色只在 `src/index.css` 定义一处。
- `govioSQLHighlight`：`HighlightStyle.define(SQL_TOKEN_TAG_KINDS → 同一批 class)` 的
  `syntaxHighlighting()`（非 fallback），塞进 SQLModal 的 `extensions`；`@uiw/react-codemirror`
  把用户 extensions 排在 theme 之后，且 basicSetup 自带样式是 fallback，因此它的 tag 分类
  （Lezer）负责「是什么」，本模块负责「长什么样」，两端配色从此同源。

**已知不完全一致（见「遗留问题」）**：弹窗的关键词集合是 lang-sql 的 `StandardSQL` 方言表
（含类型名、内置函数，比我们卡片里那份 60 词表宽）。本轮不扩卡片表、也不换弹窗方言
（换方言会削弱编辑器已有的类型/函数高亮与关键词补全，属于编辑器功能改动，超范围）。
两端在「关键词/字符串/注释/数字」四类上的颜色一致；差异只在关键词覆盖面。

深浅背景：卡片是浅底（Green Deck），弹窗仍是 oneDark 深底。同一色相给两组明度
（`--color-sql-*` 与 `--color-sql-*-on-dark`），分类与色相一致，只有明度随背景适配。

## 5. bundle 对比（`npm run build`，实测）

| chunk | X21 前 | X21 后 | 说明 |
|---|---|---|---|
| `dist/assets/index-*.js`（主 chunk） | 1,452.00 kB / gzip 448.75 kB | 1,453.90 kB / gzip 449.25 kB | +1.9 kB（共享高亮 + 保存钩子），首屏基本不变 |
| `dist/assets/sql-columns-*.js`（新增，懒加载） | — | 2,436.85 kB / gzip 435.80 kB | node-sql-parser 全方言包；只在「保存编辑过的 SQL」时拉 |
| `dist/assets/plotly.min-*.js` | 4,646.12 kB | 4,646.12 kB | X3 懒加载拆分未回退 ✓ |
| `dist/assets/export-report-*.js` | 43.13 kB | 43.13 kB | 未变 |
| `dist/assets/index-*.css` | 53.83 kB | 54.50 kB | 新增 8 个 token 变量 + 10 条 class 规则 |

服务端侧：`compile:server` 用 `--packages=external`，`node-sql-parser` 留在运行时依赖，不进 bundle。

## 6. 遗留问题

1. **懒加载 chunk 体积**：`sql-columns-*.js` 2.4 MB（gzip 436 kB）是 node-sql-parser 的
   全方言包（`index.js` 内置 15 种方言）。可以改引 `node-sql-parser/build/postgresql`
   单方言包（体积约 1/5），代价是失去 mysql 反引号兜底、且要自带类型声明。等真实用量/首屏
   反馈再决定；本轮只在保存动作后触发，不影响打开画布。
2. **关键词覆盖面两端不完全一致**：弹窗（lang-sql 方言表）比卡片（`SQL_KEYWORDS` 60 词）
   认更多词/类型名。统一要动编辑器方言或扩表，属编辑器观感改动，需产品确认。
3. **多语句块只取首个结果集**：与旧行为一致（一个 SQL 代码块 = 一个节点）。若 agent 在块里
   写多条 SELECT，后面的列名不并入；要改需要连带动了节点切分逻辑。
4. **`SELECT *` / `t.*` 仍靠调用方回退 `tableName.*`**：解析器能认出 star，但真实列名需要
   schema 才能展开。当前 datasource/schema 不在抽取上下文里，若要「展开星号」需引入
   sourceTable 元数据查询（跨模块），本轮不做。
5. **旧节点不自愈**：画布 sidecar 里已固化的单列 `outputColumns`（本次 bug 的产物）不会因为
   升级而自动重算；用户重新编辑保存该节点即可刷新，或重跑 SQL 生成新节点。
6. **传递依赖直接 import**：`@codemirror/language`、`@lezer/highlight` 未在 package.json
   声明（沿用本仓既有做法：`@codemirror/autocomplete`、`@codemirror/theme-one-dark` 同样是
   直接 import 的传递依赖）。若要严格化，应一次性把用到的 `@codemirror/*` 提为显式依赖。
7. `node-sql-parser` 的类型面是自己写的最小 shim（`src/types/node-sql-parser.d.ts`）：包是 CJS
   且打包产物让 Node ESM 认不出命名导出，只能走 default interop；官方 `types.d.ts` 没有 default
   导出，所以 shim 优先。升级依赖时注意 shim 与实际 AST 字段的漂移。
