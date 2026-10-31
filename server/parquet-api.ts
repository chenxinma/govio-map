import { IncomingMessage, ServerResponse } from "http";
import { existsSync } from "fs";
import { join } from "path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet/src/types.js";
import { runGovioCli, getLoadedSkills, getSession } from "./agent.js";
import { pushGovioNode, emitFlushed, flushGovioNodes } from "./govio-node-queue.js";
import { agentSessionContext, buildManifest } from "./analysis-manifest.js";
import { rerunDataFrame } from "./dataframe-rerun.js";
import { runGovioCliWithArgs } from "./govio-cli-exec.js";
import { readPermissionAudit } from "./permission-audit.js";
import { loadCanvas } from "./session-history.js";
import type { AnalysisManifest } from "../src/types/manifest.js";

const PARQUET_DIR = ".govio/observe/dataframes";

/** 审计只读通道一次最多接受多少个 decisionId（附录 B 只需要画布节点引用的那些） */
const MAX_AUDIT_DECISION_IDS = 500;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * 从当前会话的 canvas sidecar（`<session-file>.canvas.json`）里取节点固化的 Manifest。
 *
 * 复跑的 SQL 不接受 HTTP 请求体传入：否则「一键复跑」会退化成「重跑前端当前
 * 输入」，失去可复现验证的意义。注意这是可复现性约束而非安全边界：sidecar 本身
 * 是本机会话文件（由前端 `canvas_save` 写入），防篡改属 X1 安全基线范围。
 * sidecar 在节点变更后 1s 内写入，所以刚建好的节点也能读到。
 */
