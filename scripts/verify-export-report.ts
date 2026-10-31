/**
 * T1.4 验证脚本：画布交付导出（自包含 HTML）。
 *
 * 复跑：`npm run verify:export`
 *
 * 做法：构造一个**含全部五类节点**的样例画布状态（sourceTable ×2 / sqlQuery / dataFrame ×3
 * 含漂移与无留痕节点 / chart ×2 含渲染失败降级 / report，外加血缘边、悬空边与自环），
 * 直接调用纯函数 `buildDeliveryReportHtml()` 产出 HTML 并逐节断言。
 *
 * 产物默认写到临时目录（不污染 git 工作树）；只有显式传 `--write` 才更新受跟踪的
 * `docs/tasks/T1.4-canvas-export/sample-export.html`（脚本钉住 TZ=Asia/Shanghai，
 * 固定导出时间 → 同时区下逐字节可复现，可双击离线打开人工复核）。
 *
 * 覆盖七件事：
 *  1. 产物自包含（无脚本 / 无外部引用 / 内联样式）与整体结构
 *  2. 血缘层次布局与 SVG（层次、坐标、边路径、悬空边与自环被丢弃）
 *  3. 五类节点卡片都有静态快照
 *  4. 漂移告警态与复跑记录摘要（含「原 Manifest 未被覆盖」的措辞）
 *  5. 附录 A：每个 dataFrame 节点的 Manifest（含 permissionDecisionId 三态）
 *  6. 附录 B：权限确认记录（只读通道返回值的解析白名单、关联节点、不可用时如实说明）
 *  7. 转义（画布内容不得变成 HTML/脚本）、确定性、不含数据行内容
 *
 * 不调 govio-cli、不调模型、不读任何数据内容、不碰 `.govio/`。任一断言失败退出码 1。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 钉住时区：产物里的本地时间渲染（formatTimestamp / formatRerunTime）与受跟踪样例
// 的字节一致性都依赖时区；期望值全部用 Asia/Shanghai 下的字面量断言。
// 必须在任何 Date 格式化之前生效（仅影响本脚本进程）。
process.env.TZ = "Asia/Shanghai";

import type { Edge, Node } from "@xyflow/react";
import {
  buildDeliveryReportHtml,
  collectPermissionDecisionIds,
  fetchAuditAppendix,
  layoutLineage,
  parseAuditEntries,
  reportFileName,
  tracePointCount,
  type AuditAppendix,
  type ChartRenderMap,
} from "../src/utils/export-report.js";
import type { AnalysisManifest } from "../src/types/manifest.js";
import type { ChartNodeData, DataFrameNodeData, ReportNodeData, RerunRecord, SourceTableNodeData, SQLQueryNodeData } from "../src/types/index.js";

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

// ---------------------------------------------------------------------------
// 样例画布状态（只含结构与留痕；previewData 里的哨兵值用来断言「数据行不出现在产物里」）
// ---------------------------------------------------------------------------

const ROW_SENTINEL = "SENTINEL_ROW_VALUE_9137";
const CHART_VALUE_SENTINEL = 424242;
const XSS_SENTINEL = "<script>alert('xss')</script>";

const FIXED_EXPORTED_AT = "2026-10-31T00:45:00.000Z";
// TZ=Asia/Shanghai 下的字面量期望（不用生产格式化函数自证）：
// FIXED_EXPORTED_AT → 2026-10-31 08:45:00；2026-10-30T22:10:30Z → 2026-10-31 06:10:30；
// 2026-10-30T22:10:00Z → 2026-10-31 06:10:00；DRIFT.rerunAt 23:05Z → 2026-10-31 07:05；
// IDENTICAL.rerunAt 22:40Z → 2026-10-31 06:40
const EXPECT_EXPORTED_AT = "2026-10-31 08:45:00";
const EXPECT_DF_CREATED_AT = "2026-10-31 06:10:30";
const EXPECT_MANIFEST_EXECUTED_AT = "2026-10-31 06:10:00";
const EXPECT_DRIFT_RERUN_AT = "2026-10-31 07:05";
const EXPECT_IDENTICAL_RERUN_AT = "2026-10-31 06:40";

const DECISION_ID = "pd-1111aaaa-2222";

function manifest(partial: Partial<AnalysisManifest> & Pick<AnalysisManifest, "origin" | "sql" | "datasource">): AnalysisManifest {
  return {
    schemaVersion: 1,
    executedAt: "2026-10-30T22:10:00.000Z",
    sessionId: "sess-sample-export",
    permissionDecisionId: null,
    ...partial,
  };
}

const SQL_MONTHLY = [
  "-- 月度销售额汇总（口径：已支付订单）",
  "SELECT strftime(o.created_at, '%Y-%m') AS 月份,",
  "       c.区域, SUM(o.amount) AS 销售额",
  "FROM orders o JOIN customers c ON o.customer_id = c.id",
  "WHERE o.status = 'paid' AND o.amount < 100000",
  "GROUP BY 1, 2",
  "ORDER BY 1 DESC",
].join("\n");

const MANIFEST_MONTHLY = manifest({
  origin: "observe-load",
  sql: SQL_MONTHLY,
  datasource: "sales",
  dfName: "df_monthly_sales",
  executedAt: "2026-10-30T22:10:00.000Z",
  rowCount: 12,
  columnCount: 3,
  checksum: { algorithm: "schema-v1", rowCount: 12, columnCount: 3, schemaHash: "a1b2c3d4e5f60718", sqlHash: "0f1e2d3c4b5a6978" },
  model: { provider: "anthropic", id: "claude-sonnet-4-5", responseModel: "claude-sonnet-4-5-20250929" },
  permissionDecisionId: DECISION_ID,
});

const MANIFEST_MEMORY = manifest({
  origin: "observe-load",
  sql: "SELECT 区域, SUM(销售额) AS 合计 FROM df_monthly_sales GROUP BY 区域",
  datasource: "memory",
  dfName: "df_region_top",
  executedAt: "2026-10-30T22:31:00.000Z",
  rowCount: 4,
  columnCount: 2,
  checksum: { algorithm: "schema-v1", rowCount: 4, columnCount: 2, schemaHash: "ffff0000eeee1111", sqlHash: "2222333344445555" },
  model: { provider: "anthropic", id: "claude-sonnet-4-5" },
  sourceDataFrames: ["df_monthly_sales"],
  permissionDecisionId: null,
});

const DRIFT_RECORD: RerunRecord = {
  rerunAt: "2026-10-30T23:05:00.000Z",
  outcome: "drift",
  before: { executedAt: "2026-10-30T22:10:00.000Z", rowCount: 12, columnCount: 3, checksum: MANIFEST_MONTHLY.checksum },
  after: { rowCount: 13, columnCount: 3, checksum: { algorithm: "schema-v1", rowCount: 13, columnCount: 3, schemaHash: "9999888877776666", sqlHash: "0f1e2d3c4b5a6978" } },
  diff: { rowCountDelta: 1, columnCountDelta: 0, schemaChanged: true, summary: "行数 12 → 13（+1）；结构哈希变化" },
  durationMs: 3210,
  tempDfName: "rerun_tmp_df_monthly_sales_lz4k2a91",
  sessionId: "sess-sample-export",
};

const IDENTICAL_RECORD: RerunRecord = {
  rerunAt: "2026-10-30T22:40:00.000Z",
  outcome: "identical",
  before: { executedAt: "2026-10-30T22:10:00.000Z", rowCount: 12, columnCount: 3, checksum: MANIFEST_MONTHLY.checksum },
  after: { rowCount: 12, columnCount: 3, checksum: MANIFEST_MONTHLY.checksum },
  durationMs: 2870,
  tempDfName: "rerun_tmp_df_monthly_sales_lz4jx0b2",
  sessionId: "sess-sample-export",
};

const ERROR_RECORD: RerunRecord = {
  rerunAt: "2026-10-30T23:20:00.000Z",
  outcome: "error",
  before: { executedAt: "2026-10-30T22:31:00.000Z", rowCount: 4, columnCount: 2 },
  error: "上游 DataFrame df_monthly_sales 已被释放（observe release）",
  durationMs: 640,
  sessionId: "sess-sample-export",
};

const CHANNEL_CHECKSUM = { algorithm: "schema-v1" as const, rowCount: 6, columnCount: 2, schemaHash: "abcd1234abcd1234", sqlHash: "5566778899aabbcc" };

/** SQL 编辑器人工执行的留痕：没有生成模型，permissionDecisionId 恒为 null */
const MANIFEST_CHANNEL = manifest({
  origin: "sql-editor",
  sql: "SELECT 渠道, COUNT(*) AS 单量 FROM orders GROUP BY 渠道",
  datasource: "sales",
  dfName: "df_channel_check",
  executedAt: "2026-10-30T22:45:00.000Z",
  rowCount: 6,
  columnCount: 2,
  checksum: CHANNEL_CHECKSUM,
  model: undefined,
});

