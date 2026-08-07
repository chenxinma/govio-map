import { app, BrowserWindow } from "electron";
import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join, extname, normalize } from "path";
import { inspect } from "util";
import dotenv from "dotenv";
import { startBackend } from "../server/backend.js";

// --- File logging: mirror console + process errors to govio.log ---
// Wired up as early as possible so backend logs (which use console.log)
// are captured even when the exe is launched without a terminal.
function setupFileLogging(logDir: string) {
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* directory may already exist */
  }
  const logPath = join(logDir, "govio.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  stream.on("error", () => {
    // Prevent unhandled 'error' events from crashing the app when the
    // log directory becomes unavailable (disk full, permissions changed).
  });

  const stamp = () => new Date().toISOString();
  const fmt = (args: unknown[]) =>
    args
      .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 6 })))
      .join(" ");

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    stream.write(`[${stamp()}] [log] ${fmt(args)}\n`);
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    stream.write(`[${stamp()}] [error] ${fmt(args)}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    stream.write(`[${stamp()}] [warn] ${fmt(args)}\n`);
  };

  process.on("uncaughtException", (err) => {
    stream.write(`[${stamp()}] [uncaughtException] ${err.stack || String(err)}\n`);
    // After an uncaught exception the process is in undefined behaviour
    // territory.  Log the error for post-mortem analysis and exit cleanly
    // so Electron can restart the app.
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    stream.write(`[${stamp()}] [unhandledRejection] ${inspect(reason)}\n`);
  });

  stream.write(`\n========== ${stamp()} app start ==========\n`);
  origLog(`[log] file logging to ${logPath}`);
}

// app.getPath("userData") is safe to call before the ready event.
try {
  setupFileLogging(app.getPath("userData"));
} catch (err) {
  console.error("[log] file logging unavailable:", err);
}

const STATIC_PORT = 5173;
const BACKEND_PORT = 5174;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function startStaticServer(root: string) {
  const normalizedRoot = normalize(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";

      const filePath = normalize(join(root, pathname));
      // Path traversal guard
      if (!filePath.startsWith(normalizedRoot)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const exists = existsSync(filePath);
      const isDir = exists && (await stat(filePath)).isDirectory();
      if (!exists || isDir) {
        // SPA fallback
        const data = await readFile(join(root, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
        return;
      }

      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  server.listen(STATIC_PORT, () => {
    console.log(`[static] serving dist on port ${STATIC_PORT}`);
  });
  return server;
}

let mainWindow: BrowserWindow | null = null;

async function bootstrap() {
  // Work directory: userData holds .env, .govio/, skills, .pi, etc.
  const workDir = app.getPath("userData");
  process.chdir(workDir);
  dotenv.config({ path: join(workDir, ".env") });

  // Serve the built frontend (bundled under <appPath>/dist)
  startStaticServer(join(app.getAppPath(), "dist"));

  // Start the backend (HTTP API + WebSocket) on port 5174.
  // Frontend derives the WS port as window.location.port + 1 = 5174.
  await startBackend(BACKEND_PORT);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: true },
  });
  mainWindow.loadURL(`http://localhost:${STATIC_PORT}`);
}

app.whenReady().then(bootstrap).catch((err) => {
  console.error("[main] bootstrap failed:", err);
});

app.on("window-all-closed", () => {
  app.quit();
});
