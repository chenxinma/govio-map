import { IncomingMessage, ServerResponse } from "http";
import { existsSync } from "fs";
import { resolve as resolvePath, sep } from "path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet/src/types.js";
import { runGovioCli, getLoadedSkills } from "./agent.js";
import { pushGovioNode, emitFlushed, flushGovioNodes } from "./govio-node-queue.js";
import { execFile } from "child_process";
import { corsHeadersFor } from "./security.js";

function runGovioCliWithArgs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("govio-cli", args, { encoding: "utf-8", timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[govio-cli] args=${JSON.stringify(args)} failed:`, stderr || error.message);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

const PARQUET_DIR = ".govio/observe/dataframes";

/** Max accepted POST body size (protects against memory-exhaustion DoS). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** DataFrame names are used as file names and CLI arguments: restrict to safe identifiers. */
const SAFE_DF_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function handleParquetApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // Per-request CORS headers: only local frontend origins are echoed back.
  const CORS_HEADERS = corsHeadersFor(req);

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
    (async () => {
      try {
        const parsed = await readJsonBody(req);
        const { datasource, name, sql } = (parsed ?? {}) as { datasource?: string; name?: string; sql?: string };
        if (!datasource || !name || !sql) {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({ error: "Missing required fields: datasource, name, sql" }));
          return;
        }
        // name is passed to the CLI and later used as a file name: reject anything exotic.
        if (!SAFE_DF_NAME_RE.test(name)) {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({ error: "Invalid DataFrame name: only letters, digits, '_', '-', '.' allowed" }));
          return;
        }

        // 使用数组参数避免SQL中的空格被错误分割
        const loadArgs = datasource === 'memory'
          ? ['observe', 'load', '--memory', '--name', name, '--sql', sql]
          : ['observe', 'load', '--datasource', datasource, '--name', name, '--sql', sql];
        const loadOutput = await runGovioCliWithArgs(loadArgs);
        const loadResult = JSON.parse(loadOutput);

        // 获取 DataFrame 信息（name 已通过 SAFE_DF_NAME_RE 校验，可安全拼接）
        const infoOutput = await runGovioCli(`observe info --name ${name} --rows 0`, true);
        const info = JSON.parse(infoOutput);

        // 创建 canvas 节点
        if (info && info.schema) {
          pushGovioNode({
            nodeType: "dataFrame",
            title: name,
            dfName: name,
            sourceName: datasource,
            totalRows: info.rows || 0,
            totalColumns: info.columns || info.schema.length,
            memoryUsage: "unknown",
            columns: info.schema.map((col: { column: string; dtype: string }) => ({
              name: col.column,
              nonNull: 0,
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
    })();
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
  const requestedRows = parseInt(url.searchParams.get("rows") || "10", 10);
  // Clamp the row limit to a sane range (NaN/negative/huge values -> defaults).
  const rowLimit = Number.isFinite(requestedRows)
    ? Math.min(Math.max(requestedRows, 1), 1000)
    : 10;

  if (!dfName) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "Missing 'df' query parameter" }));
    return true;
  }

  // Reject anything that is not a plain DataFrame name before touching the filesystem.
  if (!SAFE_DF_NAME_RE.test(dfName)) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "Invalid 'df' parameter" }));
    return true;
  }

  const parquetDir = resolvePath(process.cwd(), PARQUET_DIR);
  const parquetPath = resolvePath(parquetDir, `${dfName}.parquet`);
  // Defense in depth: the resolved path must stay inside the DataFrame directory.
  if (!parquetPath.startsWith(parquetDir + sep)) {
    res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ error: "Invalid 'df' parameter" }));
    return true;
  }
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
