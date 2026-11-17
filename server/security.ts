/**
 * Shared security helpers for the backend HTTP/WS server.
 *
 * The backend is a local-only service that can drive an AI agent with shell
 * access. Without origin checks, any website the user visits could connect to
 * ws://localhost:5174 (cross-site WebSocket hijacking) and execute arbitrary
 * commands or read API keys. These helpers enforce:
 *  - loopback-only network binding (see backend.ts / serve.ts)
 *  - an Origin allowlist for WebSocket upgrades and CORS responses
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Loopback interface the backend binds to. Never expose the agent on the LAN. */
export const LOOPBACK_HOST = "127.0.0.1";

const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** True when the Origin header value belongs to the local frontend (dev server or serve.ts static server). */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGIN_RE.test(origin);
}

/**
 * CORS headers for a request: echo the Origin only when it is on the local
 * allowlist. Requests without an Origin (curl, same-origin fetch in some
 * browsers, native apps) get no CORS headers — they don't need them.
 */
export function corsHeadersFor(req: { headers: { origin?: string } }): Record<string, string> {
  const base: Record<string, string> = {
    // DELETE 供 T3.5「撤销分享」（DELETE /api/shares）；两者均不是 CORS 安全方法，需进白名单。
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // If-None-Match 供 T3.5 活视图轮询的条件请求（→ 304），同样不是安全请求头。
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    // 允许跳源页面（dev：5173 → 5174）的 JS 读到活视图的 ETag 响应头。
    "Access-Control-Expose-Headers": "ETag",
    Vary: "Origin",
  };
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    return { "Access-Control-Allow-Origin": origin as string, ...base };
  }
  return base;
}

/**
 * True when the request is a CORS preflight for one of our HTTP API endpoints (X26).
 *
 * Scoped to `/api/*` on purpose: `/ws` and `/canvas` are WebSocket upgrades (browsers never
 * preflight those), and every other path has no cross-origin consumer — answering 204 there
 * would only mask the 404 the fallback handler is supposed to return.
 */
export function isCorsPreflight(req: { method?: string; url?: string }): boolean {
  if (req.method !== "OPTIONS") return false;
  // Preflight requests carry no query/fragment in practice; strip anyway so the
  // check stays a pure path-prefix test.
  const path = (req.url ?? "").split(/[?#]/)[0];
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Answer a CORS preflight with `204` + the same CORS headers real responses carry.
 * Returns true when it responded, so the caller must stop right there.
 *
 * **Single source of truth for preflight (X26).** Preflight used to be answered by the first
 * `OPTIONS` branch inside `parquet-api.ts`, which sat *before* any path check and therefore
 * answered every preflight on the server. Consequence: whether "revoke share"
 * (`DELETE /api/shares`, T3.5) and "import bundle" (`POST /api/session-import` +
 * `application/json`, T3.7) worked at all depended on an unrelated module's catch-all branch
 * and on the mount order in `backend.ts` — reordering handlers, or narrowing that branch to
 * its own routes, would silently break both. `bundle-api.ts` also carried its own `OPTIONS`
 * branch, which was unreachable dead code (parquet-api answered first) while its isolated test
 * kept passing. Per-module preflight branches are gone; `handleBackendRequest` in `backend.ts`
 * calls this before any `handle*Api`.
 */
export function respondToCorsPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isCorsPreflight(req)) return false;
  res.writeHead(204, corsHeadersFor(req));
  res.end();
  return true;
}

/**
 * Validate an untrusted Origin header on a WebSocket upgrade request.
 * Browsers always send Origin when opening a WebSocket; a present but
 * non-allowlisted Origin means a cross-site page is trying to hijack the
 * agent. A missing Origin indicates a non-browser local client (allowed,
 * since the server only binds to loopback).
 */
export function isAllowedUpgrade(req: { headers: { origin?: string } }): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return isAllowedOrigin(origin);
}
