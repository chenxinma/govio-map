/**
 * Shared security helpers for the backend HTTP/WS server.
 *
 * The backend is a local-only service that can drive an AI agent with shell
 * access. Without origin checks, any website the user visits could connect to
 * ws://localhost:5174 (cross-site WebSocket hijacking) and execute arbitrary
 * commands or read API keys. These helpers enforce:
 *  - loopback-only network binding (see backend.ts / electron/main.ts)
 *  - an Origin allowlist for WebSocket upgrades and CORS responses
 */

/** Loopback interface the backend binds to. Never expose the agent on the LAN. */
export const LOOPBACK_HOST = "127.0.0.1";

const ALLOWED_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** True when the Origin header value belongs to the local frontend (dev server or Electron static server). */
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    return { "Access-Control-Allow-Origin": origin as string, ...base };
  }
  return base;
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
