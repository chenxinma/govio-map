/**
 * T2.3 验证脚本：口径冲突检测（CLI 调用编排 + 结果透传 + 降级 + UI 状态映射）。
 *
 * 复跑：`npm run verify:caliber-conflict`（等价于 `npx tsx scripts/verify-caliber-conflict.ts`）
 *
 * 覆盖链路：
 *  1. 调用参数：buildCaliberArgs——SQL 全文作单参数传 --sql，指标经可重复 --metric
 *  2. 结果解析：parseCaliberOutput——汇总 status（conflict > unknown > consistent）、
 *     differences 扁平化（metricCode/metricName 归属、缺失省略键）、非 JSON/形状非法
 *     返回 undefined（省略键）
 *  3. 降级纪律：runCaliberCheck——stub CLI 成功透传；拒绝/非 JSON/空输入 → undefined
 *     不抛错、不重试
 *  4. message_end 钩子（stub pi + stub CLI）：semanticRefs 含 Metric → 事件带
 *     caliberCheck（仅 Metric 进 --metric，code 优先于 id）；无 Metric/失败/无归因
 *     → 不建键、不调 CLI
 *  5. 透传：事件 JSON -> createGovioNode -> node.data.caliberCheck；旧事件不建键
 *  6. 往返：saveCanvas -> loadCanvas -> hydrateSession 深度相等
 *  7. UI 状态映射：caliberNodeAppearance（conflict 亮警示、consistent/unknown/旧节点
 *     不打扰）+ 警示色与 aspect 展示名常量
 *
 * 不调 govio-cli、不调模型、不碰 `.govio/`。任一断言失败退出码为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import govioCanvasExtension from "../server/extensions/govio-canvas.js";
import { flushGovioNodes, type GovioNodeCreateEvent } from "../server/govio-node-queue.js";
import {
  buildCaliberArgs,
  CALIBER_CLI_TIMEOUT_MS,
  parseCaliberOutput,
  runCaliberCheck,
  type CaliberCliRunner,
} from "../server/caliber-check.js";
import { clearSessionSemanticRefs, getSessionSemanticRefs, setSessionCaliberMetrics, setSessionSemanticRefs } from "../server/semantic-context.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../server/session-history.js";
import { CALIBER_ASPECT_LABELS, caliberNodeAppearance, CALIBER_WARNING_COLOR } from "../src/utils/caliber.js";
import type { CanvasEvent } from "../src/services/canvas-service.js";
import type { CaliberCheck, SemanticRef } from "../src/types/index.js";
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

const CHECK_CONFLICT: CaliberCheck = {
  status: "conflict",
  differences: [
    {
      metricCode: "gmv",
      metricName: "销售额",
      aspect: "aggregation",
      expected: "SUM(amount)",
      found: "AVG(price)",
      detail: "SQL 聚合结构与 formula 不一致",
    },
  ],
};

const CLI_CONFLICT = JSON.stringify({
  results: [
    {
      metric: { id: "m1", code: "gmv", name: "销售额" },
      status: "conflict",
      differences: [
        { aspect: "aggregation", expected: "SUM(amount)", found: "AVG(price)", detail: "SQL 聚合结构与 formula 不一致" },
      ],
    },
  ],
});

const CLI_MIXED = JSON.stringify({
  results: [
    {
      metric: { code: "gmv", name: "销售额" },
      status: "conflict",
      differences: [{ aspect: "column", expected: "amount(measure)", found: "price", detail: "计量列 amount 未在 SQL 中引用" }],
    },
    {
      metric: { id: "m2" },
      status: "unknown",
      differences: [{ aspect: "filter", expected: "剔除 refund", found: "SQL WHERE 未见该限定" }],
    },
  ],
});

const CLI_CONSISTENT = JSON.stringify({ results: [{ metric: { code: "gmv" }, status: "consistent", differences: [] }] });

// ── 1. 调用参数 ───────────────────────────────────────────────────────────

console.log("\n[1] buildCaliberArgs：SQL 全文单参数 + --metric 可重复");
{
  const sql = "SELECT SUM(amount)\nFROM orders WHERE name = 'a b  c'";
  const args = buildCaliberArgs(sql, ["gmv", "m_order"]);
  check("子命令为 sql caliber", args[0] === "sql" && args[1] === "caliber");
  const sqlIdx = args.indexOf("--sql");
  check("--sql 传 SQL 全文（空格/换行/引号不拆）", sqlIdx >= 0 && args[sqlIdx + 1] === sql);
  check("--metric 按序重复（每个指标一个）",
    args.filter((a, i) => a === "--metric" && args[i + 1] === "gmv").length === 1
    && args.filter((a, i) => a === "--metric" && args[i + 1] === "m_order").length === 1);
  check("超时为短超时常量（~6s）", CALIBER_CLI_TIMEOUT_MS > 0 && CALIBER_CLI_TIMEOUT_MS <= 10000);
}

// ── 2. 结果解析 ───────────────────────────────────────────────────────────

console.log("\n[2] parseCaliberOutput：汇总 status + differences 扁平化 + 形状校验");
{
  const conflict = parseCaliberOutput(CLI_CONFLICT);
  check("conflict 结果解析并汇总 status:conflict", conflict?.status === "conflict");
  check("differences 带指标归属（metricCode/metricName）",
    JSON.stringify(conflict?.differences) === JSON.stringify(CHECK_CONFLICT.differences));

  const mixed = parseCaliberOutput(CLI_MIXED);
  check("多指标：任一 conflict → 汇总 conflict（conflict 优先于 unknown）", mixed?.status === "conflict");
  check("多指标 differences 全部扁平保留（含无 code 的 metric，省略键）",
    mixed?.differences.length === 2
    && mixed.differences[0].metricCode === "gmv"
    && !("metricCode" in mixed.differences[1]));

  const unknown = parseCaliberOutput(JSON.stringify({
    results: [{ metric: { code: "x" }, status: "unknown", differences: [] }],
  }));
  check("仅 unknown → 汇总 unknown", unknown?.status === "unknown");

  const consistent = parseCaliberOutput(CLI_CONSISTENT);
  check("全 consistent → 汇总 consistent、differences 空",
    consistent?.status === "consistent" && consistent.differences.length === 0);

  check("非 JSON → undefined", parseCaliberOutput("not json") === undefined);
  check("空输出 → undefined", parseCaliberOutput("") === undefined);
  check("缺 results/空 results → undefined",
    parseCaliberOutput("{}") === undefined && parseCaliberOutput('{"results":[]}') === undefined);
  check("status 越界 → undefined",
    parseCaliberOutput('{"results":[{"status":"maybe","differences":[]}]}') === undefined);
  check("differences 条目缺字段 → undefined",
    parseCaliberOutput('{"results":[{"status":"conflict","differences":[{"aspect":"x"}]}]}') === undefined);
}

// ── 3. runCaliberCheck 降级纪律 ───────────────────────────────────────────

console.log("\n[3] runCaliberCheck：成功透传；失败/非 JSON/空输入 → undefined（不抛错不重试）");
{
  const calls: string[][] = [];
  const okRunner: CaliberCliRunner = (args) => {
    calls.push(args);
    return Promise.resolve(CLI_CONFLICT);
  };
  const ok = await runCaliberCheck("SELECT 1", ["gmv"], okRunner);
  check("成功路径透传 CLI 结果", JSON.stringify(ok) === JSON.stringify(CHECK_CONFLICT));
  check("stub 收到调用参数（SQL + 指标）",
    calls.length === 1 && calls[0].includes("--sql") && calls[0].includes("gmv"));

  check("CLI 报错 → undefined（不抛错）",
    await runCaliberCheck("SELECT 1", ["gmv"], () => Promise.reject(new Error("spawn ENOENT"))) === undefined);
  check("非 JSON 输出 → undefined",
    await runCaliberCheck("SELECT 1", ["gmv"], () => Promise.resolve("govio-cli not found")) === undefined);
  check("空 SQL → undefined 且不调 CLI",
    await runCaliberCheck("", ["gmv"], () => { throw new Error("must not call"); }) === undefined);
  check("无指标 → undefined 且不调 CLI",
    await runCaliberCheck("SELECT 1", [], () => { throw new Error("must not call"); }) === undefined);
}

// ── 4. message_end 钩子（stub pi + stub CLI）──────────────────────────────

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

const cliCalls: string[][] = [];
let cliBehavior: CaliberCliRunner = () => Promise.resolve(CLI_CONFLICT);
govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0], {
  runCaliberCli: (args, timeoutMs) => {
    cliCalls.push(args);
    return cliBehavior(args, timeoutMs);
  },
});

type MessageEndHandler = (
  event: { message: Record<string, unknown> },
  ctx: unknown,
) => void | Promise<void>;

async function runMessageEnd(sessionId: string, text: string): Promise<GovioNodeCreateEvent[]> {
  const handler = handlers.get("message_end") as MessageEndHandler | undefined;
  if (!handler) return [];
  await handler(
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: 1762000000000,
        provider: "stub",
        model: "stub-model",
      },
    },
    { sessionManager: { getSessionId: () => sessionId }, model: {} },
  );
  return flushGovioNodes();
}

const SQL_TEXT = "分析如下：\n```sql\nSELECT product_id, SUM(amount) AS sales FROM dim_order GROUP BY 1\n```\n";
const SQL_TEXT_TWO = `${SQL_TEXT}\n再来一个：\n\`\`\`sql\nSELECT region, COUNT(*) AS n FROM dim_order GROUP BY 1\n\`\`\`\n`;

console.log("\n[4] message_end：semanticRefs 含 Metric → 事件带 caliberCheck；失败降级省略键");
{
  check("扩展注册了 message_end 处理器（stub 完整性）", handlers.has("message_end"));

  cliCalls.length = 0;
  cliBehavior = () => Promise.resolve(CLI_CONFLICT);
  setSessionSemanticRefs("sess-1", REFS);
  setSessionCaliberMetrics("sess-1", ["gmv"]);
  const events = await runMessageEnd("sess-1", SQL_TEXT);
  check("事件带 caliberCheck（深度相等）",
    JSON.stringify(events[0]?.caliberCheck) === JSON.stringify(CHECK_CONFLICT));
  check("仅 Metric 进 --metric（Col 不参比对；code 优先于 id）",
    cliCalls.length === 1
    && cliCalls[0].filter((a, i) => a === "--metric" && cliCalls[0][i + 1] === "gmv").length === 1
    && !cliCalls[0].includes("c1") && !cliCalls[0].includes("m1"));
  check("CLI 拿到 SQL 全文", cliCalls[0][cliCalls[0].indexOf("--sql") + 1] === "SELECT product_id, SUM(amount) AS sales FROM dim_order GROUP BY 1");

  cliCalls.length = 0;
  cliBehavior = () => Promise.reject(new Error("timeout"));
  const failed = await runMessageEnd("sess-1", SQL_TEXT);
  check("CLI 失败 → 事件省略 caliberCheck 键（不阻断）",
    failed.length === 1 && !("caliberCheck" in (failed[0] as object)));
  check("失败不重试（单次调用）", cliCalls.length === 1);

  cliCalls.length = 0;
  cliBehavior = () => Promise.resolve("<html>not json</html>");
  const nonJson = await runMessageEnd("sess-1", SQL_TEXT);
  check("非 JSON 输出 → 省略键", !("caliberCheck" in (nonJson[0] as object)));

  cliCalls.length = 0;
  setSessionSemanticRefs("sess-1", [{ entityType: "Col", id: "c1" }]);
  setSessionCaliberMetrics("sess-1", []);
  const noMetrics = await runMessageEnd("sess-1", SQL_TEXT);
  check("无点名指标 → 不调 CLI、不建键",
    cliCalls.length === 0 && !("caliberCheck" in (noMetrics[0] as object)));

  clearSessionSemanticRefs("sess-1");
  cliCalls.length = 0;
  const noRefs = await runMessageEnd("sess-never", SQL_TEXT);
  check("无归因（steer/followUp）→ 不调 CLI、不建键",
    cliCalls.length === 0 && !("caliberCheck" in (noRefs[0] as object)));

  cliBehavior = () => Promise.resolve(CLI_CONFLICT);
  setSessionSemanticRefs("sess-1", REFS);
  setSessionCaliberMetrics("sess-1", ["gmv"]);
  const two = await runMessageEnd("sess-1", SQL_TEXT_TWO);
  check("一消息多代码块：每个 SQL 节点各带 caliberCheck",
    two.length === 2 && two.every((e) => e.caliberCheck !== undefined));
  clearSessionSemanticRefs("sess-1");
}

// ── 4b. 检测范围：仅问题点名指标（防误报）──────────────────────────

console.log("\n[4b] 口径检测仅针对问题点名的指标（同表注入的其它指标不参检）");
{
  cliCalls.length = 0;
  cliBehavior = () => Promise.resolve(CLI_CONFLICT);
  // semanticRefs 含两个指标（gmv 问题点名 + boxes 仅因同表注入），caliberMetrics 只含 gmv
  setSessionSemanticRefs("sess-2", [
    { entityType: "Metric", id: "m1", code: "gmv", name: "销售额" },
    { entityType: "Metric", id: "m2", code: "m_boxes_shipped", name: "出货箱数" },
  ]);
  setSessionCaliberMetrics("sess-2", ["gmv"]);
  await runMessageEnd("sess-2", SQL_TEXT);
  const metricArgs = cliCalls[0] ? cliCalls[0].filter((_a, i, arr) => arr[i - 1] === "--metric") : [];
  check("--metric 只含点名指标（不含仅同表注入的 m_boxes_shipped）",
    metricArgs.length === 1 && metricArgs[0] === "gmv");
  check("semanticRefs 仍保留全部注入实体（口径溯源不受影响）",
    (getSessionSemanticRefs("sess-2") ?? []).length === 2);

  // 无点名（如「各渠道表现怎么样」）→ 不做口径检测，避免「指标没算」型误报
  cliCalls.length = 0;
  setSessionSemanticRefs("sess-2", [{ entityType: "Metric", id: "m2", code: "m_boxes_shipped" }]);
  setSessionCaliberMetrics("sess-2", []);
  const untouched = await runMessageEnd("sess-2", SQL_TEXT);
  check("无点名指标 → 无 caliberCheck（表注入指标不引发误报）",
    cliCalls.length === 0 && !("caliberCheck" in (untouched[0] as object)));
  clearSessionSemanticRefs("sess-2");
}

// ── 5. 事件 -> node.data 透传（含旧事件兼容）──────────────────────────────

console.log("\n[5] 事件 -> WS 广播 JSON -> createGovioNode 透传");
const { useCanvasStore } = await import("../src/store/canvas-store.js");
const wireJson = JSON.stringify({
  type: "govio_node_create",
  nodeType: "sqlQuery",
  title: "Q: caliber",
  sql: "SELECT SUM(amount) FROM orders",
  outputColumns: ["sales"],
  caliberCheck: CHECK_CONFLICT,
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
  const annotated = saved.nodes.find((n) => (n.data as { title?: string }).title === "Q: caliber");
  const legacy = saved.nodes.find((n) => (n.data as { title?: string }).title === "Q: legacy");
  check("node.data 写入 caliberCheck（深度相等）",
    JSON.stringify((annotated?.data as Record<string, unknown>).caliberCheck) === JSON.stringify(CHECK_CONFLICT));
  check("旧事件节点不建键（旧节点形状不变）",
    legacy !== undefined && !("caliberCheck" in (legacy.data as object)));

  // ── 6. sidecar 往返 + hydrateSession ────────────────────────────────────

  console.log("\n[6] saveCanvas -> loadCanvas -> hydrateSession 往返");
  const dir = mkdtempSync(join(tmpdir(), "govio-caliber-conflict-"));
  const sessionFile = join(dir, "2026-11-07_caliber-conflict.jsonl");
  try {
    saveCanvas(sessionFile, saved.nodes, saved.edges);
    const loaded = loadCanvas(sessionFile);
    check("sidecar 可读回", loaded !== null, `path=${canvasPathFor(sessionFile)}`);
    const loadedNodes = (loaded?.nodes ?? []) as Node[];
    const loadedAnnotated = loadedNodes.find((n) => (n.data as { title?: string }).title === "Q: caliber");
    check("往返后 caliberCheck 深度相等",
      JSON.stringify((loadedAnnotated?.data as Record<string, unknown>).caliberCheck) === JSON.stringify(CHECK_CONFLICT));
    const loadedLegacy = loadedNodes.find((n) => (n.data as { title?: string }).title === "Q: legacy");
    check("往返后旧节点仍无 caliberCheck 键（历史 sidecar 兼容）",
      loadedLegacy !== undefined && !("caliberCheck" in (loadedLegacy.data as object)));

    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().hydrateSession(loadedNodes, (loaded?.edges ?? []) as Edge[]);
    const restored = useCanvasStore.getState().nodes.find((n) => (n.data as { title?: string }).title === "Q: caliber");
    check("会话重开后 caliberCheck 完整恢复",
      JSON.stringify((restored?.data as Record<string, unknown>).caliberCheck) === JSON.stringify(CHECK_CONFLICT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  useCanvasStore.getState().clearCanvas();
}

// ── 7. UI 状态映射 ───────────────────────────────────────────────────────

console.log("\n[7] UI 状态映射（caliberNodeAppearance）");
{
  const conflictView = caliberNodeAppearance(CHECK_CONFLICT);
  check("conflict → 亮警示 + 徽标",
    conflictView.showWarning && conflictView.badgeLabel === "口径冲突");
  check("警示色为 green-deck semantic warning #F59B23", CALIBER_WARNING_COLOR === "#F59B23");

  const consistentView = caliberNodeAppearance({ status: "consistent", differences: [] });
  check("consistent → 不打扰（无警示无徽标）",
    !consistentView.showWarning && consistentView.badgeLabel === null);

  const unknownView = caliberNodeAppearance({ status: "unknown", differences: [] });
  check("unknown → 不显示（轻提示取舍：不打扰）", !unknownView.showWarning);

  check("旧节点（无 caliberCheck）→ 不显示", !caliberNodeAppearance(undefined).showWarning);

  check("aspect 展示名覆盖 CLI 全部维度",
    ["aggregation", "filter", "time_scope", "column", "metric", "sql"].every((a) => CALIBER_ASPECT_LABELS[a]));
}

// ── 汇总 ─────────────────────────────────────────────────────────────────

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(" | ")}`);
  process.exit(1);
}