const IDENTICAL_RECORD_CHANNEL: RerunRecord = {
  rerunAt: "2026-10-30T23:30:00.000Z",
  outcome: "identical",
  before: { executedAt: "2026-10-30T22:45:00.000Z", rowCount: 6, columnCount: 2, checksum: CHANNEL_CHECKSUM },
  after: { rowCount: 6, columnCount: 2, checksum: CHANNEL_CHECKSUM },
  durationMs: 1450,
  tempDfName: "rerun_tmp_df_channel_check_lz4k9c33",
  sessionId: "sess-sample-export",
};

function node<T>(id: string, type: string, data: T, x = 0, y = 0): Node {
  return { id, type, position: { x, y }, data: data as unknown as Record<string, unknown> } as Node;
}

const ORDERS: SourceTableNodeData = {
  type: "sourceTable",
  title: "orders",
  tableName: "orders",
  database: "sales",
  rowCount: 128450,
  description: `订单事实表 ${XSS_SENTINEL}`,
  createdAt: "2026-10-30T22:00:00.000Z",
  fields: [
    { name: "order_id", type: "BIGINT", nullable: false, isPrimaryKey: true, description: "订单号" },
    { name: "customer_id", type: "BIGINT", nullable: false, isForeignKey: true, references: { table: "customers", field: "id" } },
    { name: "amount", type: "DOUBLE", nullable: true, description: "金额（元）" },
    { name: "created_at", type: "TIMESTAMP", nullable: false },
  ],
};

const CUSTOMERS: SourceTableNodeData = {
  type: "sourceTable",
  title: "customers",
  tableName: "customers",
  database: "sales",
  rowCount: 8420,
  createdAt: "2026-10-30T22:01:00.000Z",
  fields: [
    { name: "id", type: "BIGINT", nullable: false, isPrimaryKey: true },
    { name: "区域", type: "VARCHAR", nullable: true, description: "华东/华北/华南/西部" },
    { name: "registered_at", type: "DATE", nullable: true },
  ],
};

const SQL_NODE: SQLQueryNodeData = {
  type: "sqlQuery",
  title: "月度销售额汇总 SQL",
  createdAt: "2026-10-30T22:09:00.000Z",
  sql: SQL_MONTHLY,
  outputColumns: ["月份", "区域", "销售额"],
  manifest: { ...MANIFEST_MONTHLY, dfName: undefined, rowCount: undefined, columnCount: undefined, checksum: undefined, origin: "assistant-sql", permissionDecisionId: null },
};

