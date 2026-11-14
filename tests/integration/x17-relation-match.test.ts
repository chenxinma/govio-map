/**
 * X17 档 A 集成测试：表间关系匹配的全限定名全等优先（消 X10 遗留①同名跨 catalog/schema 误配）。
 *
 * 契约是「既有用例不修改即通过」（table-relations.test.ts 27 例、canvas-store.test.ts、
 * table-relations-ui.test.ts），故本文件为纯增量，覆盖：
 *  - 服务端落键：resolveTableRelations 图谱分支按 `b.full_table_name` 原值补
 *    `targetQualifiedName`；图谱行没给 target 列（只有 tgt 等兜底形状）不建键；字段级
 *    降级路径不建键；relationsFromGraphRows 本体输出形状保持不变（落键只发生在
 *    withGraphQualifiedNames，既有 27 例不修改即通过）。
 *  - 三级匹配（src/utils/table-relations.ts）：①全等（大小写归一）命中即止；
 *    ②未命中退 tableKeyVariants 变体兜底；③都不中不建边。
 *  - 跨库同名端到端：fake runner 灌两行（sales.a.dim_product / sales.b.dim_product），
 *    边连到各自正确的目标；对照组去掉键（X10 行为）会同时连两张同名表——误配被消掉的实证。
 */
import { describe, it, expect } from "vitest";
import {
  relationsFromGraphRows,
  resolveTableRelations,
  withGraphQualifiedNames,
} from "../../server/table-relations.js";
import type { GraphRow } from "../../server/graph-query.js";
import {
  nodeTableRelations,
  relationExactTargetKey,
  sourceTableQualifiedNameKey,
  tableSemanticEdgeCandidates,
  type TableNodeLike,
} from "../../src/utils/table-relations.js";
import type { TableRelation } from "../../src/types/index.js";

// ── 夹具：跨库同名 dim_product（X10 遗留①误配演示形态） ──────────────────────────────

const FACT_A = "sales.a.fact_sales";
const FACT_B = "sales.b.fact_orders";
const DIM_A = "sales.a.dim_product";
const DIM_B = "sales.b.dim_product";

/** 图谱行：两条跨库同名 RELATES_TO（src 列模拟真实查询的 WHERE 过滤） */
const CROSS_ROWS: GraphRow[] = [
  { src: FACT_A, relationship_type: "many_to_one", description: "产品外键（a 库）", source_columns: "product_id", target: DIM_A, target_columns: "product_id" },
  { src: FACT_B, relationship_type: "many_to_one", description: "产品外键（b 库）", source_columns: "product_id", target: DIM_B, target_columns: "product_id" },
];

/** fake 图谱 runner：按 Cypher IN 列表中的 src 过滤行（模拟 WHERE），不调真实 CLI */
function crossCatalogRunner() {
  return async (cypher: string): Promise<GraphRow[]> =>
    CROSS_ROWS.filter((row) => {
      const src = String(row.src);
      const twoSegment = src.split(".").slice(1).join(".");
      return cypher.includes(`"${src}"`) || cypher.includes(`"${twoSegment}"`);
    });
}

const dimNode = (id: string, qualifiedName: string): TableNodeLike => ({
  id,
  data: { type: "sourceTable", tableName: qualifiedName.split(".").pop(), qualifiedName },
});

const factNode = (id: string, qualifiedName: string, tableRelations: TableRelation[]): TableNodeLike => ({
  id,
  data: { type: "sourceTable", tableName: qualifiedName.split(".").pop(), qualifiedName, tableRelations },
});

// ── 1. 服务端落键（resolveTableRelations 图谱路径） ──────────────────────────────────────

