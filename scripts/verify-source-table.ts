/**
 * T2.0 验证脚本：sourceTable 数据源标注字段（datasource/datasourceType/schema/qualifiedName）
 * 全链路贯通 + 旧节点向后兼容。
 *
 * 复跑：`npm run verify:source-table`（等价于 `npx tsx scripts/verify-source-table.ts`）
 *
 * 覆盖链路：
 *  1. govio_create_source_table 工具契约：新参数全部 Optional（旧调用形状不变），
 *     description 含"来源约束/禁止猜测/省略"指导
 *  2. stub pi 驱动工具 execute -> 节点事件：新字段透传；枚举外 datasourceType 被丢弃；
 *     旧参数调用不产生新键
 *  3. 事件 JSON 上屏（模拟 ws-handler `{type:"govio_node_create", ...node}` 广播）字段不丢
 *  4. canvas-store.createGovioNode：新字段写入 node.data；旧事件不建键（回退旧形状）
 *  5. saveCanvas -> loadCanvas（canvas sidecar）往返：标注字段深度相等；旧节点原样
 *  6. clearCanvas -> hydrateSession（会话重开）：标注字段完整恢复；旧节点兼容
 *
 * 任一断言失败退出码为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import govioCanvasExtension from "../server/extensions/govio-canvas.js";
import { flushGovioNodes, type GovioNodeCreateEvent } from "../server/govio-node-queue.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../server/session-history.js";
import { DATASOURCE_TYPES } from "../src/types/index.js";
import type { CanvasEvent } from "../src/services/canvas-service.js";
import type { Node, Edge } from "@xyflow/react";

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── stub pi：捕获注册的工具与事件处理器 ────────────────────────────────────

interface StubTool {
  name: string;
  description?: string;
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: never) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

const tools = new Map<string, StubTool>();
const handlers = new Map<string, unknown>();
const piStub = {
  registerTool: (tool: StubTool) => { tools.set(tool.name, tool); },
  on: (name: string, handler: unknown) => { handlers.set(name, handler); return () => {}; },
};
govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0]);

const createSourceTable = tools.get("govio_create_source_table");

// chocolate 实证案例（docs/tasks/BUGFIX-load-parse.md）：DuckDB 文件库三段式限定名
const FULL_PARAMS = {
  tableName: "chocolate.dim_product",
  database: "chocolate",
  datasource: "chocolate",
  datasourceType: "duckdb",
  schema: "chocolate",
  qualifiedName: "chocolate.chocolate.dim_product",
  fields: [
    { name: "product_id", type: "VARCHAR", description: "产品ID" },
    { name: "product_name", type: "VARCHAR", description: "产品名称" },
  ],
};

// 旧调用形状（T2.0 之前的 agent 只会传这三个参数）
const LEGACY_PARAMS = {
  tableName: "orders",
  database: "sales",
  fields: [{ name: "order_id", type: "BIGINT" }],
};

console.log("\n[1] govio_create_source_table 工具契约（向后兼容 + 描述指导）");
check("扩展同时注册了 tool_result / message_end 处理器（stub 完整性）", handlers.has("tool_result") && handlers.has("message_end"));
check("工具已注册", createSourceTable !== undefined);
check(
  "新参数全部 Optional（required 仍只有 tableName/fields）",
  JSON.stringify(createSourceTable?.parameters.required ?? []) === JSON.stringify(["tableName", "fields"]),
  `required=${JSON.stringify(createSourceTable?.parameters.required)}`,
);
for (const p of ["datasource", "datasourceType", "schema", "qualifiedName"]) {
  check(`参数 schema 含 ${p}`, p in (createSourceTable?.parameters.properties ?? {}));
}
{
  const desc = createSourceTable?.description ?? "";
  check("description 指导取值来源（图谱/声明/config.yaml）", desc.includes("Datasource node") && desc.includes("config.yaml"));
  check("description 明确禁止猜测", desc.includes("NEVER guessed"));
  check("description 明确拿不到就省略", desc.includes("OMIT"));
  check("description 含 duckdb 三段式规则与实证案例", desc.includes("catalog.schema.table") && desc.includes("chocolate.chocolate.dim_product"));
  check("description 含 postgres/mysql 引用规则", desc.includes("schema.table") && desc.includes("db.table"));
  check("DATASOURCE_TYPES 枚举与任务契约一致", JSON.stringify([...DATASOURCE_TYPES]) === JSON.stringify(["duckdb", "postgres", "mysql", "oracle", "hive", "trino", "sqlalchemy-generic", "unknown"]));
}

// ── 2. 工具 execute -> 节点事件 ────────────────────────────────────────────

console.log("\n[2] execute -> 节点事件（透传 / 枚举校验 / 旧调用）");
let fullEvent: GovioNodeCreateEvent | undefined;
{
  const result = await createSourceTable?.execute("call-full", FULL_PARAMS as never);
  const events = flushGovioNodes();
  fullEvent = events.find((e) => e.nodeType === "sourceTable");
  check("全参数调用生成 sourceTable 事件", fullEvent !== undefined && events.length === 1);
  check("事件透传 datasource", fullEvent?.datasource === "chocolate");
  check("事件透传 datasourceType", fullEvent?.datasourceType === "duckdb");
  check("事件透传 schema", fullEvent?.schema === "chocolate");
  check("事件透传 qualifiedName", fullEvent?.qualifiedName === "chocolate.chocolate.dim_product");
  check("原有字段不受影响", fullEvent?.tableName === "chocolate.dim_product" && fullEvent?.database === "chocolate" && fullEvent?.fields?.length === 2);
  check("execute 回执含 qualifiedName（agent 可确认落盘值）", (result?.content[0]?.text ?? "").includes("chocolate.chocolate.dim_product"));
}
{
  await createSourceTable?.execute("call-legacy", LEGACY_PARAMS as never);
  const legacyEvent = flushGovioNodes().find((e) => e.nodeType === "sourceTable");
  check("旧参数调用仍生成事件", legacyEvent !== undefined);
  check("旧参数调用不产生新键（datasource/datasourceType/schema/qualifiedName 全缺省）",
    legacyEvent !== undefined
    && !("datasource" in legacyEvent) && !("datasourceType" in legacyEvent)
    && !("schema" in legacyEvent) && !("qualifiedName" in legacyEvent));
  check("旧参数调用 database 行为不变", legacyEvent?.database === "sales");
}
{
  await createSourceTable?.execute("call-bad-type", { ...FULL_PARAMS, datasourceType: "tds" } as never);
  const badEvent = flushGovioNodes().find((e) => e.nodeType === "sourceTable");
  check("枚举外 datasourceType（tds）被丢弃而非落盘", badEvent !== undefined && !("datasourceType" in badEvent));
  check("其余标注字段不受枚举校验影响", badEvent?.qualifiedName === "chocolate.chocolate.dim_product");
}

// ── 3. 事件 JSON 上屏（模拟 ws-handler 广播形状）──────────────────────────

console.log("\n[3] 事件 -> WS 广播 JSON（{type:'govio_node_create', ...event}）");
const wireJson = JSON.stringify({ type: "govio_node_create", ...fullEvent });
{
  const wire = JSON.parse(wireJson) as Record<string, unknown>;
  check("广播 JSON 携带 qualifiedName", wire.qualifiedName === "chocolate.chocolate.dim_product");
  check("广播 JSON 携带 datasource/datasourceType/schema",
    wire.datasource === "chocolate" && wire.datasourceType === "duckdb" && wire.schema === "chocolate");
}

// ── 4-6. store 建节点 -> sidecar 往返 -> hydrateSession ───────────────────

console.log("\n[4] canvas-store.createGovioNode 写入 node.data");
const { useCanvasStore } = await import("../src/store/canvas-store.js");
const dir = mkdtempSync(join(tmpdir(), "govio-source-table-"));
const sessionFile = join(dir, "2026-10-31_source-table.jsonl");
try {
  useCanvasStore.getState().clearCanvas();
  // 带标注的事件（走 [3] 验证过的 wire 形状）
  useCanvasStore.getState().createGovioNode(JSON.parse(wireJson) as CanvasEvent);
  // 旧事件（无新字段）
  useCanvasStore.getState().createGovioNode({
    type: "govio_node_create",
    nodeType: "sourceTable",
    title: "orders",
    tableName: "orders",
    database: "sales",
    fields: [{ name: "order_id", type: "BIGINT", nullable: false }],
  });

  const saved = useCanvasStore.getState();
  const annotated = saved.nodes.find((n) => (n.data as { tableName?: string }).tableName === "chocolate.dim_product");
  const legacy = saved.nodes.find((n) => (n.data as { tableName?: string }).tableName === "orders");
  check("store 建出 2 个 sourceTable 节点", saved.nodes.length === 2 && annotated !== undefined && legacy !== undefined);
  const ad = annotated?.data as Record<string, unknown>;
  check("node.data 写入 datasource/datasourceType", ad.datasource === "chocolate" && ad.datasourceType === "duckdb");
  check("node.data 写入 schema/qualifiedName", ad.schema === "chocolate" && ad.qualifiedName === "chocolate.chocolate.dim_product");
  check("旧事件节点不建新键（UI 回退旧显示的前提）",
    legacy !== undefined
    && !("datasource" in (legacy.data as object)) && !("datasourceType" in (legacy.data as object))
    && !("schema" in (legacy.data as object)) && !("qualifiedName" in (legacy.data as object)));
  check("旧事件节点原有字段完整", (legacy?.data as Record<string, unknown>).tableName === "orders" && (legacy?.data as Record<string, unknown>).database === "sales");

  console.log("\n[5] saveCanvas -> loadCanvas 往返（canvas sidecar）");
  saveCanvas(sessionFile, saved.nodes, saved.edges);
  const loaded = loadCanvas(sessionFile);
  check("sidecar 可读回", loaded !== null, `path=${canvasPathFor(sessionFile)}`);
  const loadedNodes = (loaded?.nodes ?? []) as Node[];
  const loadedAnnotated = loadedNodes.find((n) => (n.data as { tableName?: string }).tableName === "chocolate.dim_product");
  const loadedLegacy = loadedNodes.find((n) => (n.data as { tableName?: string }).tableName === "orders");
  check("往返后标注字段深度相等",
    JSON.stringify({
      datasource: (loadedAnnotated?.data as Record<string, unknown>).datasource,
      datasourceType: (loadedAnnotated?.data as Record<string, unknown>).datasourceType,
      schema: (loadedAnnotated?.data as Record<string, unknown>).schema,
      qualifiedName: (loadedAnnotated?.data as Record<string, unknown>).qualifiedName,
    }) === JSON.stringify({
      datasource: "chocolate",
      datasourceType: "duckdb",
      schema: "chocolate",
      qualifiedName: "chocolate.chocolate.dim_product",
    }));
  check("往返后旧节点仍无新键（历史 sidecar 兼容）",
    loadedLegacy !== undefined
    && !("qualifiedName" in (loadedLegacy.data as object)) && !("datasourceType" in (loadedLegacy.data as object)));

  console.log("\n[6] clearCanvas -> hydrateSession（会话重开）");
  useCanvasStore.getState().clearCanvas();
  check("画布已清空", useCanvasStore.getState().nodes.length === 0);
  useCanvasStore.getState().hydrateSession(loadedNodes, (loaded?.edges ?? []) as Edge[]);
  const restored = useCanvasStore.getState();
  const restoredAnnotated = restored.nodes.find((n) => (n.data as { tableName?: string }).tableName === "chocolate.dim_product");
  const restoredLegacy = restored.nodes.find((n) => (n.data as { tableName?: string }).tableName === "orders");
  check("会话重开后 qualifiedName 完整恢复", (restoredAnnotated?.data as Record<string, unknown>).qualifiedName === "chocolate.chocolate.dim_product");
  check("会话重开后 datasource/datasourceType/schema 完整恢复",
    (restoredAnnotated?.data as Record<string, unknown>).datasource === "chocolate"
    && (restoredAnnotated?.data as Record<string, unknown>).datasourceType === "duckdb"
    && (restoredAnnotated?.data as Record<string, unknown>).schema === "chocolate");
  check("会话重开后旧节点兼容（无新键、原字段完整）",
    restoredLegacy !== undefined
    && !("qualifiedName" in (restoredLegacy.data as object))
    && (restoredLegacy.data as Record<string, unknown>).tableName === "orders");
} finally {
  useCanvasStore.getState().clearCanvas();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: sourceTable 数据源标注全链路贯通，旧节点兼容");