const DF_MONTHLY: DataFrameNodeData = {
  type: "dataFrame",
  title: "DF: df_monthly_sales",
  createdAt: "2026-10-30T22:10:30.000Z",
  dfName: "df_monthly_sales",
  sourceName: "sales",
  totalRows: 12,
  totalColumns: 3,
  memoryUsage: "1.2 KB",
  columns: [
    { name: "月份", nonNull: 12, dtype: "VARCHAR" },
    { name: "区域", nonNull: 12, dtype: "VARCHAR" },
    { name: "销售额", nonNull: 12, dtype: "DOUBLE" },
  ],
  previewData: [{ 月份: "2026-10", 区域: "华东", 销售额: ROW_SENTINEL }],
  manifest: MANIFEST_MONTHLY,
  rerunHistory: [DRIFT_RECORD, IDENTICAL_RECORD],
};

const DF_REGION: DataFrameNodeData = {
  type: "dataFrame",
  title: "DF: df_region_top",
  createdAt: "2026-10-30T22:31:30.000Z",
  dfName: "df_region_top",
  sourceName: "memory",
  totalRows: 4,
  totalColumns: 2,
  memoryUsage: "420 B",
  columns: [
    { name: "区域", nonNull: 4, dtype: "VARCHAR" },
    { name: "合计", nonNull: 4, dtype: "DOUBLE" },
  ],
  previewData: [],
  manifest: MANIFEST_MEMORY,
  rerunHistory: [ERROR_RECORD],
};

const DF_RESTORED: DataFrameNodeData = {
  type: "dataFrame",
  title: "DF: df_legacy_restored",
  createdAt: "2026-10-30T23:40:00.000Z",
  dfName: "df_legacy_restored",
  sourceName: "sales",
  totalRows: 900,
  totalColumns: 2,
  memoryUsage: "14 KB",
  columns: [
    { name: "k", nonNull: 900, dtype: "VARCHAR" },
    { name: "v", nonNull: 890, dtype: "DOUBLE" },
  ],
  previewData: [],
};

const DF_CHANNEL: DataFrameNodeData = {
  type: "dataFrame",
  title: "DF: df_channel_check",
  createdAt: "2026-10-30T22:45:30.000Z",
  dfName: "df_channel_check",
  sourceName: "sales",
  totalRows: 6,
  totalColumns: 2,
  memoryUsage: "640 B",
  columns: [
    { name: "渠道", nonNull: 6, dtype: "VARCHAR" },
    { name: "单量", nonNull: 6, dtype: "BIGINT" },
  ],
  previewData: [],
  manifest: MANIFEST_CHANNEL,
  rerunHistory: [IDENTICAL_RECORD_CHANNEL],
};

const CHART_BAR: ChartNodeData = {
  type: "chart",
  title: "月度销售额柱状图",
  createdAt: "2026-10-30T22:15:00.000Z",
  sourceDf: "df_monthly_sales",
  config: {
    type: "bar",
    data: [{ type: "bar", name: "销售额", x: ["2026-08", "2026-09", "2026-10"], y: [CHART_VALUE_SENTINEL, 2, 3] }],
    layout: { title: { text: "月度销售额" }, xaxis: { title: { text: "月份" } }, yaxis: { title: "销售额（元）" }, barmode: "group" },
  },
};

const CHART_PIE: ChartNodeData = {
  type: "chart",
  title: "区域占比饼图",
  createdAt: "2026-10-30T22:35:00.000Z",
  sourceDf: "df_region_top",
  config: {
    type: "pie",
    data: [{ type: "pie", name: "区域占比", hole: 0.4, labels: ["华东", "华北", "华南", "西部"], values: [CHART_VALUE_SENTINEL, 20, 30, 40] }],
    layout: { title: "区域占比", showlegend: true },
  },
};

const REPORT_DIFF: ReportNodeData = {
  type: "report",
  title: "9 月 vs 10 月销售额差异分析",
  createdAt: "2026-10-30T22:50:00.000Z",
  reportType: "diff",
  sourceRefs: [{ label: "df_monthly_sales" }, { label: "df_region_top" }],
  content: [
    "## 结论",
    "- **总销售额**: 环比上升 8.4%",
    "- 华东区域贡献最大 `df_region_top`",
    "",
    "### 明细",
    "| 区域 | 9 月 | 10 月 | 变化 |",
    "| --- | --- | --- | --- |",
    "| 华东 | 100 | 120 | +20% |",
    "| 华北 | 80 | 70 | -12.5% |",
    "",
    "1. 复核口径：仅统计 status = 'paid'",
    `2. 注入测试：${XSS_SENTINEL}`,
  ].join("\n"),
};

const NODES: Node[] = [
  node("src-1", "sourceTable", ORDERS),
  node("src-2", "sourceTable", CUSTOMERS),
  node("gov-1", "sqlQuery", SQL_NODE),
  node("gov-2", "dataFrame", DF_MONTHLY),
  node("gov-3", "dataFrame", DF_REGION),
  node("gov-4", "dataFrame", DF_RESTORED),
  node("gov-5", "chart", CHART_BAR),
  node("gov-6", "chart", CHART_PIE),
  node("gov-7", "report", REPORT_DIFF),
  node("gov-8", "dataFrame", DF_CHANNEL),
];

const EDGES: Edge[] = [
  { id: "e-src-1-gov-1", source: "src-1", target: "gov-1" },
  { id: "e-src-2-gov-1", source: "src-2", target: "gov-1" },
  { id: "e-gov-1-gov-2", source: "gov-1", target: "gov-2" },
  { id: "e-gov-1-gov-8", source: "gov-1", target: "gov-8" },
  { id: "e-gov-2-gov-3", source: "gov-2", target: "gov-3" },
  { id: "e-gov-2-gov-5", source: "gov-2", target: "gov-5" },
  { id: "e-gov-3-gov-6", source: "gov-3", target: "gov-6" },
  { id: "e-gov-2-gov-7", source: "gov-2", target: "gov-7" },
  { id: "e-gov-3-gov-7", source: "gov-3", target: "gov-7" },
  // 悬空边与自环：布局必须丢弃并如实计数
  { id: "e-dangling", source: "gov-2", target: "not-on-canvas" },
  { id: "e-self", source: "gov-4", target: "gov-4" },
];