describe("X17 服务端落键：targetQualifiedName 取 b.full_table_name 原值", () => {
  it("图谱主路径：关系带 targetQualifiedName（= row.target 原值）", async () => {
    const res = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT_A, runQuery: crossCatalogRunner() });
    expect(res.source).toBe("graph");
    expect(res.relations).toHaveLength(1);
    expect(res.relations[0].targetTable).toBe(DIM_A);
    expect(res.relations[0].targetQualifiedName).toBe(DIM_A);
  });

  it("缺失 target 列的行（仅 tgt 兜底形状）→ 有 targetTable 不建键（禁止猜测）", () => {
    const rows: GraphRow[] = [{ src: FACT_A, relationship_type: "many_to_one", tgt: DIM_A }];
    const relations = withGraphQualifiedNames(relationsFromGraphRows(rows, FACT_A), rows);
    expect(relations).toHaveLength(1);
    expect(relations[0].targetTable).toBe(DIM_A);
    expect(Object.keys(relations[0])).not.toContain("targetQualifiedName");
  });

  it("字段级降级路径：不建键（X10 行为一字不改）", async () => {
    const res = await resolveTableRelations({
      tableName: "fact_sales",
      qualifiedName: FACT_A,
      fields: [{ name: "product_id", references: { table: "dim_product", field: "product_id" } }],
      runQuery: async () => {
        throw new Error("govio-cli unavailable");
      },
    });
    expect(res.source).toBe("fields");
    expect(res.relations[0].targetQualifiedName).toBeUndefined();
    expect(Object.keys(res.relations[0])).not.toContain("targetQualifiedName");
  });

  it("形状锁定：relationsFromGraphRows 本体不产 targetQualifiedName（落键只发生在取数层）", () => {
    const relations = relationsFromGraphRows(CROSS_ROWS, FACT_A);
    expect(relations).toHaveLength(2);
    for (const rel of relations) {
      expect(Object.keys(rel)).not.toContain("targetQualifiedName");
    }
  });

  it("边界：空关系数组原样返回；空白/非法 target 列不建键；命中 target 列集合才浅拷贝补键", () => {
    expect(withGraphQualifiedNames([], CROSS_ROWS)).toEqual([]);
    const rels: TableRelation[] = [{ targetTable: DIM_B, relationshipType: "many_to_one" }];
    expect(withGraphQualifiedNames(rels, [null as never, { src: FACT_A, target: "   " }])).toBe(rels);
    expect(withGraphQualifiedNames(rels, CROSS_ROWS)).toEqual([{ ...rels[0], targetQualifiedName: DIM_B }]);
  });
});

// ── 2. 三级匹配（前端纯函数） ────────────────────────────────────────────────────────────

