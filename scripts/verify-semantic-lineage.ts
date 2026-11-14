/**
 * T2.2 验证脚本：口径溯源与语义血缘（semanticRefs 归因链路 + 血缘边分类）。
 *
 * 复跑：`npm run verify:semantic-lineage`（等价于 `npx tsx scripts/verify-semantic-lineage.ts`）
 *
 * 覆盖链路：
 *  1. 归因模块（server/semantic-context）：GraphEntity → SemanticRef 映射（code/name
 *     缺失省略键）、按 sessionId 暂存/读取/清除、空注入不建键
 *  2. 归因链路（stub pi 驱动 govio-canvas 的 message_end）：注入上下文 → sqlQuery
 *     节点事件带 semanticRefs（一消息多代码块共享）；无注入/steer 路径（不写入）、
 *     会话归因缺失 → 不产生 semanticRefs 键
 *  3. 事件 JSON 上屏 → canvas-store.createGovioNode：semanticRefs 透传 node.data；
 *     旧事件不建键
 *  4. saveCanvas -> loadCanvas（canvas sidecar）-> hydrateSession 往返：semanticRefs
 *     与边 data.lineageKind 深度相等
 *  5. 边分类：semanticRefs 交集建语义边（id 加 -sem 后缀，与数据边并存不冲突）、
 *     无交集不建；旧边/手动连线回退 "data"；lineageKind -> 样式映射可断言
 *  6. 导出区分：LineageEdgeView 按 lineageKind 分类，导出 HTML 两种边样式可观测
 *  7. X18 口径徽标：同一份 semanticRefs 的展示模型（Metric 优先 / code 优先 name 回退 /
 *     无短名跳过 / 去重 / hover 全文）与导出 HTML 的「口径引用」小节
 *
 * 不调 govio-cli、不调模型、不碰 `.govio/`。任一断言失败退出码为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import govioCanvasExtension from "../server/extensions/govio-canvas.js";
import { flushGovioNodes, type GovioNodeCreateEvent } from "../server/govio-node-queue.js";
import {
  clearSessionSemanticRefs,
  getSessionSemanticRefs,
  setSessionSemanticRefs,
  toSemanticRefs,
} from "../server/semantic-context.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../server/session-history.js";
import { lineageEdgeAppearance, lineageKindOf, SEMANTIC_SOURCE_HANDLE, SEMANTIC_TARGET_HANDLE } from "../src/utils/lineage.js";
import { semanticRefBadges } from "../src/utils/semantic-refs-ui.js";
import { buildDeliveryReportHtml, layoutLineage } from "../src/utils/export-report.js";
import type { CanvasEvent } from "../src/services/canvas-service.js";
import type { SemanticRef } from "../src/types/index.js";
import type { Edge, Node } from "@xyflow/react";

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

const REFS: SemanticRef[] = [
  { entityType: "Metric", id: "m1", code: "gmv", name: "销售额" },
  { entityType: "Col", id: "c1" },
];

// ── 1. 归因模块（semantic-context）────────────────────────────────────────

console.log("\n[1] semantic-context：GraphEntity -> SemanticRef 映射与暂存");
{
  const mapped = toSemanticRefs([
    { entityType: "Metric", id: "m1", code: "gmv", name: "销售额" },
    { entityType: "Col", id: "c1" },
  ]);
  check("映射保留 entityType/id/code/name", JSON.stringify(mapped) === JSON.stringify(REFS));
  const sparse = toSemanticRefs([{ entityType: "Dimension", id: "d1" }]);
  check("code/name 缺失即省略键（不写 undefined）",
    JSON.stringify(sparse) === JSON.stringify([{ entityType: "Dimension", id: "d1" }]));
  check("空注入返回空数组", toSemanticRefs([]).length === 0);
}
{
  setSessionSemanticRefs("sess-1", REFS);
  check("按 sessionId 暂存并读回", JSON.stringify(getSessionSemanticRefs("sess-1")) === JSON.stringify(REFS));
  clearSessionSemanticRefs("sess-1");
  check("clear 后读回 undefined（steer/followUp 不得串到上一轮口径）", getSessionSemanticRefs("sess-1") === undefined);
  setSessionSemanticRefs("sess-1", REFS);
  setSessionSemanticRefs("sess-1", []);
  check("空 refs 写入等价于清除（无可归因内容）", getSessionSemanticRefs("sess-1") === undefined);
  setSessionSemanticRefs("", REFS);
  check("空 sessionId 不可归因", getSessionSemanticRefs("") === undefined);
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
// T2.3：message_end 会按 semanticRefs 调口径比对 CLI；本脚本只验 semanticRefs，
// 注入恒失败的 stub 使其走「失败降级省略键」路径，保持脚本不真调 govio-cli（断言不变）。
govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0], {
  runCaliberCli: () => Promise.reject(new Error("caliber CLI disabled in verify:semantic-lineage")),
});

type MessageEndHandler = (event: { message: Record<string, unknown> }, ctx: unknown) => void;

/** 驱动 message_end：一次 assistant 消息产出 sqlQuery 节点事件 */
function runMessageEnd(sessionId: string | null, text: string): GovioNodeCreateEvent[] {
  const handler = handlers.get("message_end") as MessageEndHandler | undefined;
  if (!handler) return [];
  const ctx = sessionId === null
    // getSessionId 抛错（会话未落盘）→ piSessionContext 兜底为空串，归因缺失
    ? { sessionManager: { getSessionId: () => { throw new Error("no session"); } }, model: {} }
    : { sessionManager: { getSessionId: () => sessionId }, model: {} };
  handler(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1762000000000,
        provider: "stub",
        model: "stub-model",
      },
    },
    ctx,
  );
  return flushGovioNodes();
}

