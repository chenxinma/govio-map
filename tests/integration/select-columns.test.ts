/**
 * SQL 输出列名提取（X21：src/utils/sql-columns，node-sql-parser 主解析 + 正则兜底）。
 *
 * 回归来源一：会话 2026-11-08T03-09-10-797Z 的 sqlQuery 节点出现
 * `"marketing_spend)"`, `"0)"`, `"amount)"` 这类垃圾列名——旧实现按逗号硬切，
 * 函数内逗号（`ROUND(x, 0)`）把表达式切碎，尾部碎片被当成列名。
 * 回归来源二：用户实测 2026-11-14，带行内 `--` 注释的 SELECT 只剩第一列
 * （别名正则锚定串尾，注释尾巴顶掉匹配）。
 */
import { describe, expect, it } from "vitest";
import {
  extractSelectColumns,
  extractSelectColumnsByParser,
  extractSelectColumnsByRegex,
  stripSqlComments,
} from "../../src/utils/sql-columns.js";

/** 任何通道都不许产出的垃圾形态 */
function assertNoGarbage(cols: string[]): void {
  for (const col of cols) {
    expect(col.endsWith(")")).toBe(false);
    expect(col.includes(",")).toBe(false);
    expect(col.trim()).toBe(col);
    expect(col.length).toBeGreaterThan(0);
  }
}