/** 图表渲染结果：一个成功（内联 data URL），一个失败（降级为配置摘要） */
const TINY_SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#1db954"/></svg>').toString("base64")}`;
const CHART_RESULTS: ChartRenderMap = {
  "gov-5": { ok: true, dataUrl: TINY_SVG, width: 680, height: 400 },
  "gov-6": { ok: false, reason: "渲染失败：trace 类型 scattergl 不支持静态导出" },
};

/** 模拟 `GET /api/permission-audit` 的原始返回（含坏行与未知字段，测解析白名单）。
 * sessionFile 故意用绝对路径：报告只能渲染 basename，不得外泄操作者目录结构。 */
const RAW_AUDIT_RESPONSE = {
  sessionId: "sess-sample-export",
  sessionFile: "D:\\Work\\govio-map\\.govio\\sessions\\2026-10-30T22-00-00-000Z_sample.jsonl",
  total: 6,
  requested: 1,
  entries: [
    {
      v: 1, at: "2026-10-30T22:09:50.000Z", decisionId: DECISION_ID, sessionId: "sess-sample-export",
      type: "permission_request", gate: "ask",
      command: `govio-cli observe load --datasource sales --name df_monthly_sales -o out.json --sql "${SQL_MONTHLY}"`,
    },
    {
      v: 1, at: "2026-10-30T22:09:54.210Z", decisionId: DECISION_ID, sessionId: "sess-sample-export",
      type: "permission_decision", decision: "edit", source: "user", elapsedMs: 4210,
      reason: "去掉 -o 全表导出，只保留加载",
      command: "govio-cli observe load --datasource sales --name df_monthly_sales -o out.json --sql ...",
      editedCommand: "govio-cli observe load --datasource sales --name df_monthly_sales --sql ...",
    },
    {
      v: 1, at: "2026-10-30T22:30:00.000Z", decisionId: "pd-unrelated-9999", sessionId: "sess-sample-export",
      type: "permission_decision", decision: "deny", source: "timeout", elapsedMs: 300000,
      // 命令原文里的注入哨兵：附录 B 的命令单元格必须转义后呈现
      command: `govio-cli observe load --datasource sales --name df_x -o all.json --sql '${XSS_SENTINEL}'`,
    },
    { type: "permission_decision", at: "2026-10-30T22:31:00.000Z" }, // 坏行：缺 decisionId → 丢弃
    "not-an-object", // 坏行 → 丢弃
    {
      v: 1, at: "2026-10-30T22:32:00.000Z", decisionId: "pm-cccc4444", type: "permission_mode",
      acceptAll: false, reason: "用户关闭全局放行", pendingAffected: 0,
      notInWhitelist: "这个字段必须被解析白名单丢掉",
    },
  ],
};

const AUDIT: AuditAppendix = {
  available: true,
  sessionId: RAW_AUDIT_RESPONSE.sessionId,
  sessionFile: RAW_AUDIT_RESPONSE.sessionFile,
  requestedDecisionIds: collectPermissionDecisionIds(NODES),
  totalInSession: RAW_AUDIT_RESPONSE.total,
  entries: parseAuditEntries(RAW_AUDIT_RESPONSE.entries),
};

const HTML = buildDeliveryReportHtml({
  nodes: NODES,
  edges: EDGES,
  exportedAt: FIXED_EXPORTED_AT,
  appVersion: "0.6.1",
  chartResults: CHART_RESULTS,
  audit: AUDIT,
});

// ---------------------------------------------------------------------------
console.log("\n[1] 产物结构：自包含、离线可打开");

/** 剥掉 SVG 命名空间声明（那是标识符，不是网络引用）后再查外部资源 */
const withoutNamespaces = HTML.replace(/xmlns(:xlink)?="[^"]*"/g, "");

check("以 <!DOCTYPE html> 开头", HTML.startsWith("<!DOCTYPE html>"));
check("声明 zh-CN 与 UTF-8", HTML.includes('<html lang="zh-CN">') && HTML.includes('<meta charset="utf-8">'));
check("有 <title>", /<title>[^<]+<\/title>/.test(HTML), HTML.slice(0, 400));
check("样式内联在 <style> 里", HTML.includes("<style>") && HTML.includes("</style>"));
check("不含任何 <script>", !HTML.includes("<script"), "导出文件不应带脚本");
check("不含 <link>（无外部样式/字体）", !/<link\b/i.test(HTML));
check("不含 @import", !HTML.includes("@import"));
check("不含 http(s) 外部引用", !/https?:\/\//.test(withoutNamespaces), (withoutNamespaces.match(/https?:\/\/[^"'\s)]{0,60}/) ?? [""])[0]);
check("不含协议相对外部引用 //", !/(?:src|href)="\/\//.test(HTML));
check("不含 <iframe>/<object>/<embed>", !/<(iframe|object|embed)\b/i.test(HTML));
check("图片只有内联 data URL", [...HTML.matchAll(/<img[^>]+src="([^"]{0,40})/g)].every((m) => m[1].startsWith("data:")));
check("血缘 SVG 内联在文档里", HTML.includes('<svg class="lineage"') && HTML.includes("</svg>"));
check("报头含导出时间（钉住时区的字面量 + ISO 原文）与应用版本",
  HTML.includes(EXPECT_EXPORTED_AT) && HTML.includes(FIXED_EXPORTED_AT) && HTML.includes("Govio Map v0.6.1"),
  EXPECT_EXPORTED_AT);
check("导出时间格式为 YYYY-MM-DD HH:mm:ss", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(HTML));
check("含目录锚点（摘要/血缘图/节点卡片/附录 A/附录 B）",
  ['href="#summary"', 'href="#lineage"', 'href="#nodes"', 'href="#appendix-a"', 'href="#appendix-b"'].every((a) => HTML.includes(a)));