const SQL_TEXT = "分析如下：\n```sql\nSELECT product_id, SUM(amount) AS sales FROM dim_order GROUP BY 1\n```\n";
const SQL_TEXT_TWO = `${SQL_TEXT}\n再来一个：\n\`\`\`sql\nSELECT region, COUNT(*) AS n FROM dim_order GROUP BY 1\n\`\`\`\n`;

// ── 2. 归因链路（message_end）────────────────────────────────────────────

console.log("\n[2] 归因：注入上下文 -> message_end -> sqlQuery 事件 semanticRefs");
check("扩展注册了 message_end 处理器（stub 完整性）", handlers.has("message_end"));
{
  setSessionSemanticRefs("sess-1", REFS);
  const events = runMessageEnd("sess-1", SQL_TEXT);
  check("注入后建 sqlQuery 事件", events.length === 1 && events[0].nodeType === "sqlQuery");
  check("事件带 semanticRefs（深度相等）", JSON.stringify(events[0]?.semanticRefs) === JSON.stringify(REFS));
  check("原有字段不受影响（manifest 仍填充）", events[0]?.manifest !== undefined);
}
{
  setSessionSemanticRefs("sess-1", REFS);
  const events = runMessageEnd("sess-1", SQL_TEXT_TWO);
  check("一消息两个代码块都建节点", events.length === 2);
  check("同一消息多个代码块共享 message 级 semanticRefs",
    events.every((e) => JSON.stringify(e.semanticRefs) === JSON.stringify(REFS)));
}
{
  clearSessionSemanticRefs("sess-1");
  const events = runMessageEnd("sess-1", SQL_TEXT);
  check("无注入（steer/followUp 路径）不产生 semanticRefs 键",
    events.length === 1 && events[0] !== undefined && !("semanticRefs" in events[0]));
}
{
  const events = runMessageEnd("sess-never-set", SQL_TEXT);
  check("归因缺失（从未写入的会话）不产生 semanticRefs 键",
    events.length === 1 && !("semanticRefs" in events[0]));
}
{
  setSessionSemanticRefs("sess-1", REFS);
  const events = runMessageEnd("sess-2", SQL_TEXT);
  check("跨会话不串口径（sessionId 不匹配不写键）",
    events.length === 1 && !("semanticRefs" in events[0]));
  const eventsThrow = runMessageEnd(null, SQL_TEXT);
  check("getSessionId 抛错时归因缺失不写键",
    eventsThrow.length === 1 && !("semanticRefs" in eventsThrow[0]));
  clearSessionSemanticRefs("sess-1");
}

// ── 3. 事件 -> WS 广播 JSON -> createGovioNode 透传 ───────────────────────

