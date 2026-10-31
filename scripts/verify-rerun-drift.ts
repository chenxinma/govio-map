/**
 * T1.2 验证脚本：DataFrame 一键复跑与漂移提示。
 *
 * 复跑：
 *  - `npm run verify:rerun`             —— mock runner，不依赖 govio-cli（默认）
 *  - `npm run verify:rerun -- --real`   —— 额外用真实 govio-cli + `sales` 数据源跑一遍完整复跑链路
 *
 * 覆盖五件事：
 *  1. 复跑参数只来自 Manifest 固化的 SQL/数据源（不是任何「当前输入」），且用临时 DataFrame 名
 *  2. 三态判定：一致 / 漂移（行数、列结构、无基线）/ 失败，且临时 DF 总是被释放
 *  3. 前端写入规则：一致刷新 executedAt、漂移保留原 Manifest、记录最新在前且封顶
 *  4. store → canvas_save → loadCanvas → hydrateSession：复跑记录随 canvas sidecar 往返不丢
 *  5. （--real）真实 CLI：复跑得到 identical、原 DataFrame 未被覆盖、临时 DF 已释放、伪造基线可检出漂移
 *
 * 任一断言失败退出码为 1。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RERUN_TMP_PREFIX,
  buildRerunLoadArgs,
  compareRerunResult,
  parseLoadOutput,
  rerunBlockReason,
  rerunDataFrame,
  tempDfNameFor,
  type GovioCliRunner,
} from "../server/dataframe-rerun.js";
import { buildManifest, computeChecksum } from "../server/analysis-manifest.js";
import { runGovioCliWithArgs } from "../server/govio-cli-exec.js";
import { loadCanvas, saveCanvas } from "../server/session-history.js";
import {
  MAX_RERUN_HISTORY,
  canRerun,
  hasDrift,
  latestRerun,
  withRerunRecord,
} from "../src/utils/rerun.js";
import type { Node, Edge } from "@xyflow/react";
import type { AnalysisManifest } from "../src/types/manifest.js";
import type { DataFrameNodeData, RerunRecord } from "../src/types/index.js";

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

const FIXED_NOW = new Date("2026-10-30T23:20:00.000Z");
const SQL = [
  "SELECT o.order_id, o.amount, c.备注",
  "FROM orders o",
  `WHERE o.amount > 100 AND c.name = '张"三'`,
].join("\n");
const COLUMNS = [
  { name: "order_id", dtype: "int64" },
  { name: "amount", dtype: "float64" },
  { name: "备注", dtype: "str" },
];

const manifest: AnalysisManifest = buildManifest({
  origin: "observe-load",
  sql: SQL,
  datasource: "sales",
  dfName: "df_orders",
  columns: COLUMNS,
  rowCount: 1200,
  columnCount: 3,
  executedAt: "2026-10-30T22:30:00.000Z",
  context: { sessionId: "sess-original", model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
});

function loadOutput(rows: number, columns = COLUMNS): string {
  return JSON.stringify({
    success: true,
    name: "ignored",
    rows,
    columns: columns.length,
    column_info: columns,
  });
}

// ── 1. 复跑参数只来自 Manifest ─────────────────────────────────────────────

console.log("\n[1] 复跑参数来自 Manifest 固化的 SQL（非当前输入）");
{
  const calls: string[][] = [];
  const runner: GovioCliRunner = async (args) => {
    calls.push(args);
    return args[1] === "release" ? JSON.stringify({ success: true }) : loadOutput(1200);
  };
  const record = await rerunDataFrame(manifest, { runCli: runner, sessionId: "sess-rerun", now: () => FIXED_NOW });

  const loadArgs = calls[0] ?? [];
  check("只调用了 load + release 两条命令", calls.length === 2 && loadArgs[1] === "load" && calls[1][1] === "release");
  check("SQL 全文作为单个数组参数原样传入（含换行/引号/中文）", loadArgs[loadArgs.length - 1] === SQL);
  // 结构性保证：rerunDataFrame 的入参只有 Manifest，不存在「当前输入」通道；
  // 这里断言 argv 里没有 Manifest 之外的 SQL 痕迹
  check("argv 未混入 Manifest 之外的 SQL", !loadArgs.some((a) => a.includes("something_else")));
  check("数据源取自 Manifest", loadArgs.includes("--datasource") && loadArgs[loadArgs.indexOf("--datasource") + 1] === "sales");
  check("写入临时 DataFrame 名而非原名（不覆盖已交付结果）", loadArgs[loadArgs.indexOf("--name") + 1].startsWith(RERUN_TMP_PREFIX) && !loadArgs.includes("df_orders"));
  check("临时名是 CLI 安全标识符", /^[a-z0-9_]+$/.test(loadArgs[loadArgs.indexOf("--name") + 1]));
  check("比对后释放同名临时 DataFrame", calls[1].join(" ") === `observe release --name ${loadArgs[loadArgs.indexOf("--name") + 1]}`);
  check("buildRerunLoadArgs 对 --memory 数据源走 --memory", buildRerunLoadArgs({ ...manifest, datasource: "memory" }, "rerun_tmp_x").includes("--memory"));
  check("tempDfNameFor 归一化非法字符", tempDfNameFor("DF-Orders 表", FIXED_NOW).startsWith(RERUN_TMP_PREFIX) && /^[a-z0-9_]+$/.test(tempDfNameFor("DF-Orders 表", FIXED_NOW)));
  check("记录带会话 ID / 临时名 / 完成时间", record.sessionId === "sess-rerun" && record.tempDfName === loadArgs[loadArgs.indexOf("--name") + 1] && record.rerunAt === FIXED_NOW.toISOString());
  check("不可复跑的 Manifest 被拦住", rerunBlockReason({ ...manifest, sql: "" }) !== null && rerunBlockReason({ ...manifest, datasource: "" }) !== null && rerunBlockReason(manifest) === null);
  // 畸形留痕（sidecar 由客户端写入，未做 schema 校验）的形状防御
  check("非字符串 sql/datasource 被拦住（不把非字符串传进 CLI 参数）",
    rerunBlockReason({ ...manifest, sql: 42 as unknown as string }) !== null
    && rerunBlockReason({ ...manifest, datasource: { name: "sales" } as unknown as string }) !== null);
  check("dfName 含非法字符被拦住（仅限字母/数字/下划线）",
    rerunBlockReason({ ...manifest, dfName: "df orders" }) !== null
    && rerunBlockReason({ ...manifest, dfName: "df_x;touch pwned" }) !== null
    && rerunBlockReason({ ...manifest, dfName: 7 as unknown as string }) !== null
    && rerunBlockReason({ ...manifest, dfName: "df_ok" }) === null);
  check("无 SQL 的节点不渲染复跑按钮（canRerun）", canRerun({ manifest } as unknown as DataFrameNodeData) === true && canRerun({ manifest: { ...manifest, sql: "  " } } as unknown as DataFrameNodeData) === false);
}

// ── 2. 三态判定 ────────────────────────────────────────────────────────────

console.log("\n[2] 一致 / 漂移 / 失败 三态判定");
{
  const identicalBefore = (await rerunDataFrame(manifest, {
    runCli: async (args) => (args[1] === "release" ? "{}" : loadOutput(1200)),
    now: () => FIXED_NOW,
  })).before;
  const same = compareRerunResult(manifest, { rowCount: 1200, columnCount: 3, columns: COLUMNS });
  check("行数与列结构一致 → identical", same.outcome === "identical" && same.diff === undefined);
  check("identical 的 after 校验和与原 Manifest 相同", same.after.checksum?.schemaHash === manifest.checksum?.schemaHash);
  check("after 快照给出本次行列数", same.after.rowCount === 1200 && same.after.columnCount === 3 && same.after.checksum?.algorithm === "schema-v1");
  check("before 快照保留原执行时间", identicalBefore.executedAt === "2026-10-30T22:30:00.000Z" && identicalBefore.rowCount === 1200);

  const rows = compareRerunResult(manifest, { rowCount: 1350, columnCount: 3, columns: COLUMNS });
  check("行数变化 → drift", rows.outcome === "drift" && rows.diff?.rowCountDelta === 150);
  check("漂移摘要写出旧值 → 新值", (rows.diff?.summary ?? "").includes("1200 → 1350"), rows.diff?.summary);

  const renamed = compareRerunResult(manifest, {
    rowCount: 1200,
    columnCount: 3,
    columns: [{ name: "order_id", dtype: "int64" }, { name: "amount", dtype: "float64" }, { name: "remark", dtype: "str" }],
  });
  check("列名变化 → drift（schemaChanged）", renamed.outcome === "drift" && renamed.diff?.schemaChanged === true && renamed.diff?.rowCountDelta === 0);

  const retyped = compareRerunResult(manifest, {
    rowCount: 1200,
    columnCount: 3,
    columns: [{ name: "order_id", dtype: "int64" }, { name: "amount", dtype: "str" }, { name: "备注", dtype: "str" }],
  });
  check("dtype 变化 → drift", retyped.outcome === "drift" && retyped.diff?.schemaChanged === true);

  const noChecksum = compareRerunResult({ ...manifest, checksum: undefined }, { rowCount: 1200, columnCount: 3, columns: COLUMNS });
  check("原留痕无校验和时退化到行数对比（不误报漂移）", noChecksum.outcome === "identical");
  const noChecksumDrift = compareRerunResult({ ...manifest, checksum: undefined }, { rowCount: 900, columnCount: 3, columns: COLUMNS });
  check("无校验和但行数变化 → drift", noChecksumDrift.outcome === "drift" && noChecksumDrift.diff?.rowCountDelta === -300);

  const noBaseline = compareRerunResult(
    { ...manifest, checksum: undefined, rowCount: undefined, columnCount: undefined },
    { rowCount: 1200, columnCount: 3, columns: COLUMNS },
  );
  check("原留痕无任何基线 → drift（不给假的绿灯）", noBaseline.outcome === "drift" && noBaseline.diff?.baselineIncomplete === true);
  check("无基线摘要说明无法确认", (noBaseline.diff?.summary ?? "").includes("无法确认"), noBaseline.diff?.summary);

  check("parseLoadOutput 兼容 observe info 的 schema/column 键名", parseLoadOutput(JSON.stringify({ rows: 2, columns: 1, schema: [{ column: "a", dtype: "int32" }] }))?.columns[0].name === "a");
  check("parseLoadOutput 拒绝被截断的输出", parseLoadOutput('{"success": true, "rows": 1') === null);
  check("parseLoadOutput 拒绝 success=false", parseLoadOutput(JSON.stringify({ success: false, message: "boom" })) === null);
}

console.log("\n[3] 失败路径与临时 DataFrame 释放");
{
  const released: string[] = [];
  const failing: GovioCliRunner = async (args) => {
    if (args[1] === "release") { released.push(args[args.length - 1]); return JSON.stringify({ success: true }); }
    throw new Error("Database connection refused");
  };
  const errRecord = await rerunDataFrame(manifest, { runCli: failing, now: () => FIXED_NOW });
  check("CLI 失败 → outcome=error 且带原因", errRecord.outcome === "error" && (errRecord.error ?? "").includes("Database connection refused"));
  check("失败记录不含 after（没有结果）", errRecord.after === undefined);
  check("失败也释放临时 DataFrame", released.length === 1 && released[0] === errRecord.tempDfName);

  const truncated: GovioCliRunner = async (args) => (args[1] === "release" ? "{}" : '{"success": true, "rows"');
  const truncatedRecord = await rerunDataFrame(manifest, { runCli: truncated, now: () => FIXED_NOW });
  check("输出被截断 → outcome=error", truncatedRecord.outcome === "error" && (truncatedRecord.error ?? "").includes("无法解析"));

  const blockedCalls: string[][] = [];
  const blockedRecord = await rerunDataFrame(
    { ...manifest, sql: "" },
    { runCli: async (args) => { blockedCalls.push(args); return "{}"; }, now: () => FIXED_NOW },
  );
  check("无 SQL 的 Manifest → outcome=error 且不调用 CLI", blockedRecord.outcome === "error" && blockedCalls.length === 0 && (blockedRecord.error ?? "").includes("SQL"));

  let releaseFailed = false;
  const releaseFails: GovioCliRunner = async (args) => {
    if (args[1] === "release") throw new Error("release failed");
    return loadOutput(1200);
  };
  const stillOk = await rerunDataFrame(manifest, { runCli: releaseFails, now: () => FIXED_NOW }).catch(() => { releaseFailed = true; return null; });
  check("释放失败不影响复跑结论（只告警）", !releaseFailed && stillOk?.outcome === "identical" && (stillOk?.tempDfName ?? "").length > 0);
}

// ── 4. 前端写入规则 ────────────────────────────────────────────────────────

console.log("\n[4] 复跑记录写入节点数据（一致刷新时间 / 漂移保留原 Manifest）");
const identicalRecord: RerunRecord = await rerunDataFrame(manifest, {
  runCli: async (args) => (args[1] === "release" ? "{}" : loadOutput(1200)),
  sessionId: "sess-rerun",
  now: () => FIXED_NOW,
});
const driftRecord: RerunRecord = await rerunDataFrame(manifest, {
  runCli: async (args) => (args[1] === "release" ? "{}" : loadOutput(1350)),
  sessionId: "sess-rerun",
  now: () => new Date("2026-10-30T23:40:00.000Z"),
});
{
  const nodeData: DataFrameNodeData = {
    type: "dataFrame",
    title: "DF: df_orders",
    createdAt: "2026-10-30T22:30:00.000Z",
    dfName: "df_orders",
    sourceName: "sales",
    totalRows: 1200,
    totalColumns: 3,
    memoryUsage: "28.1 KB",
    columns: COLUMNS.map((c) => ({ ...c, nonNull: 1200 })),
    previewData: [],
    manifest,
  };

  const afterIdentical = withRerunRecord(nodeData, identicalRecord);
  check("一致 → 记录追加到 rerunHistory（最新在前）", afterIdentical.rerunHistory?.[0] === identicalRecord);
  check("一致 → 刷新 manifest.executedAt 为复跑时间", afterIdentical.manifest?.executedAt === FIXED_NOW.toISOString());
  check("一致 → 首次固化时间 firstExecutedAt 不被刷新覆盖", afterIdentical.manifest?.firstExecutedAt === "2026-10-30T22:30:00.000Z");
  check("一致 → 原执行时间保留在记录 before 里", afterIdentical.rerunHistory?.[0].before.executedAt === "2026-10-30T22:30:00.000Z");
  check("一致 → 不显示漂移警告", hasDrift(afterIdentical) === false);
  check("一致 → Manifest 其余字段未被改写", afterIdentical.manifest?.sql === SQL && afterIdentical.manifest?.checksum?.schemaHash === manifest.checksum?.schemaHash);
  check("入参 data 未被就地修改（不可变更新）", nodeData.rerunHistory === undefined && nodeData.manifest === manifest);

  const afterDrift = withRerunRecord(nodeData, driftRecord);
  check("漂移 → 原 Manifest 完整保留（深度相等）", JSON.stringify(afterDrift.manifest) === JSON.stringify(manifest));
  check("漂移 → 节点显示警告标记", hasDrift(afterDrift) === true);
  check("漂移 → 记录含旧值/新值/时间", afterDrift.rerunHistory?.[0].before.rowCount === 1200 && afterDrift.rerunHistory?.[0].after?.rowCount === 1350 && afterDrift.rerunHistory?.[0].rerunAt === "2026-10-30T23:40:00.000Z");
  check("漂移 → 差异摘要给出旧值 → 新值", (latestRerun(afterDrift)?.diff?.summary ?? "").includes("1200 → 1350"));
  check("漂移 → 节点展示的行列数仍是原交付值", afterDrift.totalRows === 1200 && afterDrift.totalColumns === 3);

  const twice = withRerunRecord(afterDrift, identicalRecord);
  check("再次复跑一致 → 漂移警告消除", hasDrift(twice) === false && twice.rerunHistory?.length === 2 && latestRerun(twice) === identicalRecord);

  let capped = nodeData;
  for (let i = 0; i < MAX_RERUN_HISTORY + 5; i++) {
    capped = withRerunRecord(capped, { ...identicalRecord, rerunAt: new Date(FIXED_NOW.getTime() + i * 1000).toISOString() });
  }
  check(`记录条数封顶 ${MAX_RERUN_HISTORY}（最新在前）`, capped.rerunHistory?.length === MAX_RERUN_HISTORY && capped.rerunHistory?.[0].rerunAt === new Date(FIXED_NOW.getTime() + (MAX_RERUN_HISTORY + 4) * 1000).toISOString());
  check("连续复跑把历史顶满后，firstExecutedAt 仍可回溯首次交付时间", capped.manifest?.firstExecutedAt === "2026-10-30T22:30:00.000Z");

  // 旧留痕没有 firstExecutedAt 字段：首次一致复跑时从 record.before 补齐
  const legacy = { ...manifest } as AnalysisManifest & { firstExecutedAt?: string };
  delete legacy.firstExecutedAt;
  const afterLegacy = withRerunRecord({ ...nodeData, manifest: legacy }, identicalRecord);
  check("旧留痕缺 firstExecutedAt 时从 before.executedAt 补齐", afterLegacy.manifest?.firstExecutedAt === "2026-10-30T22:30:00.000Z");
}

// ── 5. store 全链路 + canvas sidecar 往返 ──────────────────────────────────

console.log("\n[5] store → canvas_save → loadCanvas → hydrateSession（记录落 canvas sidecar）");
{
  const { useCanvasStore } = await import("../src/store/canvas-store.js");
  const requests: Array<{ url: string; body: string }> = [];
  let respondWith: { status: number; payload: unknown } = { status: 200, payload: { record: driftRecord } };
  (globalThis as { window?: unknown }).window = { location: { port: "5173" } };
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { body?: string }) => {
    requests.push({ url, body: String(init?.body ?? "") });
    return { ok: respondWith.status === 200, status: respondWith.status, json: async () => respondWith.payload };
  };

  const dir = mkdtempSync(join(tmpdir(), "govio-rerun-"));
  const sessionFile = join(dir, "2026-10-30_rerun.jsonl");
  try {
    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_orders",
      dfName: "df_orders",
      sourceName: "sales",
      totalRows: 1200,
      totalColumns: 3,
      memoryUsage: "28.1 KB",
      columns: COLUMNS.map((c) => ({ ...c, nonNull: 1200 })),
      manifest,
    });
    const nodeId = useCanvasStore.getState().nodes[0].id;

    await useCanvasStore.getState().rerunDataFrame(nodeId);
    const afterRerun = useCanvasStore.getState();
    const data = afterRerun.nodes[0].data as unknown as DataFrameNodeData;
    check("复跑请求打到 /api/rerun-dataframe 且只传 nodeId", requests[0].url.endsWith("/api/rerun-dataframe") && requests[0].body === JSON.stringify({ nodeId }), requests[0]?.body);
    check("前端不上传 SQL（复跑用服务端固化的留痕）", !requests[0].body.includes("SELECT"));
    check("漂移记录写入 node.data.rerunHistory", data.rerunHistory?.length === 1 && data.rerunHistory?.[0].outcome === "drift");
    check("漂移时原 Manifest 未被覆盖", JSON.stringify(data.manifest) === JSON.stringify(manifest));
    check("复跑结束后清除进行中状态", afterRerun.rerunningNodeIds.length === 0 && afterRerun.rerunErrors[nodeId] === undefined);

    // 并发点击：同一节点复跑中不重复发起
    respondWith = { status: 200, payload: { record: identicalRecord } };
    const before = requests.length;
    await Promise.all([
      useCanvasStore.getState().rerunDataFrame(nodeId),
      useCanvasStore.getState().rerunDataFrame(nodeId),
    ]);
    check("同一节点并发复跑只发一次请求", requests.length === before + 1, `requests=${requests.length - before}`);
    const refreshed = useCanvasStore.getState().nodes[0].data as unknown as DataFrameNodeData;
    check("一致记录追加后刷新 executedAt 并消除警告", refreshed.manifest?.executedAt === FIXED_NOW.toISOString() && hasDrift(refreshed) === false && refreshed.rerunHistory?.length === 2);

    // 请求本身失败（后端未启动 / sidecar 里找不到节点）：只临时提示，不写留痕
    respondWith = { status: 409, payload: { error: "当前会话画布里找不到该节点的分析留痕" } };
    await useCanvasStore.getState().rerunDataFrame(nodeId);
    const failedState = useCanvasStore.getState();
    check("请求失败 → 节点临时错误提示", (failedState.rerunErrors[nodeId] ?? "").includes("找不到"));
    check("请求失败 → 不追加留痕记录", (failedState.nodes[0].data as unknown as DataFrameNodeData).rerunHistory?.length === 2);

    // canvas_save（useChat.sendCanvasSnapshot 发的就是整个 store 快照）→ sidecar → 重开会话
    const snapshot = useCanvasStore.getState();
    saveCanvas(sessionFile, snapshot.nodes, snapshot.edges);
    const loaded = loadCanvas(sessionFile);
    check("sidecar 可读回", loaded !== null);
    const sidecarData = (loaded?.nodes ?? [])[0] as { data: DataFrameNodeData };
    check("复跑记录随 sidecar 持久化", sidecarData.data.rerunHistory?.length === 2 && sidecarData.data.rerunHistory?.[1].outcome === "drift");
    check("sidecar 里原 Manifest 与刷新后的执行时间都在", sidecarData.data.manifest?.executedAt === FIXED_NOW.toISOString() && sidecarData.data.manifest?.sql === SQL);
    check("sidecar 里保留漂移旧值/新值", sidecarData.data.rerunHistory?.[1].before.rowCount === 1200 && sidecarData.data.rerunHistory?.[1].after?.rowCount === 1350);

    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().hydrateSession((loaded?.nodes ?? []) as Node[], (loaded?.edges ?? []) as Edge[]);
    const restored = useCanvasStore.getState();
    const restoredData = restored.nodes[0].data as unknown as DataFrameNodeData;
    check("重开会话后记录完整恢复", restoredData.rerunHistory?.length === 2 && restoredData.rerunHistory?.[0].outcome === "identical");
    check("重开会话后临时态被清空", restored.rerunningNodeIds.length === 0 && Object.keys(restored.rerunErrors).length === 0);
    const reDrifted = withRerunRecord(restoredData, driftRecord);
    check("重开会话后再遇漂移仍会告警且不改写原 Manifest", hasDrift(reDrifted) === true && JSON.stringify(reDrifted.manifest) === JSON.stringify(restoredData.manifest));
  } finally {
    useCanvasStore.getState().clearCanvas();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. 真实 CLI 链路（--real）─────────────────────────────────────────────

if (process.argv.includes("--real")) {
  console.log("\n[6] 真实 govio-cli 复跑链路（datasource=sales）");
  const DF = "verify_rerun_base";
  const BASE_SQL = "SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2 AS id, 'b' AS name";
  const cleanup = async () => {
    try { await runGovioCliWithArgs(["observe", "release", "--name", DF], 15_000); } catch { /* 已不存在 */ }
  };
  try {
    await cleanup();
    const baseStdout = await runGovioCliWithArgs(["observe", "load", "--name", DF, "--datasource", "sales", "--sql", BASE_SQL], 60_000);
    const base = parseLoadOutput(baseStdout);
    check("基线 DataFrame 加载成功（2 行 × 2 列）", base !== null && base.rowCount === 2 && base.columnCount === 2, baseStdout.slice(0, 120));

    const realManifest = buildManifest({
      origin: "observe-load",
      sql: BASE_SQL,
      datasource: "sales",
      dfName: DF,
      columns: base?.columns ?? [],
      rowCount: base?.rowCount ?? 0,
      columnCount: base?.columnCount ?? 0,
      context: { sessionId: "sess-verify-real" },
    });
    check("基线 Manifest 带 schema-v1 校验和", realManifest.checksum?.algorithm === "schema-v1");

    const real = await rerunDataFrame(realManifest, { sessionId: "sess-verify-real" });
    check("真实复跑结论 = identical", real.outcome === "identical", JSON.stringify(real));
    check("真实复跑校验和与原 Manifest 一致", real.after?.checksum?.schemaHash === realManifest.checksum?.schemaHash);
    check("真实复跑记录耗时与临时名", typeof real.durationMs === "number" && (real.tempDfName ?? "").startsWith(RERUN_TMP_PREFIX));

    const listAfter = JSON.parse(await runGovioCliWithArgs(["observe", "info", "--df"], 30_000)) as { dataframes: Array<{ name: string }> };
    const names = listAfter.dataframes.map((d) => d.name);
    check("临时 DataFrame 已释放（store 里无残留）", !names.some((n) => n.startsWith(RERUN_TMP_PREFIX)), names.join(","));
    check("原 DataFrame 未被复跑覆盖/删除", names.includes(DF), names.join(","));
    const infoAfter = parseLoadOutput(await runGovioCliWithArgs(["observe", "info", "--name", DF, "--rows", "0"], 30_000));
    check("原 DataFrame 仍是 2 行（复跑是验证动作）", infoAfter?.rowCount === 2, JSON.stringify(infoAfter));

    // 伪造一份「上次交付时只有 1 行」的留痕，验证真实链路上能检出漂移
    const driftedManifest: AnalysisManifest = {
      ...realManifest,
      rowCount: 1,
      columnCount: 2,
      checksum: computeChecksum(BASE_SQL, base?.columns ?? [], 1, 2),
    };
    const drifted = await rerunDataFrame(driftedManifest, { sessionId: "sess-verify-real" });
    check("真实复跑检出漂移（行数 1 → 2）", drifted.outcome === "drift" && drifted.diff?.rowCountDelta === 1, JSON.stringify(drifted.diff));
    check("漂移摘要含旧值 → 新值", (drifted.diff?.summary ?? "").includes("1 → 2"), drifted.diff?.summary);
    check("漂移时原 Manifest 未被改写", drifted.before.rowCount === 1 && drifted.before.checksum?.schemaHash === driftedManifest.checksum?.schemaHash);

    const listFinal = JSON.parse(await runGovioCliWithArgs(["observe", "info", "--df"], 30_000)) as { dataframes: Array<{ name: string }> };
    check("漂移复跑后同样无临时残留", !listFinal.dataframes.some((d) => d.name.startsWith(RERUN_TMP_PREFIX)));
  } catch (err) {
    check("真实 CLI 链路无异常", false, err instanceof Error ? err.message : String(err));
  } finally {
    await cleanup();
  }
} else {
  console.log("\n[6] 真实 CLI 链路：跳过（加 --real 参数执行：npm run verify:rerun -- --real）");
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比");
