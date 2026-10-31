/**
 * T1.1 验证脚本：Analysis Manifest 随 canvas sidecar 往返不丢失。
 *
 * 复跑：`npm run verify:manifest`（等价于 `npx tsx scripts/verify-manifest-roundtrip.ts`）
 *
 * 覆盖三件事：
 *  1. buildManifest 产出的 dataFrame / sqlQuery Manifest 字段完整（含校验和）
 *  2. saveCanvas -> loadCanvas（前端 canvas_save 的服务端落点）往返后 Manifest 深度相等，
 *     且校验和可由持久化数据重新算出（T1.2 复跑对比的前提）
 *  3. extractSqlFromCommand 对双引号 / 单引号 / 多行 / 转义 / `--sql=` / 无引号 SQL 的还原
 *
 * 任一断言失败退出码为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  computeChecksum,
  MANIFEST_SCHEMA_VERSION,
} from "../server/analysis-manifest.js";
import { canvasPathFor, loadCanvas, saveCanvas } from "../server/session-history.js";
import govioCanvasExtension, { extractSqlFromCommand, isTrustworthyLoadOutput, enrichLoadOutput } from "../server/extensions/govio-canvas.js";
import { flushGovioNodes } from "../server/govio-node-queue.js";
import type { Node, Edge } from "@xyflow/react";
import type { AnalysisManifest } from "../src/types/manifest.js";

interface SidecarNode {
  id: string;
  type: string;
  data: { manifest?: AnalysisManifest; [key: string]: unknown };
}

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

// ── 1. 构造 Manifest（模拟 observe load 与助手消息 SQL 两条产生路径）───────

const SQL = [
  "SELECT o.order_id, o.amount, c.备注",
  "FROM orders o",
  "JOIN cust c ON c.id = o.cid",
  `WHERE o.amount > 100 AND c.name = '张"三'`,
].join("\n");

const columns = [
  { name: "order_id", nonNull: 1200, dtype: "BIGINT" },
  { name: "amount", nonNull: 1200, dtype: "DOUBLE" },
  { name: "备注", nonNull: 1200, dtype: "VARCHAR" },
];

const sessionId = "sess-2026-10-30-verify";
const model = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };

const dfManifest = buildManifest({
  origin: "observe-load",
  sql: SQL,
  datasource: "govio_demo",
  dfName: "df_orders",
  columns: columns.map((c) => ({ name: c.name, dtype: c.dtype })),
  rowCount: 1200,
  columnCount: 3,
  context: { sessionId, model },
  executedAt: "2026-10-30T22:30:00.000Z",
});

const sqlManifest = buildManifest({
  origin: "assistant-sql",
  sql: SQL,
  datasource: "",
  context: { sessionId, model },
  executedAt: "2026-10-30T22:29:50.000Z",
});

console.log("\n[1] buildManifest 字段完整性");
check("schemaVersion 为当前版本", dfManifest.schemaVersion === MANIFEST_SCHEMA_VERSION);
check("SQL 全文原样保留", dfManifest.sql === SQL);
check("datasource / dfName / origin", dfManifest.datasource === "govio_demo" && dfManifest.dfName === "df_orders" && dfManifest.origin === "observe-load");
check("执行时间 ISO", dfManifest.executedAt === "2026-10-30T22:30:00.000Z");
check("首次固化时间 firstExecutedAt 与 executedAt 同值写入", dfManifest.firstExecutedAt === "2026-10-30T22:30:00.000Z");
check("行数/列数", dfManifest.rowCount === 1200 && dfManifest.columnCount === 3);
check("校验和存在且为 schema-v1", dfManifest.checksum?.algorithm === "schema-v1");
check("校验和哈希为 16 位十六进制", /^[0-9a-f]{16}$/.test(dfManifest.checksum?.schemaHash ?? "") && /^[0-9a-f]{16}$/.test(dfManifest.checksum?.sqlHash ?? ""));
check("生成模型 ID", dfManifest.model?.id === "claude-sonnet-4-5" && dfManifest.model?.provider === "anthropic");
check("会话 ID", dfManifest.sessionId === sessionId);
check("权限决策 ID 预留为 null", dfManifest.permissionDecisionId === null);
check("sqlQuery Manifest 无结果指标", sqlManifest.checksum === undefined && sqlManifest.rowCount === undefined && sqlManifest.origin === "assistant-sql");
check("sqlQuery Manifest 携带 SQL 与模型", sqlManifest.sql === SQL && sqlManifest.model?.id === "claude-sonnet-4-5");

// ── 2. canvas_save -> loadCanvas 往返 ──────────────────────────────────────

const nodes = [
  {
    id: "gov-1",
    type: "sqlQuery",
    position: { x: 0, y: 0 },
    data: {
      type: "sqlQuery",
      title: "Q: orders",
      createdAt: "2026-10-30T22:29:50.000Z",
      sql: SQL,
      outputColumns: ["order_id", "amount", "备注"],
      manifest: sqlManifest,
    },
  },
  {
    id: "gov-2",
    type: "dataFrame",
    position: { x: 320, y: 0 },
    data: {
      type: "dataFrame",
      title: "DF: df_orders",
      createdAt: "2026-10-30T22:30:00.000Z",
      dfName: "df_orders",
      sourceName: "govio_demo",
      totalRows: 1200,
      totalColumns: 3,
      memoryUsage: "28.1 KB",
      columns,
      previewData: [],
      manifest: dfManifest,
    },
  },
];
const edges = [{ id: "e-gov-1-gov-2", source: "gov-1", target: "gov-2", type: "smoothstep" }];

const dir = mkdtempSync(join(tmpdir(), "govio-manifest-"));
const sessionFile = join(dir, "2026-10-30_verify.jsonl");

console.log("\n[2] saveCanvas -> loadCanvas 往返（canvas sidecar）");
try {
  saveCanvas(sessionFile, nodes, edges);
  const loaded = loadCanvas(sessionFile);
  check("sidecar 可读回", loaded !== null, `path=${canvasPathFor(sessionFile)}`);
  const loadedNodes = (loaded?.nodes ?? []) as unknown as SidecarNode[];
  const loadedSql = loadedNodes.find((n) => n.type === "sqlQuery")?.data.manifest;
  const loadedDf = loadedNodes.find((n) => n.type === "dataFrame")?.data.manifest;

  check("dataFrame Manifest 往返后深度相等", JSON.stringify(loadedDf) === JSON.stringify(dfManifest));
  check("sqlQuery Manifest 往返后深度相等", JSON.stringify(loadedSql) === JSON.stringify(sqlManifest));
  check("SQL 全文（含换行/引号/中文）无丢失", loadedDf?.sql === SQL);
  check("校验和哈希无丢失", loadedDf?.checksum?.schemaHash === dfManifest.checksum?.schemaHash && loadedDf?.checksum?.sqlHash === dfManifest.checksum?.sqlHash);
  check("模型/会话/权限字段无丢失", loadedDf?.model?.id === model.id && loadedDf?.sessionId === sessionId && loadedDf?.permissionDecisionId === null);
  check(
    "校验和可由持久化的节点数据重算（T1.2 复跑前提）",
    JSON.stringify(
      computeChecksum(
        loadedDf?.sql ?? "",
        ((loadedNodes.find((n) => n.type === "dataFrame")?.data.columns ?? []) as typeof columns).map((c) => ({ name: c.name, dtype: c.dtype })),
        loadedDf?.rowCount ?? -1,
        loadedDf?.columnCount ?? -1,
      ),
    ) === JSON.stringify(dfManifest.checksum),
  );
  check("边与节点数量不变", loadedNodes.length === nodes.length && (loaded?.edges ?? []).length === edges.length);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. --sql 提取（Manifest.sql 的来源）────────────────────────────────────

console.log("\n[3] extractSqlFromCommand");
const sqlCases: Array<[string, string]> = [
  ['govio-cli observe load --name df_a --datasource ds --sql "SELECT 1"', "SELECT 1"],
  ["govio-cli observe load --name df_a --datasource ds --sql 'SELECT 2'", "SELECT 2"],
  ['govio-cli observe load --name df_a --memory --sql "SELECT \\"x\\" FROM t"', 'SELECT "x" FROM t'],
  ['govio-cli observe load --name df_a --memory --sql="SELECT 3"', "SELECT 3"],
  ['govio-cli observe load --name df_a --datasource ds --sql "SELECT a\nFROM t\nWHERE b = 1"', "SELECT a\nFROM t\nWHERE b = 1"],
  ["govio-cli observe load --name df_a --datasource ds --sql SELECT * FROM t -o out.parquet", "SELECT * FROM t"],
  ["govio-cli observe load --name df_a --memory", ""],
];
for (const [cmd, expected] of sqlCases) {
  const actual = extractSqlFromCommand(cmd);
  check(`提取 ${JSON.stringify(expected)}`, actual === expected, `actual=${JSON.stringify(actual)}`);
}

// ── 4. 扩展事件流：observe load / 助手消息 SQL -> 节点自动携带 Manifest ─────

console.log("\n[4] govio-canvas 扩展事件流填充 Manifest");
{
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const toolNames: string[] = [];
  const piStub = {
    registerTool: (tool: { name: string }) => { toolNames.push(tool.name); },
    on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
  };
  govioCanvasExtension(piStub as unknown as Parameters<typeof govioCanvasExtension>[0]);

  const piCtx = {
    sessionManager: { getSessionId: () => "sess-verify-e2e" },
    model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  };

  const toolResult = handlers.get("tool_result");
  const messageEnd = handlers.get("message_end");
  check("扩展注册了 tool_result / message_end 处理器", typeof toolResult === "function" && typeof messageEnd === "function");
  check("扩展注册了 govio_show_dataframe 工具", toolNames.includes("govio_show_dataframe"));

  // observe load：bash 结果流 -> dataFrame 节点事件
  const loadCmd = `govio-cli observe load --name df_orders --datasource govio_demo --sql "${SQL.replaceAll('"', '\\"')}" 2>&1`;
  const loadStdout = JSON.stringify({
    success: true,
    rows: 1200,
    columns: 3,
    column_info: columns.map((c) => ({ name: c.name, dtype: c.dtype })),
    source_tables: ["orders", "cust"],
  });
  await toolResult?.(
    { toolName: "bash", isError: false, input: { command: loadCmd }, content: [{ type: "text", text: loadStdout }] },
    piCtx,
  );
  const loadEvents = flushGovioNodes();
  const dfEvent = loadEvents.find((e) => e.nodeType === "dataFrame");
  const dfEventManifest = dfEvent?.manifest;
  check("observe load 生成 dataFrame 节点事件", dfEvent !== undefined);
  check("节点事件自动携带 Manifest", dfEventManifest !== undefined);
  check("Manifest.origin = observe-load", dfEventManifest?.origin === "observe-load");
  check("Manifest.sql 还原命令中的 SQL 全文（含转义引号/换行）", dfEventManifest?.sql === SQL);
  check("Manifest.datasource / dfName", dfEventManifest?.datasource === "govio_demo" && dfEventManifest?.dfName === "df_orders");
  check("Manifest 行数/列数", dfEventManifest?.rowCount === 1200 && dfEventManifest?.columnCount === 3);
  check("Manifest 模型与会话取自 pi 上下文", dfEventManifest?.model?.id === "claude-sonnet-4-5" && dfEventManifest?.sessionId === "sess-verify-e2e");
  check(
    "Manifest 校验和与同输入直接构建一致",
    dfEventManifest?.checksum?.schemaHash === dfManifest.checksum?.schemaHash &&
      dfEventManifest?.checksum?.sqlHash === dfManifest.checksum?.sqlHash,
  );

  // 助手消息里的 ```sql 代码块 -> sqlQuery 节点事件
  await messageEnd?.(
    {
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timestamp: Date.parse("2026-10-30T22:29:50.000Z"),
        content: [{ type: "text", text: "已生成取数 SQL：\n```sql\n" + SQL + "\n```" }],
      },
    },
    piCtx,
  );
  const sqlEvents = flushGovioNodes();
  const sqlEvent = sqlEvents.find((e) => e.nodeType === "sqlQuery");
  check("助手消息 SQL 生成 sqlQuery 节点事件", sqlEvent !== undefined);
  check("sqlQuery 节点携带 SQL 全文", sqlEvent?.sql === SQL);
  check("sqlQuery Manifest 记录来源模型与会话", sqlEvent?.manifest?.origin === "assistant-sql" && sqlEvent?.manifest?.model?.id === "claude-sonnet-4-5" && sqlEvent?.manifest?.sessionId === "sess-verify-e2e");
  check("sqlQuery Manifest 记录消息时间", sqlEvent?.manifest?.executedAt === "2026-10-30T22:29:50.000Z");
  check("sqlQuery Manifest 无结果校验和（尚未执行）", sqlEvent?.manifest?.checksum === undefined);

  // 回归：失败的 observe load 不得建节点（人工验收 bug：jq 摘要管道把 success:false
  // 投影成全 null 字段，旧逻辑误当作 0 行成功加载，固化了错误 SQL）。
  // 直接验证根因谓词 isTrustworthyLoadOutput（hermetic，不触发 CLI 回退）。
  check(
    "isTrustworthyLoadOutput: jq 投影失败输出（全 null）不可信",
    isTrustworthyLoadOutput({ name: null, rows: null, columns: null, schema: null } as never) === false,
  );
  check(
    "isTrustworthyLoadOutput: success:false 不可信",
    isTrustworthyLoadOutput({ success: false, error: "SQL 执行错误" } as never) === false,
  );
  check(
    "isTrustworthyLoadOutput: null / 空对象不可信",
    isTrustworthyLoadOutput(null) === false && isTrustworthyLoadOutput({} as never) === false,
  );
  check(
    "isTrustworthyLoadOutput: 成功全量载荷可信",
    isTrustworthyLoadOutput({ success: true, rows: 12, column_info: [] } as never) === true,
  );
  check(
    "isTrustworthyLoadOutput: 成功 jq 摘要（有数值 rows）可信",
    isTrustworthyLoadOutput({ name: "dim_product", rows: 12, columns: 2, schema: null } as never) === true,
  );
  // 回归（会话 01a192a5 实证）：jq 摘要丢 column_info 时，enrichLoadOutput 用 observe info 补列结构，
  // 行/列数仍以 load 输出为准；Manifest 校验和依赖列信息，补回后才能产出。
  const jqSummary = { success: true, name: "top3", rows: 3, columns: 3 } as never;
  const infoWithCols = { rows: 3, columns: 3, column_info: [{ name: "product_name", dtype: "str" }, { name: "total_sales", dtype: "double" }] } as never;
  const enriched = enrichLoadOutput(jqSummary, infoWithCols);
  check("enrichLoadOutput: 摘要缺 column_info 时用 info 补列结构", Array.isArray(enriched.column_info) && enriched.column_info!.length === 2);
  check("enrichLoadOutput: 行/列数以 load 输出为准", enriched.rows === 3 && enriched.columns === 3 && enriched.success === true);
  check("enrichLoadOutput: load 自带 column_info 时不采用 info", (enrichLoadOutput({ success: true, rows: 1, column_info: [{ name: "a", dtype: "int" }] } as never, infoWithCols) as { column_info: unknown[] }).column_info.length === 1);
  check("enrichLoadOutput: info 为 null 时原样返回", enrichLoadOutput(jqSummary, null) === jqSummary);
  check("enrichLoadOutput: info 仅有 schema 键时也能补", Array.isArray((enrichLoadOutput(jqSummary, { schema: [{ column: "x", dtype: "int" }] } as never) as { column_info: unknown[] }).column_info));

  // 事件流层面：显式 success:false 的 tool_result 直接早退，不生成任何节点事件。
  const failCmd = `govio-cli observe load --name df_should_not_exist --datasource govio_demo --sql "SELECT * FROM nope" 2>&1`;
  await toolResult?.(
    {
      toolName: "bash",
      isError: false,
      input: { command: failCmd },
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "Catalog Error: Table nope does not exist" }) }],
    },
    piCtx,
  );
  const failEvents = flushGovioNodes();
  check("success:false 的 observe load 不生成 dataFrame 节点事件", failEvents.find((e) => e.nodeType === "dataFrame") === undefined);
}

// ── 5. 前端 store 写入 -> canvas_save -> loadCanvas -> hydrateSession 全链路 ──

console.log("\n[5] store -> canvas_save -> loadCanvas -> hydrateSession");
{
  const { useCanvasStore } = await import("../src/store/canvas-store.js");
  const dir = mkdtempSync(join(tmpdir(), "govio-manifest-store-"));
  const sessionFile = join(dir, "2026-10-30_store.jsonl");
  try {
    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "sqlQuery",
      title: "Q: orders",
      sql: SQL,
      outputColumns: ["order_id", "amount", "备注"],
      manifest: sqlManifest,
    });
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_orders",
      dfName: "df_orders",
      sourceName: "govio_demo",
      totalRows: 1200,
      totalColumns: 3,
      memoryUsage: "28.1 KB",
      columns,
      manifest: dfManifest,
    });

    const saved = useCanvasStore.getState();
    const nodeManifest = (nodeId: string): AnalysisManifest | undefined =>
      (saved.nodes.find((n) => n.id === nodeId)?.data as { manifest?: AnalysisManifest }).manifest;
    const dfNodeId = saved.nodes.find((n) => (n.data as { type?: string }).type === "dataFrame")?.id ?? "";
    const sqlNodeId = saved.nodes.find((n) => (n.data as { type?: string }).type === "sqlQuery")?.id ?? "";
    check("store 创建了 sqlQuery + dataFrame 节点", saved.nodes.length === 2 && saved.edges.length === 0);
    check("dataFrame node.data.manifest 已写入", JSON.stringify(nodeManifest(dfNodeId)) === JSON.stringify(dfManifest));
    check("sqlQuery node.data.manifest 已写入", JSON.stringify(nodeManifest(sqlNodeId)) === JSON.stringify(sqlManifest));

    // canvas_save（useChat.sendCanvasSnapshot 发的就是整个 store 快照）
    saveCanvas(sessionFile, saved.nodes, saved.edges);
    const loaded = loadCanvas(sessionFile);
    check("sidecar 可读回", loaded !== null);

    // 模拟会话重开：清空画布后 hydrateSession(canvas_restore)
    useCanvasStore.getState().clearCanvas();
    check("画布已清空", useCanvasStore.getState().nodes.length === 0);
    useCanvasStore.getState().hydrateSession((loaded?.nodes ?? []) as Node[], (loaded?.edges ?? []) as Edge[]);

    const restored = useCanvasStore.getState();
    const restoredManifest = (type: string): AnalysisManifest | undefined =>
      (restored.nodes.find((n) => (n.data as { type?: string }).type === type)?.data as { manifest?: AnalysisManifest }).manifest;
    check("会话重开后 dataFrame Manifest 完整恢复", JSON.stringify(restoredManifest("dataFrame")) === JSON.stringify(dfManifest));
    check("会话重开后 sqlQuery Manifest 完整恢复", JSON.stringify(restoredManifest("sqlQuery")) === JSON.stringify(sqlManifest));
    check("恢复后 SQL 全文与校验和未变", restoredManifest("dataFrame")?.sql === SQL && restoredManifest("dataFrame")?.checksum?.schemaHash === dfManifest.checksum?.schemaHash);

    // 去重路径：同 dfName 再次推送时，已有节点缺 Manifest 则回填，已有则不覆盖
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_orders",
      dfName: "df_orders",
      sourceName: "govio_demo",
      totalRows: 1200,
      totalColumns: 3,
      memoryUsage: "28.1 KB",
      columns,
      manifest: { ...dfManifest, executedAt: "2026-10-31T08:00:00.000Z" },
    });
    const afterDup = useCanvasStore.getState();
    check("同 dfName 不重复建节点", afterDup.nodes.filter((n) => (n.data as { dfName?: string }).dfName === "df_orders").length === 1);
    check(
      "已有 Manifest 不被静默覆盖（漂移判定留给 T1.2）",
      JSON.stringify((afterDup.nodes.find((n) => n.id === dfNodeId)?.data as { manifest?: AnalysisManifest }).manifest) === JSON.stringify(dfManifest),
    );

    // 回填分支（canvas-store.ts 的去重回填）：先由 restoreCanvas / show-dataframe
    // 建出无 Manifest 的节点，后到的带 Manifest 事件必须回填而不是丢失留痕
    const backfillManifest: AnalysisManifest = { ...dfManifest, dfName: "df_backfill", executedAt: "2026-10-31T09:00:00.000Z" };
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_backfill",
      dfName: "df_backfill",
      sourceName: "govio_demo",
      totalRows: 10,
      totalColumns: 3,
      memoryUsage: "240 B",
      columns,
    });
    const beforeBackfill = useCanvasStore.getState();
    const backfillNodeId = beforeBackfill.nodes.find(
      (n) => (n.data as { dfName?: string }).dfName === "df_backfill",
    )?.id ?? "";
    check("无 Manifest 事件先建出节点（回填前置条件）",
      backfillNodeId !== "" && (beforeBackfill.nodes.find((n) => n.id === backfillNodeId)?.data as { manifest?: AnalysisManifest }).manifest === undefined);
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_backfill",
      dfName: "df_backfill",
      sourceName: "govio_demo",
      totalRows: 10,
      totalColumns: 3,
      memoryUsage: "240 B",
      columns,
      manifest: backfillManifest,
    });
    const afterBackfill = useCanvasStore.getState();
    check("同 dfName 带 Manifest 的后续事件回填到已有节点（不丢留痕、不重建节点）",
      afterBackfill.nodes.filter((n) => (n.data as { dfName?: string }).dfName === "df_backfill").length === 1
      && JSON.stringify((afterBackfill.nodes.find((n) => n.id === backfillNodeId)?.data as { manifest?: AnalysisManifest }).manifest) === JSON.stringify(backfillManifest));
  } finally {
    useCanvasStore.getState().clearCanvas();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. X5：共享 ObserveLoadOutput 校验器 — 五种输入的分类判定与现行为一致 ────

console.log("\n[6] 共享校验器（observe-load-schema）五种输入分类回归");
{
  const { parseObserveLoadOutput, isLoadFailure } = await import("../server/observe-load-schema.js");
  const { parseLoadOutput, extractLoadError } = await import("../server/dataframe-rerun.js");

  // 五种输入（docs/tasks/X5-sql-discipline/design.md；与 BUGFIX-load-parse 场景对齐）
  const jqAllNull = '{"name":null,"rows":null,"columns":null,"schema":null}';
  const failure = '{"success":false,"error":"Catalog Error: Table dim_product does not exist"}';
  const truncated = '{"success": true, "rows": 1';
  const fullSuccess = '{"success":true,"name":"dim_product","rows":12,"columns":2,"column_info":[{"name":"product_id","dtype":"VARCHAR"},{"name":"product_name","dtype":"VARCHAR"}],"source_tables":["upstream_df"]}';
  const jqSummary = '{"name":"dim_product","rows":12,"columns":2,"schema":null}';

  // ① jq 全 null 投影：schema 合法（显式 null 宽容）但不可信 → handleLoadResult 回退
  //    ObserveStore 复核；parseLoadOutput 保持现行为（复跑路径经 execFile 不经 jq 管道，
  //    生产不会出现此输入，断言只为钉死「分类与现行为一致、不放松 BUGFIX 修复」）
  const allNull = parseObserveLoadOutput(jqAllNull);
  check("jq 全 null 投影：schema 合法（显式 null 被宽容）", allNull !== null);
  check("jq 全 null 投影：非显式失败（无 success:false 可拦截）", isLoadFailure(allNull) === false);
  check("jq 全 null 投影：不可信（无成功信号 → 回退复核）", isTrustworthyLoadOutput(allNull) === false);
  check("jq 全 null 投影：parseLoadOutput 保持现行为（0 行结果）", JSON.stringify(parseLoadOutput(jqAllNull)) === JSON.stringify({ rowCount: 0, columnCount: 0, columns: [] }));
  check("jq 全 null 投影：extractLoadError 返回 null", extractLoadError(jqAllNull) === null);

  // ② success:false → 三处消费统一按「显式失败」分类
  const fail = parseObserveLoadOutput(failure);
  check("success:false：schema 合法", fail !== null);
  check("success:false：isLoadFailure 拦截（不建节点 / 400）", isLoadFailure(fail) === true);
  check("success:false：不可信", isTrustworthyLoadOutput(fail) === false);
  check("success:false：parseLoadOutput 返回 null", parseLoadOutput(failure) === null);
  check("success:false：extractLoadError 透传 SQL 错误", (extractLoadError(failure) ?? "").includes("Table dim_product does not exist"));

  // ③ 截断输出（非法 JSON）→ 一律拒绝，无错误透传（回退通用「无法解析」文案）
  check("截断输出：parseObserveLoadOutput 返回 null", parseObserveLoadOutput(truncated) === null);
  check("截断输出：不可信（handleLoadResult 回退复核）", isTrustworthyLoadOutput(parseObserveLoadOutput(truncated)) === false);
  check("截断输出：parseLoadOutput 返回 null", parseLoadOutput(truncated) === null);
  check("截断输出：extractLoadError 返回 null（调用方回退通用文案）", extractLoadError(truncated) === null);

  // ④ 成功全量载荷 → 可信，列/行数映射正确，血缘 source_tables 保留
  const ok = parseObserveLoadOutput(fullSuccess);
  check("成功全量载荷：schema 合法", ok !== null);
  check("成功全量载荷：非失败", isLoadFailure(ok) === false);
  check("成功全量载荷：可信", isTrustworthyLoadOutput(ok) === true);
  check("成功全量载荷：source_tables 保留（--memory 血缘用）", JSON.stringify(ok?.source_tables) === JSON.stringify(["upstream_df"]));
  check(
    "成功全量载荷：parseLoadOutput 映射行/列数与列名",
    JSON.stringify(parseLoadOutput(fullSuccess)) === JSON.stringify({
      rowCount: 12,
      columnCount: 2,
      columns: [{ name: "product_id", dtype: "VARCHAR" }, { name: "product_name", dtype: "VARCHAR" }],
    }),
  );
  check("成功全量载荷：extractLoadError 返回 null", extractLoadError(fullSuccess) === null);

  // ⑤ 成功 jq 摘要（有数值 rows）→ 可信
  const summary = parseObserveLoadOutput(jqSummary);
  check("成功 jq 摘要：schema 合法", summary !== null);
  check("成功 jq 摘要：可信", isTrustworthyLoadOutput(summary) === true);
  check("成功 jq 摘要：parseLoadOutput 保持现行为（列信息缺失时用 columns 字段）", JSON.stringify(parseLoadOutput(jqSummary)) === JSON.stringify({ rowCount: 12, columnCount: 2, columns: [] }));

  // 新能力：字段类型漂移/非对象 JSON 被校验器抓住（旧手写 interface 只能运行时暴露），
  // 同时宽松契约不误杀 CLI 新增字段
  check("形状漂移：rows 变字符串被拒绝", parseObserveLoadOutput('{"success":true,"rows":"twelve"}') === null);
  check("形状漂移：非对象 JSON（数组）被拒绝", parseObserveLoadOutput('[{"rows":12}]') === null);
  check("宽松契约：未知额外字段不误杀（CLI 新增输出不破坏）", parseObserveLoadOutput('{"success":true,"rows":1,"future_field":"x"}') !== null);
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: Manifest 往返无丢失");