console.log("\n[3] 事件 -> node.data 透传（含旧事件兼容）");
const { useCanvasStore } = await import("../src/store/canvas-store.js");
const wireJson = JSON.stringify({
  type: "govio_node_create",
  nodeType: "sqlQuery",
  title: "Q: order",
  sql: "SELECT product_id, SUM(amount) AS sales FROM dim_order GROUP BY 1",
  outputColumns: ["product_id", "sales"],
  semanticRefs: REFS,
} satisfies CanvasEvent);
const legacyJson = JSON.stringify({
  type: "govio_node_create",
  nodeType: "sqlQuery",
  title: "Q: legacy",
  sql: "SELECT 1",
  outputColumns: ["1"],
});
try {
  useCanvasStore.getState().clearCanvas();
  useCanvasStore.getState().createGovioNode(JSON.parse(wireJson) as CanvasEvent);
  useCanvasStore.getState().createGovioNode(JSON.parse(legacyJson) as CanvasEvent);
  const saved = useCanvasStore.getState();
  const annotated = saved.nodes.find((n) => (n.data as { title?: string }).title === "Q: order");
  const legacy = saved.nodes.find((n) => (n.data as { title?: string }).title === "Q: legacy");
  check("node.data 写入 semanticRefs（深度相等）",
    JSON.stringify((annotated?.data as Record<string, unknown>).semanticRefs) === JSON.stringify(REFS));
  check("旧事件节点不建键（UI 回退旧显示的前提）",
    legacy !== undefined && !("semanticRefs" in (legacy.data as object)));

  // ── 4. sidecar 往返 + hydrateSession ────────────────────────────────────

  console.log("\n[4] saveCanvas -> loadCanvas -> hydrateSession 往返");
  const dir = mkdtempSync(join(tmpdir(), "govio-semantic-lineage-"));
  const sessionFile = join(dir, "2026-11-06_semantic-lineage.jsonl");
  try {
    saveCanvas(sessionFile, saved.nodes, saved.edges);
    const loaded = loadCanvas(sessionFile);
    check("sidecar 可读回", loaded !== null, `path=${canvasPathFor(sessionFile)}`);
    const loadedNodes = (loaded?.nodes ?? []) as Node[];
    const loadedAnnotated = loadedNodes.find((n) => (n.data as { title?: string }).title === "Q: order");
    check("往返后 semanticRefs 深度相等",
      JSON.stringify((loadedAnnotated?.data as Record<string, unknown>).semanticRefs) === JSON.stringify(REFS));
    const loadedLegacy = loadedNodes.find((n) => (n.data as { title?: string }).title === "Q: legacy");
    check("往返后旧节点仍无 semanticRefs 键（历史 sidecar 兼容）",
      loadedLegacy !== undefined && !("semanticRefs" in (loadedLegacy.data as object)));

    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().hydrateSession(loadedNodes, (loaded?.edges ?? []) as Edge[]);
    const restored = useCanvasStore.getState().nodes.find((n) => (n.data as { title?: string }).title === "Q: order");
    check("会话重开后 semanticRefs 完整恢复",
      JSON.stringify((restored?.data as Record<string, unknown>).semanticRefs) === JSON.stringify(REFS));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── 5. 边分类（语义边创建 / 回退 / 样式映射）───────────────────────────

  console.log("\n[5] 血缘边分类：semanticRefs 交集建语义边，数据/语义并存");
  useCanvasStore.getState().clearCanvas();
  const store = useCanvasStore.getState;
  const create = (event: Record<string, unknown>) =>
    useCanvasStore.getState().createGovioNode({ type: "govio_node_create", ...event } as CanvasEvent);
  const nodeByTitle = (title: string) =>
    store().nodes.find((n) => (n.data as { title?: string }).title === title);
  const edgeById = (id: string) => store().edges.find((e) => e.id === id);

  create({ nodeType: "sqlQuery", title: "Q: A", sql: "SELECT 1", outputColumns: ["1"], semanticRefs: [REFS[0]] });
  create({ nodeType: "sqlQuery", title: "Q: B", sql: "SELECT 2", outputColumns: ["2"], semanticRefs: REFS });
  const a = nodeByTitle("Q: A");
  const b = nodeByTitle("Q: B");
  const semAB = edgeById(`e-${a?.id}-${b?.id}-sem`);
  check("交集命中建语义边（source 旧 → target 新）",
    semAB !== undefined && semAB.source === a?.id && semAB.target === b?.id);
  check("语义边标记 lineageKind:semantic", (semAB?.data as Record<string, unknown>)?.lineageKind === "semantic");
  check("语义边携带专用 Handle id（端口方向由节点组件决定，见 lineage.ts）",
    semAB?.sourceHandle === SEMANTIC_SOURCE_HANDLE && semAB?.targetHandle === SEMANTIC_TARGET_HANDLE);
  check("语义边形状随 APPEARANCE.edgeType（样式唯一来源，不硬编码具体值）",
    semAB?.type === lineageEdgeAppearance("semantic").edgeType);
  check("语义边与数据边 id 不冲突（-sem 后缀）", edgeById(`e-${a?.id}-${b?.id}`) === undefined && semAB !== undefined);

  create({ nodeType: "sqlQuery", title: "Q: C", sql: "SELECT 3", outputColumns: ["3"], semanticRefs: [{ entityType: "Col", id: "c9" }] });
  const c = nodeByTitle("Q: C");
  check("无交集不建语义边", !store().edges.some((e) => e.target === c?.id && e.id.endsWith("-sem")));

  create({
    nodeType: "sqlQuery", title: "Q: D", sql: "SELECT 4", outputColumns: ["4"],
    semanticRefs: [REFS[0]],
    referencedNodes: [{ nodeId: a?.id, label: "Q: A" }],
  });
  const d = nodeByTitle("Q: D");
  const dataAD = edgeById(`e-${a?.id}-${d?.id}`);
  const semAD = edgeById(`e-${a?.id}-${d?.id}-sem`);
  check("同一对节点数据边与语义边并存（id 各自独立）",
    dataAD !== undefined && semAD !== undefined && dataAD.id !== semAD.id);
  check("数据边 lineageKind:data、语义边 lineageKind:semantic",
    (dataAD?.data as Record<string, unknown>)?.lineageKind === "data"
    && (semAD?.data as Record<string, unknown>)?.lineageKind === "semantic");
  check("数据边走默认左右 Handle（不带 handle 键）+ smoothstep",
    dataAD?.sourceHandle === undefined && dataAD?.targetHandle === undefined
    && dataAD?.type === lineageEdgeAppearance("data").edgeType);
  check("交集按 entityType+id 判等（B 与 D 共享 Metric:m1 也建边）",
    edgeById(`e-${b?.id}-${d?.id}-sem`) !== undefined);

  console.log("\n[5b] 手动连线与旧边回退 + 样式映射");
  useCanvasStore.getState().onConnect({ source: c?.id ?? "", target: d?.id ?? "", sourceHandle: null, targetHandle: null });
  const manual = store().edges.find((e) => e.source === c?.id && e.target === d?.id && !e.id.endsWith("-sem"));
  check("手动 onConnect 连线按数据血缘处理", manual !== undefined && lineageKindOf(manual) === "data");
  check("旧边（无 data）回退 data 血缘", lineageKindOf({ id: "old", source: "x", target: "y" } as Edge) === "data");
  check("data.lineageKind:data 显式标记同样判 data", lineageKindOf({ data: { lineageKind: "data" } }) === "data");
  check("未知 lineageKind 值回退 data", lineageKindOf({ data: { lineageKind: "other" } }) === "data");

  const dataApp = lineageEdgeAppearance("data");
  const semApp = lineageEdgeAppearance("semantic");
  check("数据血缘样式：绿色实线动画（与现状一致）",
    dataApp.stroke === "#1db954" && dataApp.strokeWidth === 2 && dataApp.animated && dataApp.strokeDasharray === undefined);
  check("语义血缘样式：虚线 + 不同色相 + 不流动",
    semApp.strokeDasharray !== undefined && semApp.stroke !== dataApp.stroke && !semApp.animated);
  check("样式映射可从图例文案区分两种边", dataApp.label === "数据血缘" && semApp.label === "语义血缘");
  check("语义边实际样式取自映射函数（色值 + 虚线可观测）",
    (semAD?.style as Record<string, unknown>)?.stroke === semApp.stroke
    && (semAD?.style as Record<string, unknown>)?.strokeDasharray === semApp.strokeDasharray);
  check("数据边样式维持现状（绿色实线）", (dataAD?.style as Record<string, unknown>)?.stroke === "#1db954");
  check("边 data.lineageKind 随 JSON 往返（sidecar 形态）不丢",
    (() => {
      const roundTripped = JSON.parse(JSON.stringify(store().edges)) as Edge[];
      const rtSem = roundTripped.find((e) => e.id === semAD?.id);
      return rtSem !== undefined && lineageKindOf(rtSem) === "semantic";
    })());
} finally {
  useCanvasStore.getState().clearCanvas();
}

// ── 6. 导出区分（LineageEdgeView + HTML 样式）────────────────────────────

console.log("\n[6] 导出 HTML：按 lineageKind 区分两种边");
const EXPORT_NODES: Node[] = [
  { id: "n1", type: "sqlQuery", position: { x: 0, y: 0 }, data: { type: "sqlQuery", title: "Q: one", createdAt: "2026-11-06T10:00:00Z", sql: "SELECT 1", outputColumns: ["1"] } },
  { id: "n2", type: "sqlQuery", position: { x: 300, y: 0 }, data: { type: "sqlQuery", title: "Q: two", createdAt: "2026-11-06T10:01:00Z", sql: "SELECT 2", outputColumns: ["2"] } },
];
const EXPORT_EDGES: Edge[] = [
  { id: "e-data", source: "n1", target: "n2", data: { lineageKind: "data" } },
  { id: "e-sem", source: "n1", target: "n2", data: { lineageKind: "semantic" } },
  { id: "e-legacy", source: "n1", target: "n2" },
];
{
  const layout = layoutLineage(EXPORT_NODES, EXPORT_EDGES);
  const kinds = layout.edges.map((e) => `${e.id}:${e.lineageKind}`);
  check("LineageEdgeView 携带 lineageKind", kinds.includes("e-data:data") && kinds.includes("e-sem:semantic"));
  check("旧边导出按 data 处理", kinds.includes("e-legacy:data"));
}
{
  const HTML = buildDeliveryReportHtml({
    nodes: EXPORT_NODES,
    edges: EXPORT_EDGES,
    exportedAt: "2026-11-06T12:00:00+08:00",
    audit: null,
  });
  check("语义边：紫色虚线 + 专属箭头 marker",
    HTML.includes(`stroke="${lineageEdgeAppearance("semantic").stroke}"`)
    && HTML.includes('stroke-dasharray="6 4"')
    && HTML.includes('marker-end="url(#govio-arrow-sem)"'));
  check("数据边：绿色实线样式维持现状",
    HTML.includes('stroke="#1db954"') && HTML.includes('marker-end="url(#govio-arrow)"'));
  check("血缘图图例含两种边说明", HTML.includes("数据血缘") && HTML.includes("语义血缘"));
}

// ── 7. X18 口径徽标（semanticRefs 的展示模型 + 导出出口）──────────────────

console.log("\n[7] X18 口径徽标：同一份 semanticRefs 在画布与导出都可见");
{
  // 用贯穿本脚本的 REFS（归因链路写入 node.data 的同一份数据）验展示模型
  const badges = semanticRefBadges(REFS);
  check("徽标取值：Metric 产出徽标（code 优先），Col 无 code/name 整条跳过",
    badges.length === 1 && badges[0].label === "gmv" && badges[0].text === "gmv"
    && badges[0].typeLabel === "指标", JSON.stringify(badges));
  check("徽标 hover 全文含类型 / 编码 / 名称 / 图谱 ID（多行，缺项省略）",
    badges[0]?.title === "类型：指标\n编码：gmv\n名称：销售额\n图谱 ID：m1", badges[0]?.title);
  check("Metric 优先排序 + code 缺失回落 name（非指标前缀类型名）",
    semanticRefBadges([
      { entityType: "Dimension", id: "d1", code: "region" },
      { entityType: "Metric", id: "m2", name: "订单数" },
    ]).map((b) => b.text).join(",") === "订单数,维度·region");
  check("同一实体重复注入只留一条（去重口径与语义边一致）",
    semanticRefBadges([...REFS, ...REFS]).length === 1);
  check("无 semanticRefs / 空数组 → 徽标为空（整节不渲染的前提）",
    semanticRefBadges(undefined).length === 0 && semanticRefBadges([]).length === 0);

  const badgeHtml = buildDeliveryReportHtml({
    nodes: [{
      id: "n1",
      type: "sqlQuery",
      position: { x: 0, y: 0 },
      data: { type: "sqlQuery", title: "Q: one", createdAt: "2026-11-06T10:00:00Z", sql: "SELECT 1", outputColumns: ["1"], semanticRefs: REFS },
    }],
    edges: [],
    exportedAt: "2026-11-06T12:00:00+08:00",
    audit: null,
  });
  check("导出 HTML 同步渲染口径引用（计数只算可展示徽标，Col 不进产物）",
    badgeHtml.includes("口径引用（1）") && badgeHtml.includes("<code>gmv</code>")
    && badgeHtml.includes("<td>销售额</td>") && !badgeHtml.includes("<code>c1</code>"));
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: 口径溯源 semanticRefs 归因链路贯通，数据/语义血缘边可视化区分");
