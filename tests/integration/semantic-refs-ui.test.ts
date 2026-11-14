/**
 * X18 单元测试：`semanticRefs` → 口径徽标的**展示模型**（纯函数，node 环境）。
 *
 * 覆盖：code 优先 / name 回退 / 两者都缺整条跳过（含纯空白与脏元素）、Metric 优先排序且
 * 同类型保持注入原序、`entityType:id` 去重（与 canvas-store 建语义边同口径）、hover 全文
 * 只拼存在的项、非指标前缀类型名、未知 entityType 回落原值且不抢在指标前面、
 * 空/非数组入参返回空数组（调用方据此整节不渲染）。
 *
 * 与 `scripts/verify-semantic-lineage.ts` 的分工：那边验「归因链路产出的同一份 refs 在
 * 画布与导出都可见」，这里穷举展示模型的边界（脏数据、缺字段、排序稳定性）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_VISIBLE_SEMANTIC_REFS,
  SEMANTIC_ENTITY_TYPE_LABELS,
  semanticRefBadges,
  semanticRefLabel,
  semanticRefTitle,
  semanticRefTypeLabel,
} from "../../src/utils/semantic-refs-ui.js";
import type { SemanticRef } from "../../src/types/index.js";

const METRIC: SemanticRef = { entityType: "Metric", id: "m-gmv", code: "m_gmv", name: "销售额" };

describe("semanticRefTypeLabel：类型展示名", () => {
  it("三类图谱实体各有中文名", () => {
    expect(SEMANTIC_ENTITY_TYPE_LABELS.Metric).toBe("指标");
    expect(SEMANTIC_ENTITY_TYPE_LABELS.Dimension).toBe("维度");
    expect(SEMANTIC_ENTITY_TYPE_LABELS.Col).toBe("字段标准");
    expect(semanticRefTypeLabel("Metric")).toBe("指标");
  });

  it("未知取值回落原值、缺失返回空串（不出现 undefined）", () => {
    expect(semanticRefTypeLabel("Glossary")).toBe("Glossary");
    expect(semanticRefTypeLabel(undefined)).toBe("");
    expect(semanticRefTypeLabel("   ")).toBe("");
  });
});

describe("semanticRefLabel：徽标短名", () => {
  it("code 优先", () => {
    expect(semanticRefLabel(METRIC)).toBe("m_gmv");
  });

  it("code 缺失或纯空白时回落 name", () => {
    expect(semanticRefLabel({ entityType: "Metric", id: "m1", name: "订单数" })).toBe("订单数");
    expect(semanticRefLabel({ entityType: "Metric", id: "m1", code: "   ", name: "订单数" })).toBe("订单数");
  });

  it("code/name 都缺（图谱 Col 的常态）→ null，调用方跳过该条", () => {
    expect(semanticRefLabel({ entityType: "Col", id: "c1" })).toBeNull();
    expect(semanticRefLabel({ entityType: "Col", id: "c1", code: "", name: "  " })).toBeNull();
  });

  it("脏元素（null / undefined）不抛错", () => {
    expect(semanticRefLabel(undefined)).toBeNull();
    expect(semanticRefLabel(null)).toBeNull();
  });
});

describe("semanticRefTitle：hover 全文", () => {
  it("四项齐全时按 类型 / 编码 / 名称 / 图谱 ID 多行拼接", () => {
    expect(semanticRefTitle(METRIC)).toBe("类型：指标\n编码：m_gmv\n名称：销售额\n图谱 ID：m-gmv");
  });

  it("缺项自动省略（不出现 undefined、不出现空行）", () => {
    const title = semanticRefTitle({ entityType: "Dimension", id: "d1", name: "区域" });
    expect(title).toBe("类型：维度\n名称：区域\n图谱 ID：d1");
    expect(title).not.toContain("undefined");
    expect(title).not.toContain("\n\n");
  });

  it("未知 entityType 回落原值呈现", () => {
    const title = semanticRefTitle({ entityType: "Glossary" as SemanticRef["entityType"], id: "g1", name: "术语" });
    expect(title).toContain("类型：Glossary");
  });

  it("空引用返回空串", () => {
    expect(semanticRefTitle(undefined)).toBe("");
    expect(semanticRefTitle(null)).toBe("");
  });
});

describe("semanticRefBadges：过滤 / 去重 / 排序", () => {
  it("Metric 优先，其后 Dimension、Col；同类型保持注入原序（排序稳定）", () => {
    const badges = semanticRefBadges([
      { entityType: "Col", id: "c1", name: "amount" },
      { entityType: "Dimension", id: "d2", code: "channel" },
      { entityType: "Metric", id: "m2", name: "订单数" },
      { entityType: "Dimension", id: "d1", code: "region" },
      { entityType: "Metric", id: "m1", code: "m_gmv" },
    ]);
    expect(badges.map((b) => b.key)).toEqual([
      "Metric:m2",
      "Metric:m1",
      "Dimension:d2",
      "Dimension:d1",
      "Col:c1",
    ]);
  });

  it("指标只给短名，非指标前缀类型名（避免把维度读成指标）", () => {
    const badges = semanticRefBadges([
      METRIC,
      { entityType: "Dimension", id: "d1", code: "region", name: "区域" },
      { entityType: "Col", id: "c1", name: "amount" },
    ]);
    expect(badges.map((b) => b.text)).toEqual(["m_gmv", "维度·region", "字段标准·amount"]);
    expect(badges.map((b) => b.label)).toEqual(["m_gmv", "region", "amount"]);
  });

  it("code/name 都缺的引用整条跳过（图谱 Col 注入行的常态）", () => {
    const badges = semanticRefBadges([METRIC, { entityType: "Col", id: "c1" }]);
    expect(badges).toHaveLength(1);
    expect(JSON.stringify(badges)).not.toContain("c1");
  });

  it("同一实体重复注入只留第一条（去重键 entityType:id，与语义边同口径）", () => {
    const badges = semanticRefBadges([METRIC, { ...METRIC }, { entityType: "Metric", id: "m-gmv", name: "销售额（改名）" }]);
    expect(badges).toHaveLength(1);
    expect(badges[0].label).toBe("m_gmv");
  });

  it("不同 entityType 同 ID 不互相吞掉", () => {
    const badges = semanticRefBadges([
      { entityType: "Metric", id: "x1", code: "a" },
      { entityType: "Dimension", id: "x1", code: "b" },
    ]);
    expect(badges.map((b) => b.key)).toEqual(["Metric:x1", "Dimension:x1"]);
  });

  it("无图谱 ID 时不参与去重，key 用序号兜底保证唯一（React key 不冲突）", () => {
    const badges = semanticRefBadges([
      { entityType: "Metric", id: "", name: "销售额" },
      { entityType: "Metric", id: "", name: "销售额" },
    ]);
    expect(badges).toHaveLength(2);
    expect(new Set(badges.map((b) => b.key)).size).toBe(2);
  });

  it("脏元素与非数组入参不抛错，返回可渲染的徽标", () => {
    const dirty = [null, undefined, "nope", 42, METRIC] as unknown as SemanticRef[];
    expect(semanticRefBadges(dirty)).toHaveLength(1);
    expect(semanticRefBadges(undefined)).toEqual([]);
    expect(semanticRefBadges(null)).toEqual([]);
    expect(semanticRefBadges("nope" as unknown as SemanticRef[])).toEqual([]);
  });

  it("徽标携带导出所需的完整字段（画布 hover 与导出表格同源）", () => {
    const [badge] = semanticRefBadges([METRIC]);
    expect(badge).toMatchObject({
      key: "Metric:m-gmv",
      entityType: "Metric",
      typeLabel: "指标",
      label: "m_gmv",
      text: "m_gmv",
      code: "m_gmv",
      name: "销售额",
      id: "m-gmv",
    });
  });

  it("折叠基准与关系小节同一交互范式（默认前 3 条）", () => {
    expect(MAX_VISIBLE_SEMANTIC_REFS).toBe(3);
  });
});
