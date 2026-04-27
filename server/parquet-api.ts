import { IncomingMessage, ServerResponse } from "http";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const PARQUET_DIR = ".govio/observe/dataframes";

export function handleParquetApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith("/api/preview")) return false;

  const url = new URL(req.url, "http://localhost");
  const dfName = url.searchParams.get("df");
  const rows = parseInt(url.searchParams.get("rows") || "10", 10);

  if (!dfName) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing 'df' query parameter" }));
    return true;
  }

  const parquetPath = join(process.cwd(), PARQUET_DIR, `${dfName}.parquet`);
  if (!existsSync(parquetPath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `DataFrame '${dfName}' not found` }));
    return true;
  }

  const script = [
    "import pandas as pd, json, sys",
    `df = pd.read_parquet(sys.argv[1])`,
    `print(df.head(int(sys.argv[2])).to_json(orient='records', date_format='iso'))`,
  ].join("; ");

  execFile("python3", ["-c", script, parquetPath, String(rows)], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: stderr || err.message }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(stdout.trim());
  });

  return true;
}
