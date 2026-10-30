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
import govioCanvasExtension, { extractSqlFromCommand } from "../server/extensions/govio-canvas.js";
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
    check("同 dfName 不重复建节点", afterDup.nodes.filter((n) => (n.data as { type?: string }).type === "dataFrame").length === 1);
    check(
      "已有 Manifest 不被静默覆盖（漂移判定留给 T1.2）",
      JSON.stringify((afterDup.nodes.find((n) => n.id === dfNodeId)?.data as { manifest?: AnalysisManifest }).manifest) === JSON.stringify(dfManifest),
    );
  } finally {
    useCanvasStore.getState().clearCanvas();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: Manifest 往返无丢失");
