/**
 * SQL 高亮单一事实源（X21）。
 *
 * 卡片（tokenizeSQL → span）与编辑弹窗（lang-sql Lezer tag → HighlightStyle）必须落在
 * 同一批 CSS class 上，否则「两端观感一致」只是口号。这里断言：
 * 1) 词法分类正确（关键词/字符串/注释/数字），且注释里的关键词不再被误标（旧实现会）；
 * 2) 弹窗侧 tag→class 映射完全取自 SQL_TOKEN_CLASS（同源配色，不是第二套调色板）；
 * 3) 卡片关键词表全覆盖 SQL_KEYWORDS，限定名/引号标识符不冒充关键词。
 */
import { describe, expect, it } from "vitest";
import {
  SQL_KEYWORDS,
  SQL_TOKEN_CLASS,
  SQL_TOKEN_TAG_KINDS,
  tokenizeSQL,
  type SqlTokenKind,
} from "../../src/utils/sql-highlight.js";

/** 只看有配色的 token（plain 会把相邻碎片合并，逐字符断言反而脆） */
function typed(sql: string): Array<[SqlTokenKind, string]> {
  return tokenizeSQL(sql)
    .filter((token) => token.kind !== "plain")
    .map((token) => [token.kind, token.text] as [SqlTokenKind, string]);
}

describe("tokenizeSQL 分类", () => {
  it("关键词 / 数字 / 字符串", () => {
    expect(typed("SELECT amount, 42 AS n FROM t WHERE a = 'x'")).toEqual([
      ["keyword", "SELECT"],
      ["number", "42"],
      ["keyword", "AS"],
      ["keyword", "FROM"],
      ["keyword", "WHERE"],
      ["string", "'x'"],
    ]);
  });

  it("行注释整体是 comment：注释里的 SELECT 不再被当关键词", () => {
    expect(typed("SELECT SUM(a) AS s -- SELECT 是注释\nFROM t")).toEqual([
      ["keyword", "SELECT"],
      ["keyword", "SUM"],
      ["keyword", "AS"],
      ["comment", "-- SELECT 是注释"],
      ["keyword", "FROM"],
    ]);
  });

  it("块注释整体是 comment", () => {
    expect(typed("SELECT /* FROM 注释 */ a FROM t")).toEqual([
      ["keyword", "SELECT"],
      ["comment", "/* FROM 注释 */"],
      ["keyword", "FROM"],
    ]);
  });

  it("双引号/反引号/方括号标识符不是字符串字面量", () => {
    expect(typed('SELECT "sales amount", `x`, [y] FROM t')).toEqual([
      ["keyword", "SELECT"],
      ["keyword", "FROM"],
    ]);
    expect(typed("SELECT 'a''b' AS l FROM t")).toEqual([
      ["keyword", "SELECT"],
      ["string", "'a''b'"],
      ["keyword", "AS"],
      ["keyword", "FROM"],
    ]);
  });

  it("限定名整体按 plain（chocolate.chocolate.fact_sales 里的字段名不上色）", () => {
    expect(typed("SELECT chocolate.chocolate.fact_sales.amount FROM t")).toEqual([
      ["keyword", "SELECT"],
      ["keyword", "FROM"],
    ]);
  });

  it("SQL_KEYWORDS 每个词都能被识别为关键词", () => {
    for (const keyword of SQL_KEYWORDS) {
      expect(typed(`SELECT ${keyword} FROM t`).some(([kind, text]) => kind === "keyword" && text === keyword)).toBe(true);
    }
  });

  it("空输入不炸", () => {
    expect(tokenizeSQL("")).toEqual([]);
  });
});

describe("卡片与弹窗共用一套 token 配色", () => {
  it("弹窗 tag 映射只使用 SQL_TOKEN_CLASS 里的 class", () => {
    const allowed = new Set(Object.values(SQL_TOKEN_CLASS));
    const used = SQL_TOKEN_TAG_KINDS.map(({ kind }) => SQL_TOKEN_CLASS[kind]);
    for (const className of used) expect(allowed.has(className)).toBe(true);
    for (const kind of ["keyword", "string", "comment", "number"] as const) {
      expect(used).toContain(SQL_TOKEN_CLASS[kind]);
    }
  });

  it("五类 token 各自都有 class", () => {
    expect(Object.keys(SQL_TOKEN_CLASS).sort()).toEqual([
      "comment",
      "keyword",
      "number",
      "plain",
      "string",
    ]);
  });
});
