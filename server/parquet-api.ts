import { IncomingMessage, ServerResponse } from "http";
import { existsSync } from "fs";
import { join } from "path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet/src/types.js";
import { runGovioCli } from "./agent.js";
import { pushGovioNode, emitFlushed, flushGovioNodes } from "./govio-node-queue.js";

const PARQUET_DIR = ".govio/observe/dataframes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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

        // 构建 observe load 命令：memory 使用 --memory，其他使用 --datasource
        const escapedSql = sql.replace(/"/g, '\\"');
        const loadCmd = datasource === 'memory'
          ? `observe load --memory --name "${name}" --sql "${escapedSql}"`
          : `observe load --datasource "${datasource}" --name "${name}" --sql "${escapedSql}"`;
        const loadOutput = await runGovioCli(loadCmd, true);
        const loadResult = JSON.parse(loadOutput);

        // 获取 DataFrame 信息
        const infoCmd = `observe info --name ${name} --rows 0`;
        const infoOutput = await runGovioCli(infoCmd, true);
        const info = JSON.parse(infoOutput);

        // 创建 canvas 节点
        if (info && info.columns) {
          pushGovioNode({
            nodeType: "dataFrame",
            title: name,
            dfName: name,
            sourceName: datasource,
            totalRows: info.totalRows || 0,
            totalColumns: info.columns.length,
            memoryUsage: info.memoryUsage || "unknown",
            columns: info.columns.map((col: { name: string; nonNull?: number; dtype: string }) => ({
              name: col.name,
              nonNull: col.nonNull || 0,
              dtype: col.dtype,
            })),
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
