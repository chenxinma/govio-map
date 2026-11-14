/**
 * SQL 高亮单一事实源（X21）。
 *
 * 之前两套技术各画各的高亮：卡片里是自写正则 `highlightSQL()`（只认关键词/字符串/数字，
 * **不认识注释**——`-- 销售额` 里的关键词照样被上色），弹窗里是 CodeMirror
 * `@codemirror/lang-sql`（Lezer tag 分类）。本模块把「分类」与「配色」收敛成一份：
 *
 * - `tokenizeSQL()`：卡片静态渲染用的词法扫描（注释/字符串/数字/关键词/其余）
 * - `SQL_TOKEN_CLASS`：分类 → CSS class（`src/index.css` 里一处定义配色）
 * - `govioSQLHighlight`：CodeMirror 扩展，把 Lezer tag 映射到**同一批 class**
 *
 * 两端因此共享同一套 token 分类与同一份调色板；编辑器深底（oneDark）用同色相的提亮变体，
 * 差异只在背景，不在分类。取舍与已知缺口见 docs/tasks/X21-sql-output-columns/design.md。
 */
import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";

/** token 分类（关键词 / 字符串 / 注释 / 数字 / 其余） */
export type SqlTokenKind = "keyword" | "string" | "comment" | "number" | "plain";

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

/**
 * 关键词表（自 `SQLQueryNode.highlightSQL` 原样搬来，行为不变）。
 * 编辑器侧的关键词集合由 lang-sql 方言表给出（更宽，含类型名/内置函数），
 * 差异记在 design.md「遗留问题」，不在本轮扩表。
 */
export const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "ON", "AS", "JOIN",
  "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "GROUP", "BY", "ORDER",
  "HAVING", "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "INSERT", "INTO",
  "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP",
  "INDEX", "VIEW", "IF", "EXISTS", "BETWEEN", "LIKE", "IS", "NULL", "CASE",
  "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "COUNT", "SUM", "AVG",
  "MIN", "MAX", "COALESCE", "CAST", "OVER", "PARTITION", "WITH", "RECURSIVE",
];

const KEYWORD_SET = new Set(SQL_KEYWORDS.map((keyword) => keyword.toUpperCase()));

/** 分类 → CSS class：卡片与编辑器都只认这张表 */
export const SQL_TOKEN_CLASS: Record<SqlTokenKind, string> = {
  keyword: "sqltok-keyword",
  string: "sqltok-string",
  comment: "sqltok-comment",
  number: "sqltok-number",
  plain: "sqltok-plain",
};

/**
 * Lezer tag → 分类。弹窗用它构造 HighlightStyle，卡片用 `tokenizeSQL` 得到同名分类，
 * 因此「哪一类长什么样」只有一处定义（`SQL_TOKEN_CLASS` + index.css）。
 *
 * 注：`"quoted"` 标识符在 lang-sql 里是 `special(string)`（语法上属字符串族），
 * 这里显式归到 plain，与卡片对引号标识符的处理对齐——引号列名不是字符串字面量。
 */
export const SQL_TOKEN_TAG_KINDS: ReadonlyArray<{ tag: Tag; kind: SqlTokenKind }> = [
  { tag: t.keyword, kind: "keyword" },
  { tag: t.typeName, kind: "keyword" },
  { tag: t.bool, kind: "keyword" },
  { tag: t.null, kind: "keyword" },
  { tag: t.lineComment, kind: "comment" },
  { tag: t.blockComment, kind: "comment" },
  { tag: t.special(t.string), kind: "plain" },
  { tag: t.string, kind: "string" },
  { tag: t.number, kind: "number" },
  { tag: t.name, kind: "plain" },
  { tag: t.operator, kind: "plain" },
  { tag: t.punctuation, kind: "plain" },
];

export function sqlTagStyleFor(kind: SqlTokenKind): string {
  return SQL_TOKEN_CLASS[kind];
}

/** CodeMirror 高亮扩展：非 fallback，优先级高于主题自带的 HighlightStyle */
export const govioSQLHighlight = syntaxHighlighting(
  HighlightStyle.define(
    SQL_TOKEN_TAG_KINDS.map(({ tag, kind }): TagStyle => ({ tag, class: sqlTagStyleFor(kind) })),
  ),
);

const WORD_START = /[A-Za-z_]/;
const WORD_CHAR = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

function pushToken(tokens: SqlToken[], kind: SqlTokenKind, text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ kind, text });
}

/**
 * 词法扫描：注释（`--` / `#` 行注释、`/* *\/` 块注释）、字符串字面量、数字、关键词、其余。
 *
 * 只做分类不做语法分析（渲染要逐字符稳定，且必须能吃下 DuckDB 方言里解析器不认的写法）。
 * `"x"` / `` `x` `` 是引号标识符 → plain；`'x'` 才是字符串字面量 → string（与编辑器一致）。
 */
export function tokenizeSQL(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  if (!sql) return tokens;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    // 行注释：-- 或 # 到行尾（换行留给下一个 token，保持行数一致）
    if (ch === "-" && next === "-") {
      let end = i;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      pushToken(tokens, "comment", sql.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "#") {
      let end = i;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      pushToken(tokens, "comment", sql.slice(i, end));
      i = end;
      continue;
    }
    // 块注释
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close < 0 ? sql.length : close + 2;
      pushToken(tokens, "comment", sql.slice(i, end));
      i = end;
      continue;
    }
    // 单引号字符串（'' 视为内部转义）
    if (ch === "'") {
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end] === "'") {
          if (sql[end + 1] === "'") { end += 2; continue; }
          end += 1;
          break;
        }
        end += 1;
      }
      pushToken(tokens, "string", sql.slice(i, end));
      i = end;
      continue;
    }
    // 引号标识符："x" / `x` → plain（去掉引号也不该当字符串着色）
    if (ch === '"' || ch === "`") {
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end] === ch) {
          if (sql[end + 1] === ch) { end += 2; continue; }
          end += 1;
          break;
        }
        end += 1;
      }
      pushToken(tokens, "plain", sql.slice(i, end));
      i = end;
      continue;
    }
    // 数字：整数/小数/科学计数（0x 十六进制按普通标识符走也无害）
    if (DIGIT.test(ch) || (ch === "." && next !== undefined && DIGIT.test(next))) {
      let end = ch === "." ? i + 1 : i;
      while (end < sql.length && /[0-9.eExXa-fA-F_]/.test(sql[end])) end += 1;
      // 只在数字前缀内吃字符：遇到 e/E 后允许正负号
      if (/[eE]/.test(sql[end - 1]) && /[+-]/.test(sql[end])) end += 1;
      pushToken(tokens, "number", sql.slice(i, end));
      i = end;
      continue;
    }
    // 词：关键词 or 普通标识符（含 a.b 这类限定名，整体按一个 token 走）
    if (WORD_START.test(ch)) {
      let end = i;
      while (end < sql.length && (WORD_CHAR.test(sql[end]) || sql[end] === ".")) end += 1;
      const text = sql.slice(i, end);
      const isKeyword = !text.includes(".") && KEYWORD_SET.has(text.toUpperCase());
      pushToken(tokens, isKeyword ? "keyword" : "plain", text);
      i = end;
      continue;
    }
    pushToken(tokens, "plain", ch);
    i += 1;
  }
  return tokens;
}