check("章节 id 齐全", ['id="summary"', 'id="lineage"', 'id="nodes"', 'id="appendix-a"', 'id="appendix-b"'].every((a) => HTML.includes(a)));
check("含打印样式（@media print）", HTML.includes("@media print"));
check("页脚声明不含数据行内容", HTML.includes("不含数据行内容"));

// ---------------------------------------------------------------------------
console.log("\n[2] 血缘图：层次布局与 SVG");

const layout = layoutLineage(NODES, EDGES);
const boxOf = (id: string) => layout.boxes.find((b) => b.id === id);
check("10 个节点都进了布局", layout.boxes.length === 10, `actual=${layout.boxes.length}`);
check("9 条有效边（悬空边与自环被丢弃）", layout.edges.length === 9, `actual=${layout.edges.length}`);
check("丢弃边数为 2", layout.droppedEdges === 2, `actual=${layout.droppedEdges}`);
check("源表在第 0 层", boxOf("src-1")?.level === 0 && boxOf("src-2")?.level === 0);
check("SQL 节点在第 1 层（最长路径）", boxOf("gov-1")?.level === 1, `actual=${boxOf("gov-1")?.level}`);
check("df_monthly_sales 在第 2 层", boxOf("gov-2")?.level === 2, `actual=${boxOf("gov-2")?.level}`);
check("派生 DF 与图表在第 3 层", boxOf("gov-3")?.level === 3 && boxOf("gov-5")?.level === 3);
check("依赖两个上游的报告在第 4 层", boxOf("gov-7")?.level === 4, `actual=${boxOf("gov-7")?.level}`);
check("同层按画布顺序纵向排列（src-1 在 src-2 上方）", (boxOf("src-1")?.y ?? 0) < (boxOf("src-2")?.y ?? 0));
check("层次越深 x 越大（左 → 右）", (boxOf("src-1")?.x ?? 0) < (boxOf("gov-1")?.x ?? 0) && (boxOf("gov-1")?.x ?? 0) < (boxOf("gov-7")?.x ?? 0));
check("画布尺寸覆盖 5 层 × 最多 3 行（第 0 层：两张源表 + 无血缘的恢复节点）",
  layout.width === 20 * 2 + 5 * 210 + 4 * 96 && layout.height === 20 * 2 + 3 * 52 + 2 * 26,
  `actual=${layout.width}x${layout.height}`);