describe("extractSelectColumns", () => {
  it("函数内逗号不切碎表达式（ROUND 第二参数不产列名）", () => {
    const sql = `SELECT ch.channel_name,
       SUM(f.marketing_spend)                                AS marketing_spend,
       ROUND((SUM(f.amount) - SUM(f.marketing_spend))
             / NULLIF(SUM(f.marketing_spend), 0), 4)         AS net_gain,
       ROUND(SUM(f.amount) / NULLIF(SUM(f.marketing_spend), 0), 3) AS roi_ratio
FROM chocolate.chocolate.fact_sales f
JOIN chocolate.chocolate.dim_channel ch ON f.channel_id = ch.channel_id
GROUP BY ch.channel_name`;
    expect(extractSelectColumns(sql)).toEqual([
      "channel_name",
      "marketing_spend",
      "net_gain",
      "roi_ratio",
    ]);
  });

  it("真实坏例（gov-105）：不再出现 amount) / 0) 碎片", () => {
    const sql = `SELECT c.country_name,
       SUM(f.boxes_shipped)                             AS boxes_shipped,
       ROUND(SUM(f.price_per_box * f.boxes_shipped), 2) AS calc_amount,
       ROUND(SUM(f.amount), 2)                          AS recorded_amount,
       ROUND(SUM(f.price_per_box * f.boxes_shipped) - SUM(f.amount), 2) AS diff,
       COUNT(DISTINCT f.order_id)                       AS order_count
FROM chocolate.chocolate.fact_sales f
JOIN chocolate.chocolate.dim_country c ON f.country_id = c.country_id
GROUP BY c.country_name`;
    const cols = extractSelectColumns(sql);
    expect(cols).toEqual([
      "country_name",
      "boxes_shipped",
      "calc_amount",
      "recorded_amount",
      "diff",
      "order_count",
    ]);
    assertNoGarbage(cols);
  });

  it("X21 主案例：行内 -- 注释不吞列（两列全出）", () => {
    const sql = `SELECT
  SUM(amount)     AS m_sales_amount,  -- 销售额：SUM(amount)
  COUNT(order_id) AS m_order_count    -- 订单数：COUNT(order_id)
FROM chocolate.chocolate.fact_sales;`;
    expect(extractSelectColumns(sql)).toEqual(["m_sales_amount", "m_order_count"]);
    // 去注释形态结果一致（X21 之前的差异点）
    expect(extractSelectColumns(sql.replace(/--.*$/gm, ""))).toEqual(["m_sales_amount", "m_order_count"]);
  });

  it("块注释与注释内的逗号/引号不干扰", () => {
    const sql = `SELECT /* 销售额, 含逗号 */ SUM(amount) AS sales_amount, -- it's fine
       COUNT(order_id) AS order_count
FROM t`;
    expect(extractSelectColumns(sql)).toEqual(["sales_amount", "order_count"]);
  });

  it("裸列与表限定列取列名", () => {
    expect(extractSelectColumns("SELECT country_name, f.amount FROM t f")).toEqual([
      "country_name",
      "amount",
    ]);
  });

  it("隐式别名（无 AS）可识别", () => {
    expect(extractSelectColumns("SELECT SUM(amount) total, COUNT(*) n FROM t")).toEqual([
      "total",
      "n",
    ]);
  });

  it("表达式无别名不产垃圾名（交给调用方回退）", () => {
    expect(extractSelectColumns("SELECT price_per_box * boxes_shipped FROM t")).toEqual([]);
    expect(extractSelectColumns("SELECT * FROM t")).toEqual([]);
    expect(extractSelectColumns("SELECT t.* FROM t")).toEqual([]);
  });

  it("带引号别名去引号", () => {
    expect(extractSelectColumns('SELECT SUM(amount) AS "销售 额", region FROM t')).toEqual([
      "销售 额",
      "region",
    ]);
    expect(extractSelectColumns("SELECT SUM(amount) AS `my col` FROM t")).toEqual(["my col"]);
    expect(extractSelectColumns("SELECT SUM(amount) AS [b c] FROM t")).toEqual(["b c"]);
  });

  it("DISTINCT / CASE / 窗口函数 / 子查询项", () => {
    expect(extractSelectColumns("SELECT DISTINCT a, b FROM t")).toEqual(["a", "b"]);
    expect(
      extractSelectColumns("SELECT CASE WHEN a > 1 THEN 'x, y' ELSE 'z' END AS bucket, SUM(b) AS s FROM t"),
    ).toEqual(["bucket", "s"]);
    expect(
      extractSelectColumns("SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn, c FROM t"),
    ).toEqual(["rn", "c"]);
    expect(extractSelectColumns("SELECT x, (SELECT MAX(y) FROM i) AS m FROM o")).toEqual(["x", "m"]);
  });

  it("WITH / INSERT ... SELECT / UNION 取首个结果集列", () => {
    expect(extractSelectColumns("WITH c AS (SELECT 1 AS one) SELECT one FROM c")).toEqual(["one"]);
    expect(extractSelectColumns("INSERT INTO df SELECT a, SUM(b) AS s FROM t GROUP BY a")).toEqual([
      "a",
      "s",
    ]);
    expect(extractSelectColumns("SELECT a AS x FROM t UNION ALL SELECT b AS y FROM u")).toEqual(["x"]);
  });

  it("非查询语句与空输入不产列名", () => {
    expect(extractSelectColumns("SHOW TABLES")).toEqual([]);
    expect(extractSelectColumns("SELECT 1")).toEqual([]);
    expect(extractSelectColumns("")).toEqual([]);
  });

  it("方言不支持（QUALIFY 等）回落正则：仍取到全部列名，不产垃圾", () => {
    const sql = "SELECT a AS one, -- 一号\n       b AS two\nFROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a) = 1";
    expect(extractSelectColumnsByParser(sql)).toBeNull(); // 解析器确实扛不动
    const cols = extractSelectColumns(sql);
    expect(cols).toEqual(["one", "two"]);
    assertNoGarbage(cols);
  });

  it("DuckDB 专有写法（* EXCLUDE / GROUP BY ALL）解析失败时也不产垃圾名", () => {
    for (const sql of ["SELECT * EXCLUDE (a) FROM t", "SELECT a, SUM(b) FROM t GROUP BY ALL"]) {
      const cols = extractSelectColumns(sql);
      assertNoGarbage(cols);
    }
  });

  it("兜底管道自身：注释剥离 + 顶层逗号切分", () => {
    expect(stripSqlComments("SELECT a, -- x\nb /* y */ FROM 'q--z' t")).toBe("SELECT a, \nb   FROM 'q--z' t");
    expect(extractSelectColumnsByRegex("SELECT SUM(a) AS x, -- c1\nCOUNT(b) AS y FROM t")).toEqual(["x", "y"]);
    expect(extractSelectColumnsByRegex("SELECT ROUND(SUM(a), 0) AS r, b FROM t")).toEqual(["r", "b"]);
    // 兜底不如主解析的地方（DISTINCT 前缀 / 子查询项）——主解析必须覆盖
    expect(extractSelectColumnsByRegex("SELECT DISTINCT a, b FROM t")).toEqual(["b"]);
    expect(extractSelectColumns("SELECT DISTINCT a, b FROM t")).toEqual(["a", "b"]);
  });
});
