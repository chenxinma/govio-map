/**
 * Standalone launcher: serves the built frontend (dist/) and the backend
 * (HTTP API + WebSocket) on two loopback ports. Entry point for
 * `npx govio-map` / `npm run serve` (bundled to dist-server/cli.mjs).
 *
 * The frontend derives the backend port as `location.port + 1`, so the two
 * ports must stay adjacent: static 5173 -> backend 5174 (same as dev).
 */
import { createServer } from "http";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, extname, normalize, sep, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { startBackend } from "./backend.js";

const STATIC_PORT = 5173;
const BACKEND_PORT = STATIC_PORT + 1;

// Package root: works both from source (server/) and bundled (dist-server/).
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(PKG_ROOT, "dist");

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
      // Path traversal guard: must stay strictly inside root (compare with the
      // trailing separator so sibling dirs like "dist-server" cannot match "dist").
      if (filePath !== normalizedRoot && !filePath.startsWith(normalizedRoot + sep)) {
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
  // Bind to loopback only: the static server and backend must not be exposed on the LAN.
  server.listen(STATIC_PORT, "127.0.0.1", () => {
    console.log(`[static] serving ${DIST_DIR} on 127.0.0.1:${STATIC_PORT}`);
  });
  return server;
}

async function main() {
  if (!existsSync(join(DIST_DIR, "index.html"))) {
    console.error(`[serve] ${DIST_DIR} 缺少前端构建产物，请先运行 npm run build`);
    process.exit(1);
  }

  // Working directory holds .env, .govio/, skills, .pi, etc.
  dotenv.config({ path: join(process.cwd(), ".env") });

  startStaticServer(DIST_DIR);
  await startBackend(BACKEND_PORT);
  console.log(`[serve] Govio Map ready at http://localhost:${STATIC_PORT}`);
}

main().catch((err) => {
  console.error("[serve] bootstrap failed:", err);
  process.exit(1);
});