check("阅读顺序层次优先（第 0 层按画布插入顺序）", layout.order.slice(0, 3).join(",") === "src-1,src-2,gov-4", layout.order.join(","));
check("阅读顺序覆盖全部节点且不重复", layout.order.length === 10 && new Set(layout.order).size === 10);
check("无依赖的 df_legacy_restored 停在第 0 层", boxOf("gov-4")?.level === 0);
check("SVG 里每条有效边一个 path + 一个箭头 marker",
  (HTML.match(/<path d="M /g) ?? []).length === 9 && HTML.includes('marker-end="url(#govio-arrow)"'));
check("SVG 里每个节点一个可点击盒子（跳到卡片）",
  (HTML.match(/xlink:href="#card-/g) ?? []).length === 10 && (HTML.match(/<rect class="box"/g) ?? []).length === 10);
check("每个节点卡片都有对应锚点 id", NODES.every((n) => HTML.includes(`id="card-${n.id}"`)));
check("血缘图有类型图例（五类）", ["数据源表", "SQL 查询", "DataFrame", "分析报告", "图表"].every((t) => HTML.includes(t)));
check("环不会让布局死循环（自环节点仍在布局里）", boxOf("gov-4") !== undefined);

// ---------------------------------------------------------------------------
console.log("\n[3] 节点卡片：五类静态快照");

check("sourceTable 卡片含表名/数据源/行数/字段结构",
  HTML.includes("orders") && HTML.includes("128,450") && HTML.includes("字段结构（4）") && HTML.includes("BIGINT"));
check("sourceTable 标出 PK 与 FK→引用", HTML.includes("PK") && HTML.includes("FK→customers.id"));
check("sqlQuery 卡片含 SQL 全文与输出列", HTML.includes("GROUP BY 1, 2") && HTML.includes("输出列") && HTML.includes("销售额"));
check("dataFrame 卡片含列结构（列名 + dtype + nonNull）",
  HTML.includes("列结构（3）") && HTML.includes("VARCHAR") && HTML.includes("DOUBLE"));
check("dataFrame 卡片含行 × 列与内存占用", HTML.includes("12 × 3") && HTML.includes("1.2 KB"));
check("report 卡片渲染 markdown 标题/列表/表格/粗体",
  HTML.includes('<div class="h2">结论</div>') && HTML.includes("<strong>总销售额</strong>")
  && HTML.includes("<td>+20%</td>") && HTML.includes("复核口径：仅统计 status = &#39;paid&#39;"));
check("report 卡片列出对比对象", HTML.includes("df_monthly_sales") && HTML.includes("df_region_top"));
check("chart 卡片成功时内联静态图片", HTML.includes(`<img class="chart" src="${TINY_SVG}"`));
check("chart 卡片标注为静态、不可交互", HTML.includes("静态、不可交互"));
check("chart 渲染失败时降级为配置摘要并写明原因",
  HTML.includes("图表未静态渲染，降级为配置摘要") && HTML.includes("scattergl 不支持静态导出"));
check("配置摘要给出 trace 元信息与数据点个数", HTML.includes("trace 摘要（不含数据值）") && HTML.includes("<td>pie</td>"));
check("图表原始数据值不进产物（只渲染图像/摘要）", !HTML.includes(String(CHART_VALUE_SENTINEL)));
check("卡片带上下游血缘链接", HTML.includes("上游：") && HTML.includes("下游："));
check("卡片显示创建时间与节点 ID", HTML.includes(`创建于 ${EXPECT_DF_CREATED_AT}`) && HTML.includes("gov-2"));
check("10 张卡片都在节点章节里", (HTML.match(/<article class="card/g) ?? []).length === 10,
  `actual=${(HTML.match(/<article class="card/g) ?? []).length}`);
check("摘要区统计节点/连线/DataFrame 数", HTML.includes("<dt>节点</dt><dd>10</dd>") && HTML.includes("<dt>血缘连线</dt><dd>9</dd>") && HTML.includes("<dt>DataFrame</dt><dd>4</dd>"));

// ---------------------------------------------------------------------------
console.log("\n[4] 漂移告警与复跑记录");

check("漂移节点卡片带 drift 样式", HTML.includes(`class="card drift" id="card-gov-2"`));
check("漂移节点头部有「漂移」徽标", HTML.includes('<span class="badge drift">漂移</span>'));
check("漂移警示框给出差异摘要", HTML.includes("⚠ 漂移警告") && HTML.includes(`最近一次复跑 ${EXPECT_DRIFT_RERUN_AT}`) && HTML.includes("行数 12 → 13（+1）；结构哈希变化"));
check("漂移说明写明原 Manifest 未被覆盖", HTML.includes("原 Manifest 未被覆盖"));
check("复现一致的节点有绿色结论徽标与结论框",
  HTML.includes('<span class="badge ok">复现一致</span>') && HTML.includes("✓ 最近一次复跑复现一致")
  && HTML.includes("6 行 × 2 列，校验和与原留痕一致"));
check("复跑失败有独立告警与原因", HTML.includes("✗ 最近一次复跑失败") && HTML.includes("1 个 DataFrame 最近一次复跑失败"));
check("摘要区列出漂移节点清单", HTML.includes("1 个 DataFrame 处于漂移警告态"));
check("摘要区统计复跑次数（2 + 1 + 1 = 4）", HTML.includes("<dt>复跑次数</dt><dd>4</dd>"));
check("复跑记录按最新在前编号列出",
  HTML.includes("复跑记录（2 次，最新在前）")
  && HTML.includes(`#1 ${EXPECT_DRIFT_RERUN_AT} · 漂移`)
  && HTML.includes(`#2 ${EXPECT_IDENTICAL_RERUN_AT} · 复现一致`));
check("复跑记录含原值 → 新值对比", HTML.includes("原 12 行 × 3 列") && HTML.includes("本次 13 行 × 3 列"));
check("复跑记录含耗时与临时 DF 名（便于清理残留）", HTML.includes("耗时 3.2s") && HTML.includes("rerun_tmp_df_monthly_sales_lz4k2a91"));
check("失败记录写明原因", HTML.includes("上游 DataFrame df_monthly_sales 已被释放"));
check("未复跑过的节点如实说明", HTML.includes("尚未复跑过"));
check("漂移节点的卡片行列数仍是已交付结果（不被新值覆盖）", HTML.includes("12 × 3") && !HTML.includes("13 × 3"));

// ---------------------------------------------------------------------------
console.log("\n[5] 附录 A：DataFrame Manifest");

const appendixA = HTML.slice(HTML.indexOf('id="appendix-a"'), HTML.indexOf('id="appendix-b"'));
check("附录 A 说明 4 个 dataFrame、3 个带 Manifest", appendixA.includes("共 4 个 dataFrame 节点，其中 3 个带 Manifest"));
check("附录 A 表格行数 = dataFrame 节点数", (appendixA.match(/<tr><td><a href="#card-/g) ?? []).length === 4,
  `actual=${(appendixA.match(/<tr><td><a href="#card-/g) ?? []).length}`);
check("人工执行（SQL 编辑器）的留痕没有生成模型", appendixA.includes("—（人工执行）"));
check("含 permissionDecisionId 列", appendixA.includes("权限决策 ID") && appendixA.includes(DECISION_ID));
check("permissionDecisionId 可点回附录 B 的确认记录", appendixA.includes(`href="#audit-${DECISION_ID}"`));
check("未过确认门的节点如实标注（permissionDecisionId = null）", appendixA.includes("未过确认门"));
check("无 Manifest 的节点标注「无 Manifest」", appendixA.includes("无 Manifest") && appendixA.includes("df_legacy_restored"));
check("含来源 / 数据源 / 执行时间 / 行 × 列", appendixA.includes("observe load") && appendixA.includes("memory")
  && appendixA.includes(EXPECT_MANIFEST_EXECUTED_AT) && appendixA.includes("12 × 3"));
check("含校验和两段哈希与算法", appendixA.includes("a1b2c3d4e5f60718") && appendixA.includes("0f1e2d3c4b5a6978") && appendixA.includes("schema-v1"));
check("含生成模型（provider / id → responseModel）", appendixA.includes("anthropic / claude-sonnet-4-5 → claude-sonnet-4-5-20250929"));
check("含会话 ID 与上游 DF", appendixA.includes("sess-sample-export"));
check("SQL 全文折在 details 里且原样保留", appendixA.includes("<details id=\"manifest-gov-2\"") && appendixA.includes("GROUP BY 1, 2") && appendixA.includes("-- 月度销售额汇总（口径：已支付订单）"));
check("标注是否可一键复跑", appendixA.includes("是（SQL 与数据源齐全）"));
check("说明 executedAt 的受控例外（T1.2 语义）", appendixA.includes("executedAt"));
check("附录 A 不含无 Manifest 节点的 SQL 详情块", !appendixA.includes('id="manifest-gov-4"'));

// ---------------------------------------------------------------------------
console.log("\n[6] 附录 B：权限确认记录（只读通道）");

const appendixB = HTML.slice(HTML.indexOf('id="appendix-b"'));
check("写明审计来源 sidecar（只渲染 basename，不外泄本机绝对路径）与会话",
  appendixB.includes("2026-10-30T22-00-00-000Z_sample.jsonl.audit.jsonl") && appendixB.includes("sess-sample-export")
  && !HTML.includes("D:") && !HTML.includes("\\Work\\"));
check("写明「会话内共 6 条，带出 4 条」", appendixB.includes("会话内共 6 条记录") && appendixB.includes("关联的 4 条"));
check("请求与决策两条记录都在（同一 decisionId 配对）", appendixB.includes("确认请求") && appendixB.includes("确认决策"));
check("决策翻译成中文（edit → 修改后放行）", appendixB.includes("修改后放行"));
check("来源区分用户与系统代答（timeout → 超时自动拒绝）", appendixB.includes("用户") && appendixB.includes("超时自动拒绝"));
check("改前与改后命令都带出", appendixB.includes("-o out.json") && appendixB.includes("改后命令"));
check("决策备注带出", appendixB.includes("去掉 -o 全表导出，只保留加载"));
check("闸门信息与 elapsedMs 带出", appendixB.includes("闸门：人工确认") && appendixB.includes("4.2s"));
check("记录可跳回关联节点", appendixB.includes(`href="#card-gov-2"`));
check("同一 decisionId 的锚点只出现一次（避免重复 id）",
  (appendixB.match(new RegExp(`id="audit-${DECISION_ID}"`, "g")) ?? []).length === 1);
check("长命令折进 details，不撑爆表格", appendixB.includes("<details><summary>"));
check("解析白名单丢掉未知字段", !HTML.includes("notInWhitelist") && !HTML.includes("这个字段必须被解析白名单丢掉"));
check("解析丢掉坏行（缺 decisionId / 非对象）", AUDIT.entries.length === 4 && !HTML.includes("not-an-object"));
check("解析保留 v / acceptAll / pendingAffected 等已知字段",
  AUDIT.entries.some((e) => e.v === 1) && AUDIT.entries.some((e) => e.acceptAll === false && e.pendingAffected === 0));
check("放行模式变更事件也能渲染（备注不重复）",
  appendixB.includes("放行模式变更") && appendixB.includes("用户关闭全局放行 · acceptAll=关 · 影响挂起请求 0")
  && (appendixB.match(/用户关闭全局放行/g) ?? []).length === 1);
check("未关联到节点的模式事件在「关联节点」列如实置空", appendixB.includes('<td><span class="note">—</span></td>'));
check("附录 B 声明不含查询结果", appendixB.includes("不含任何查询结果"));
check("collectPermissionDecisionIds 去重且跳过 null",
  JSON.stringify(collectPermissionDecisionIds(NODES)) === JSON.stringify([DECISION_ID]));

// 审计通道不可用 / 无关联记录 / 未尝试获取：三种降级都要如实写进报告
const htmlNoAudit = buildDeliveryReportHtml({ nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT, audit: null });
check("未尝试获取审计时如实说明", htmlNoAudit.includes("未获取审计记录") && htmlNoAudit.includes("非浏览器环境"));
const htmlAuditDown = buildDeliveryReportHtml({
  nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT,
  audit: { available: false, requestedDecisionIds: [DECISION_ID], entries: [], reason: "无法连接后端审计通道（Failed to fetch）；请确认 Govio Map 后端已启动。" },
});
check("审计通道不可用时写明原因并说明影响", htmlAuditDown.includes("未获取到审计记录") && htmlAuditDown.includes("Failed to fetch") && htmlAuditDown.includes("缺少「谁批准了这次取数」的佐证"));
const htmlNoGate = buildDeliveryReportHtml({
  nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT,
  audit: { available: true, requestedDecisionIds: [], entries: [], totalInSession: 0 },
});
check("没有任何节点过确认门时说明原因（不是静默空表）", htmlNoGate.includes("没有与画布节点关联的确认记录") && htmlNoGate.includes("没有任何节点带 permissionDecisionId"));
const htmlAuditEmpty = buildDeliveryReportHtml({
  nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT,
  audit: { available: true, requestedDecisionIds: [DECISION_ID], entries: [], totalInSession: 2 },
});
check("通道可读但匹配不到记录时给出可能原因", htmlAuditEmpty.includes("没有匹配记录"));
check("审计不可用时权限决策 ID 不再是死链", !htmlAuditDown.includes(`href="#audit-${DECISION_ID}"`) && htmlAuditDown.includes(DECISION_ID));

// ---------------------------------------------------------------------------
console.log("\n[7] 转义、确定性与样例产物");

check("画布内容里的 <script> 被转义（不变成脚本）", !HTML.includes("<script>alert") && HTML.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
check("表说明里的注入内容被转义", HTML.includes(`订单事实表 ${XSS_SENTINEL.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;")}`));
check("附录 B 审计命令原文里的注入内容被转义", appendixB.includes("&lt;script&gt;alert(&#39;xss&#39;)") && !appendixB.includes("<script>alert"));
check("SQL 里的 < 与单引号被转义", HTML.includes("o.amount &lt; 100000") && HTML.includes("o.status = &#39;paid&#39;"));
// 属性引号闭合：节点标题进入 <img alt="..."> 属性位，双引号必须变成 &quot;
{
  const quoteChart: ChartNodeData = {
    type: "chart",
    title: `图表 "A" ${XSS_SENTINEL}`,
    createdAt: FIXED_EXPORTED_AT,
    sourceDf: "df_x",
    config: { type: "bar", data: [{ type: "bar", x: ["a"], y: [1] }], layout: {} },
  };
  const htmlQuote = buildDeliveryReportHtml({
    nodes: [node("q-1", "chart", quoteChart)],
    edges: [],
    exportedAt: FIXED_EXPORTED_AT,
    chartResults: { "q-1": { ok: true, dataUrl: TINY_SVG, width: 10, height: 10 } },
  });
  check("节点标题里的双引号在属性中被转义（引号闭合不被打破）",
    htmlQuote.includes('alt="图表静态快照：图表 &quot;A&quot; &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"'));
}
check("dataFrame 的 previewData 数据行不进产物", !HTML.includes(ROW_SENTINEL));
check("空画布也能产出合法 HTML", (() => {
  const empty = buildDeliveryReportHtml({ nodes: [], edges: [], exportedAt: FIXED_EXPORTED_AT });
  return empty.startsWith("<!DOCTYPE html>") && empty.includes("画布为空") && empty.includes("画布上没有 dataFrame 节点");
})());
check("同一输入产出逐字节相同的 HTML（确定性）",
  HTML === buildDeliveryReportHtml({ nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT, appVersion: "0.6.1", chartResults: CHART_RESULTS, audit: AUDIT }));
check("文件名由导出时间推导", reportFileName(FIXED_EXPORTED_AT).startsWith("govio-delivery-report-") && reportFileName(FIXED_EXPORTED_AT).endsWith(".html") && /\d{8}-\d{4}\.html$/.test(reportFileName(FIXED_EXPORTED_AT)), reportFileName(FIXED_EXPORTED_AT));
check("tracePointCount 只数长度不取值", tracePointCount(CHART_PIE.config.data[0]!) === 4 && tracePointCount({ type: "bar" }) === null);

// ---------------------------------------------------------------------------
console.log("\n[8] 确认门徽标区分 / 审计截断告知 / 空 decisionIds 形态");

check("人工确认的节点徽标为「已过确认门」且不带自动放行字样",
  HTML.includes("已过确认门") && !HTML.includes("已过确认门（自动放行）") && !HTML.includes("已确认取数"));
{
  const AUTO_ID = "pd-auto-7777";
  const autoDf: DataFrameNodeData = {
    type: "dataFrame",
    title: "DF: df_auto",
    createdAt: FIXED_EXPORTED_AT,
    dfName: "df_auto",
    sourceName: "sales",
    totalRows: 1,
    totalColumns: 1,
    memoryUsage: "8 B",
    columns: [{ name: "a", nonNull: 1, dtype: "BIGINT" }],
    previewData: [],
    manifest: manifest({ origin: "observe-load", sql: "SELECT 1", datasource: "sales", dfName: "df_auto", permissionDecisionId: AUTO_ID }),
  };
  const htmlAuto = buildDeliveryReportHtml({
    nodes: [node("df-auto", "dataFrame", autoDf)],
    edges: [],
    exportedAt: FIXED_EXPORTED_AT,
    audit: {
      available: true,
      requestedDecisionIds: [AUTO_ID],
      totalInSession: 2,
      entries: parseAuditEntries([
        { v: 1, at: "2026-10-30T22:09:50.000Z", decisionId: AUTO_ID, type: "permission_request", gate: "accept-all", command: "govio-cli observe load --name df_auto --datasource sales -o out.json --sql 'SELECT 1'" },
        { v: 1, at: "2026-10-30T22:09:50.000Z", decisionId: AUTO_ID, type: "permission_decision", decision: "allow", source: "accept-all", elapsedMs: 0, command: "govio-cli observe load --name df_auto --datasource sales -o out.json --sql 'SELECT 1'" },
      ]),
    },
  });
  check("Accept All 自动放行的徽标可区分（不误导为人工逐条批准）", htmlAuto.includes("已过确认门（自动放行）"));
}
{
  const manyIds = Array.from({ length: 600 }, (_, i) => `pd-trunc-${i}`);
  const htmlTruncated = buildDeliveryReportHtml({
    nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT,
    audit: { ...AUDIT, requestedDecisionIds: manyIds, serverRequested: 600, truncated: true },
  });
  check("服务端截断时报告如实告知（不拿前端请求数充数）",
    htmlTruncated.includes("审计通道截断，仅带出前 500 个 decisionId") && htmlTruncated.includes("按 600 个 decisionId 过滤"));
}
{
  // 无节点过确认门时 fetchAuditAppendix 不发请求，形态与 renderAppendixB 的断言分支一致
  const emptyAudit = await fetchAuditAppendix([]);
  check("空 decisionIds → available:true + 空 entries（不是通道不可用）",
    emptyAudit.available === true && emptyAudit.entries.length === 0 && emptyAudit.totalInSession === 0);
  const htmlEmptyFetch = buildDeliveryReportHtml({ nodes: NODES, edges: EDGES, exportedAt: FIXED_EXPORTED_AT, audit: emptyAudit });
  check("该形态渲染「没有任何节点带 permissionDecisionId」而非「未获取到」", htmlEmptyFetch.includes("没有任何节点带 permissionDecisionId") && !htmlEmptyFetch.includes("未获取到审计记录"));
}

const artifactDir = join(process.cwd(), "docs", "tasks", "T1.4-canvas-export");
const artifactPath = join(artifactDir, "sample-export.html");
const trackedBefore = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : null;
const tmpDir = mkdtempSync(join(tmpdir(), "govio-export-verify-"));
const tmpPath = join(tmpDir, "sample-export.html");
writeFileSync(tmpPath, HTML, "utf8");
const written = readFileSync(tmpPath, "utf8");
check("产物落盘（临时目录）且与内存产物一致", written === HTML, tmpPath);
check("样例产物体积在可读范围（< 200 KB）", Buffer.byteLength(HTML, "utf8") < 200 * 1024, `${Buffer.byteLength(HTML, "utf8")} bytes`);
check("样例产物不含外部资源引用（离线可打开）", !/https?:\/\//.test(written.replace(/xmlns(:xlink)?="[^"]*"/g, "")));

if (process.argv.includes("--write")) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(artifactPath, HTML, "utf8");
  check("--write：受跟踪样例已更新且与内存产物一致", readFileSync(artifactPath, "utf8") === HTML, artifactPath);
  console.log(`\n样例交付报告已更新：${artifactPath}（双击可在浏览器离线打开）`);
} else {
  const trackedAfter = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : null;
  check("默认运行不改写受跟踪样例（git 工作树保持干净）", trackedAfter === trackedBefore);
  console.log(`\n样例产物（临时）：${tmpPath}；更新受跟踪样例请追加 --write`);
  rmSync(tmpDir, { recursive: true, force: true });
}
console.log(`共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: 交付报告自包含、含五类节点与血缘图、附录 A/B 齐全、漂移有警示、内容全部转义");