describe("X17 三级匹配：全等命中即止 → 变体兜底 → 都不中不建边", () => {
  it("①全等命中即止：边只连全限定名一致的同名节点，另一张同名表不误连", () => {
    const rel: TableRelation = { targetTable: DIM_A, relationshipType: "many_to_one", targetQualifiedName: DIM_A };
    const fact = factNode("fact", FACT_A, [rel]);
    const dims = [dimNode("dim-a", DIM_A), dimNode("dim-b", DIM_B)];
    const candidates = tableSemanticEdgeCandidates(dims, fact);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("fact");
    expect(candidates[0].targetId).toBe("dim-a");
    expect(candidates[0].relations?.[0]).toEqual(rel);
  });

  it("对照（X10 行为）：同场景去掉键 → 裸表名变体把两张同名表都连上（误配基线）", () => {
    const legacy: TableRelation = { targetTable: DIM_A, relationshipType: "many_to_one" };
    const fact = factNode("fact", FACT_A, [legacy]);
    const dims = [dimNode("dim-a", DIM_A), dimNode("dim-b", DIM_B)];
    const candidates = tableSemanticEdgeCandidates(dims, fact);
    expect(candidates.map((c) => c.targetId).sort()).toEqual(["dim-a", "dim-b"]);
  });

  it("大小写归一：全等比较不区分大小写，误配同样被消除", () => {
    const rel: TableRelation = { targetTable: "Sales.A.Dim_Product", relationshipType: "many_to_one", targetQualifiedName: "Sales.A.Dim_Product" };
    const candidates = tableSemanticEdgeCandidates([dimNode("dim-a", DIM_A), dimNode("dim-b", DIM_B)], factNode("fact", FACT_A, [rel]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetId).toBe("dim-a");
  });

  it("②全等未命中退变体兜底：图谱段数与节点不一致、只有裸表名可对上时仍连边", () => {
    const rel: TableRelation = { targetTable: "dim_product", relationshipType: "many_to_one", targetQualifiedName: "warehouse.main.dim_product" };
    const candidates = tableSemanticEdgeCandidates([dimNode("dim-a", DIM_A)], factNode("fact", FACT_A, [rel]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetId).toBe("dim-a");
  });

  it("②旧节点兜底：节点无 qualifiedName（T2.0 旧形状）时按裸表名仍可连边、不报错", () => {
    const legacyNode: TableNodeLike = { id: "dim-bare", data: { type: "sourceTable", tableName: "dim_product" } };
    const rel: TableRelation = { targetTable: "dim_product", relationshipType: "foreign_key", targetQualifiedName: DIM_A };
    const candidates = tableSemanticEdgeCandidates([legacyNode], factNode("fact", FACT_A, [rel]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetId).toBe("dim-bare");
  });

  it("③都不中不建边：全限定名与变体都和画布节点无交集时什么都不产出", () => {
    const rel: TableRelation = { targetTable: "sales.z.dim_widget", relationshipType: "many_to_one", targetQualifiedName: "sales.z.dim_widget" };
    expect(tableSemanticEdgeCandidates([dimNode("dim-a", DIM_A), dimNode("dim-b", DIM_B)], factNode("fact", FACT_A, [rel]))).toEqual([]);
  });

  it("反向（既有→新）：dim 表后上画布时带键关系全等命中，只连 dim-a", () => {
    const rel: TableRelation = { targetTable: DIM_A, relationshipType: "many_to_one", targetQualifiedName: DIM_A };
    const fact = factNode("fact", FACT_A, [rel]);
    const candidates = tableSemanticEdgeCandidates([fact, dimNode("dim-b", DIM_B)], dimNode("dim-a", DIM_A));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("fact");
    expect(candidates[0].targetId).toBe("dim-a");
  });

  it("键透传：nodeTableRelations 保留合法 targetQualifiedName、过滤非法形状", () => {
    const node: TableNodeLike = {
      id: "n",
      data: {
        type: "sourceTable",
        tableName: "fact",
        tableRelations: [
          { targetTable: "t", relationshipType: "x", targetQualifiedName: "db.s.t" },
          { targetTable: "u", relationshipType: "x", targetQualifiedName: 42 },
        ],
      },
    };
    const rels = nodeTableRelations(node);
    expect(rels[0].targetQualifiedName).toBe("db.s.t");
    expect(Object.keys(rels[1])).not.toContain("targetQualifiedName");
  });

  it("助手键归一：relationExactTargetKey / sourceTableQualifiedNameKey 空值与非法形状返回 undefined", () => {
    expect(relationExactTargetKey({ targetTable: "t", relationshipType: "x" })).toBeUndefined();
    expect(relationExactTargetKey({ targetTable: "t", relationshipType: "x", targetQualifiedName: "  " })).toBeUndefined();
    expect(relationExactTargetKey({ targetTable: "t", relationshipType: "x", targetQualifiedName: " A.B " })).toBe("a.b");
    expect(sourceTableQualifiedNameKey(dimNode("d", "Sales.A.T"))).toBe("sales.a.t");
    expect(sourceTableQualifiedNameKey({ id: "x", data: { type: "sqlQuery", qualifiedName: "a.b" } })).toBeUndefined();
    expect(sourceTableQualifiedNameKey({ id: "x", data: { type: "sourceTable", tableName: "t" } })).toBeUndefined();
  });
});

// ── 3. 端到端跨库同名：fake runner 两行，边连到正确的那一个 ──────────────────────────────

describe("X17 端到端：同名跨库（sales.a.dim_product vs sales.b.dim_product），边连对目标", () => {
  it("fact_b 后上画布：唯一边连到 dim-b，同名 dim-a 不误连", async () => {
    const res = await resolveTableRelations({ tableName: "fact_orders", qualifiedName: FACT_B, runQuery: crossCatalogRunner() });
    expect(res.relations).toHaveLength(1);
    expect(res.relations[0].targetQualifiedName).toBe(DIM_B);
    const dims = [dimNode("dim-a", DIM_A), dimNode("dim-b", DIM_B), factNode("fact-a", FACT_A, [])];
    const candidates = tableSemanticEdgeCandidates(dims, factNode("fact-b", FACT_B, res.relations));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceId).toBe("fact-b");
    expect(candidates[0].targetId).toBe("dim-b");
  });

  it("两条跨库同名关系各自独立落键：a 库事实表连 dim-a、b 库事实表连 dim-b（互不串线）", async () => {
    const resA = await resolveTableRelations({ tableName: "fact_sales", qualifiedName: FACT_A, runQuery: crossCatalogRunner() });
    const resB = await resolveTableRelations({ tableName: "fact_orders", qualifiedName: FACT_B, runQuery: crossCatalogRunner() });
    expect(resA.relations[0].targetQualifiedName).toBe(DIM_A);
    expect(resB.relations[0].targetQualifiedName).toBe(DIM_B);
    const dimA = dimNode("dim-a", DIM_A);
    const dimB = dimNode("dim-b", DIM_B);
    const factA = factNode("fact-a", FACT_A, resA.relations);
    const factB = factNode("fact-b", FACT_B, resB.relations);
    expect(tableSemanticEdgeCandidates([dimA, dimB], factA).map((c) => c.targetId)).toEqual(["dim-a"]);
    expect(tableSemanticEdgeCandidates([dimA, dimB, factA], factB).map((c) => c.targetId)).toEqual(["dim-b"]);
  });
});