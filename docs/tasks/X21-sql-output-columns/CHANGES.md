# X21 CHANGES

## 新增

- `package.json` / `package-lock.json` — 新增依赖 `node-sql-parser@^5.4.0`（唯一新依赖，用户 2026-11-14 批准）。
- `src/utils/sql-columns.ts` — 输出列抽取唯一实现：`extractSelectColumnsByParser()`（node-sql-parser
  postgresql→mysql 依次尝试，成功即权威、失败返回 null）、`extractSelectColumnsByRegex()`（原正则管道
  降级为兜底）、`stripSqlComments()`（字符串/引号标识符安全的注释剥离，兜底管道与调用方共用）、
  `extractSelectColumns()`（主解析优先 + 兜底）。旧坏例的 `splitTopLevelCommas`/`columnNameOf` 语义原样保留。
- `src/utils/sql-highlight.ts` — SQL 高亮单一事实源：`tokenizeSQL()`（keyword/string/comment/number/plain）、
  `SQL_KEYWORDS`（自 SQLQueryNode 原样搬来）、`SQL_TOKEN_CLASS`（分类→class）、
  `SQL_TOKEN_TAG_KINDS` + `govioSQLHighlight`（Lezer tag→同一批 class 的 CodeMirror 扩展）。
- `src/types/node-sql-parser.d.ts` — node-sql-parser 的最小类型 shim（CJS 打包产物在 Node ESM 下
  只能走 default interop，官方 types 无 default 导出）。
- `tests/integration/sql-highlight.test.ts` — 9 例：分类正确性（含「注释里的关键词不再误标」）、
  引号标识符 vs 字符串字面量、限定名不冒充关键词、关键词表全覆盖、两端共用一套 class 的同源断言。

## 修改

- `server/extensions/govio-canvas.ts` — 删除本地抽取管道（`splitTopLevelCommas` / `columnNameOf` /
  `stripIdentQuotes` / `extractSelectColumns`，共 -1752 字符），改为 import `src/utils/sql-columns`。
  `extractSqlCodeBlocks` 与「解析不出列回退 `tableName.*`」的调用方逻辑不变。
- `src/components/Nodes/SQLQueryNode.tsx` —
  1) `highlightSQL()` 改为消费 `tokenizeSQL()`，span 带 `data-sqltok` + 共享 class（原三档
     内联 Tailwind 色去掉，配色只在 index.css 一处）；
  2) 新增 `commitSQL()`：SQL 保存后重算 `outputColumns`（懒加载 `src/utils/sql-columns`），
     抽不出列名保留原值；`handleSave`（就地编辑）与 SQLModal `onSave` 都改走它 → 「输出列」跟手。
- `src/components/Nodes/SQLModal.tsx` — `extensions` 加 `govioSQLHighlight`（非 fallback 样式，
  优先于 oneDark 自带的 HighlightStyle），编辑器语法配色与卡片同源；编辑器功能（lang-sql、
  自定义补全、快捷键、Format、执行）未动。
- `src/index.css` — `@theme` 增加 8 个 SQL token 颜色变量；新增 `.sqltok-*` 与
  `.cm-editor .sqltok-*`（深底同色相提亮）两组规则，配色唯一出处。
- `tests/integration/select-columns.test.ts` — 改 import 到 `src/utils/sql-columns`；保留原 6 例
  （gov-104/105 坏例逐字不动），新增行内/块注释主案例、QUALIFY 回落、DuckDB 专有写法不产垃圾名、
  DISTINCT/CASE/窗口/子查询/WITH/INSERT-SELECT/UNION、引号别名三形态、非查询语句、
  兜底管道自身与「兜底不如主解析处主解析必须覆盖」对照，共 14 例。

## 未动（范围纪律）

- `outputColumns` 契约形状、`PROTOCOL_VERSION`、`docs/task-plan.json`、PD-3/semanticRefs/口径逻辑、
  SQLModal 编辑器功能与 X3 的 plotly 懒加载拆分。