function readManifestFromCanvas(nodeId: string): AnalysisManifest | null {
  try {
    const file = getSession()?.sessionManager.getSessionFile();
    if (!file) return null;
    const canvas = loadCanvas(file);
    const node = (canvas?.nodes ?? []).find(
      (n) => (n as { id?: unknown }).id === nodeId,
    ) as { data?: { manifest?: AnalysisManifest } } | undefined;
    return node?.data?.manifest ?? null;
  } catch (err) {
    console.warn(`[rerun] 读取 canvas sidecar 失败（nodeId=${nodeId}）:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function handleParquetApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // 处理 CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  // GET /api/sql-editor-init - 获取数据源和DataFrame列表
  if (req.url?.startsWith("/api/sql-editor-init") && req.method === "GET") {
    try {
      const [datasourcesOutput, dataframesOutput] = await Promise.all([
        runGovioCli("observe info --datasource", true),
        runGovioCli("observe info --df", true),
      ]);
      const datasources = JSON.parse(datasourcesOutput);
      const dataframesRaw = JSON.parse(dataframesOutput);
      // 提取DataFrame名称列表
      const dataframes = dataframesRaw.dataframes?.map((df: { name: string }) => df.name) || [];
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ datasources, dataframes }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  // GET /api/skills - pi 已加载的 skill 列表
  if (req.url?.startsWith("/api/skills") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ skills: getLoadedSkills() }));
    return true;
  }

  // POST /api/execute-sql - 执行SQL并加载为DataFrame
  if (req.url?.startsWith("/api/execute-sql") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { datasource, name, sql } = JSON.parse(body);
        if (!datasource || !name || !sql) {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({ error: "Missing required fields: datasource, name, sql" }));
          return;
        }

        // 使用数组参数避免SQL中的空格被错误分割
        const loadArgs = datasource === 'memory'
          ? ['observe', 'load', '--memory', '--name', name, '--sql', sql]
          : ['observe', 'load', '--datasource', datasource, '--name', name, '--sql', sql];
        const loadOutput = await runGovioCliWithArgs(loadArgs);
        const loadResult = JSON.parse(loadOutput);

        // 获取 DataFrame 信息
        const infoOutput = await runGovioCli(`observe info --name ${name} --rows 0`, true);
        const info = JSON.parse(infoOutput);

        // 创建 canvas 节点
        if (info && info.schema) {
          const columns = info.schema.map((col: { column: string; dtype: string }) => ({
            name: col.column,
            nonNull: 0,
            dtype: col.dtype,
          }));
          const rowCount = info.rows || 0;
          const columnCount = info.columns || info.schema.length;
          pushGovioNode({
            nodeType: "dataFrame",
            title: name,
            dfName: name,
            sourceName: datasource,
            totalRows: rowCount,
            totalColumns: columnCount,
            memoryUsage: "unknown",
            columns,
            // SQL 编辑器人工执行：SQL 与数据源由前端原文传入，无生成模型。
            manifest: buildManifest({
              origin: "sql-editor",
              sql,
              datasource,
              dfName: name,
              columns: columns.map((c: { name: string; dtype: string }) => ({ name: c.name, dtype: c.dtype })),
              rowCount,
              columnCount,
              context: agentSessionContext(getSession()),
            }),
          });
          const events = flushGovioNodes();
          emitFlushed(events);
        }

        res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ success: true, result: loadResult }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ error: message }));
      }
    });
    return true;
  }

  // POST /api/rerun-dataframe - 按 Manifest 固化的 SQL 复跑 DataFrame 并对比漂移（Phase 1 KR2）
  if (req.url?.startsWith("/api/rerun-dataframe") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify(payload));
      };
      try {
        const { nodeId } = JSON.parse(body || "{}") as { nodeId?: unknown };
        if (typeof nodeId !== "string" || !nodeId) {
          send(400, { error: "Missing required field: nodeId" });
          return;
        }
        const manifest = readManifestFromCanvas(nodeId);
        if (!manifest) {
          send(409, {
            error: `当前会话画布里找不到节点 ${nodeId} 的分析留痕（Manifest），无法复跑；请确认画布已保存或重开该会话`,
          });
          return;
        }
        // 复跑失败 / 不可复跑也返回记录（outcome='error'），前端追加到 rerunHistory 留痕。
        const record = await rerunDataFrame(manifest, { sessionId: getSession()?.sessionId ?? "" });
        send(200, { record });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  // GET /api/permission-audit - 只读返回当前会话的权限确认记录（T1.4 交付报告附录 B）
  //
  // 安全边界（三条）：
  //  1. **只读**：只调 readPermissionAudit()，不写、不删、不执行任何命令，也不读数据内容
  //     （审计记录里本来就只有命令原文与决策，见 T1.3 的记录模型）
  //  2. **只限当前会话**：sessionFile 取自服务端会话单例，不接受请求传路径，
  //     因此没有目录穿越或越权读其他会话的可能
  //  3. **只过滤不加工**：decisionIds 必填（缺失/空 → 400），只用来挑选返回哪些条目；
  //     不提供「缺省全量返回当前会话命令历史」的能力，超限时显式标记 truncated
  if (req.url?.startsWith("/api/permission-audit") && req.method === "GET") {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify(payload));
    };
    try {
      const session = getSession();
      const sessionFile = session?.sessionManager.getSessionFile();
      if (!sessionFile) {
        send(409, { error: "当前没有已落盘的会话，读不到权限审计 sidecar", entries: [] });
        return true;
      }
      const url = new URL(req.url, "http://localhost");
      const rawIds = (url.searchParams.get("decisionIds") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (rawIds.length === 0) {
        send(400, { error: "Missing required parameter: decisionIds", entries: [] });
        return true;
      }
      const ids = rawIds.slice(0, MAX_AUDIT_DECISION_IDS);
      const truncated = rawIds.length > ids.length;
      const all = readPermissionAudit(sessionFile);
      const wanted = new Set(ids);
      const entries = all.filter((e) => wanted.has(e.decisionId));
      send(200, {
        sessionId: session?.sessionId ?? "",
        sessionFile,
        total: all.length,
        // 实际请求的 ID 数（截断前）；发生截断时 truncated=true，消费方必须如实告知
        requested: rawIds.length,
        ...(truncated ? { truncated: true } : {}),
        entries,
      });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err), entries: [] });
    }
    return true;
  }

  if (!req.url?.startsWith("/api/preview")) return false;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  const url = new URL(req.url, "http://localhost");
  const dfName = url.searchParams.get("df");
  const rowLimit = parseInt(url.searchParams.get("rows") || "10", 10);

  if (!dfName) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "Missing 'df' query parameter" }));
    return true;
  }

  const parquetPath = join(process.cwd(), PARQUET_DIR, `${dfName}.parquet`);
  if (!existsSync(parquetPath)) {
    res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: `DataFrame '${dfName}' not found` }));
    return true;
  }

  // console.log("Read data: " + parquetPath);
  let responded = false;
  try {
    const file: AsyncBuffer = await asyncBufferFromFile(parquetPath)
    const data = await parquetReadObjects({
      file: file,
      rowFormat: 'object',
      rowEnd: rowLimit,
    });
    
    const jsonString = JSON.stringify(data, (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value === 'object' && value !== null && value.constructor !== Object && !Array.isArray(value)) {
        return `[${value.constructor.name}]`; 
      }
      return value;
    });
    const contentLength = Buffer.byteLength(jsonString, 'utf-8'); 
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": contentLength,
       ...CORS_HEADERS });
    responded = true;
    res.end(jsonString);
  } catch (err) {
    if (!responded) {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
      const errorMessage = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error: 'Internal Server Error', message: errorMessage }));
    }
  }

  return true;
}
