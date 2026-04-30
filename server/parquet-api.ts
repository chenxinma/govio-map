import { IncomingMessage, ServerResponse } from "http";
import { existsSync } from "fs";
import { join } from "path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet/src/types.js";

const PARQUET_DIR = ".govio/observe/dataframes";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function handleParquetApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

  console.log("Read data: " + parquetPath);
  let responsed = false;
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
    responsed = true;
    res.end(jsonString);
  } catch (err) {
    if (!responsed) {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
      const errorMessage = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({ error: 'Internal Server Error', message: errorMessage }));
    }
  }

  return true;
}
