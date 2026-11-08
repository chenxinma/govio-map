/**
 * SQL 输出列名提取（govio-canvas extractSelectColumns）。
 *
 * 回归来源：会话 2026-11-08T03-09-10-797Z 的 sqlQuery 节点出现
 * `"marketing_spend)"`, `"0)"`, `"amount)"` 这类垃圾列名——旧实现按逗号硬切，
 * 函数内逗号（`ROUND(x, 0)`）把表达式切碎，尾部碎片被当成列名。
 */
import { describe, expect, it } from "vitest";
import { extractSelectColumns } from "../../server/extensions/govio-canvas.js";

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
    expect(cols.some((c) => c.endsWith(")"))).toBe(false);
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
  });
});
