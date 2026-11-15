/**
 * 分享链接与后端 API 基址的构造（X25 BUGFIX）。
 *
 * **两个基址不是一回事，混用就是 404**：
 *
 * - **API 基址**：本仓约定「页面端口 +1」——dev 下前端是 Vite（5173），后端 HTTP/WS 在 5174，
 *   与 `useChat` / `canvas-service` / `canvas-store` / `ShareView` 同款。生产环境若为单端口同源托管
 *   （`govio-map` serve 同时发静态页与 API），页面 origin 没有「+1 端口」可言，此时应退回**同源相对路径**。
 * - **分享链接**：`/share/<token>` 是**前端路由**（`src/main.tsx` 按 pathname 匹配后渲染 `ShareView`），
 *   由托管 SPA 的那一侧提供——dev 是 Vite（5173，SPA fallback 到 index.html），生产是单端口静态托管。
 *   后端 5174 只提供 `/api/*`、`/ws`、`/canvas`、`/api/preview`，**不托管 SPA**，
 *   所以把链接拼成 API 基址必然 `404 {"error":"Not found"}`。
 *
 * 回归来源（2026-11-15 用户实测）：点「生成只读分享链接」后复制到的是
 * `http://localhost:5174/share/<token>` → 404；同一 token 在 5173 上 200。
 * 详见 `docs/tasks/BUGFIX-share-link-port.md`。
 */

/**
 * 后端 API 基址（不含尾斜杠）。
 *
 * 页面 origin 带端口（dev：`http://localhost:5173`）→ 返回端口 +1 的基址（`http://localhost:5174`）；
 * 无端口（生产同源托管、`file:`、或 origin 不可解析）→ 返回 `null`，调用方应改用**同源相对路径**
 * （`fetch("/api/...")`），因为此时 API 与页面同端口。
 */
export function apiBaseFrom(pageOrigin: string): string | null {
  if (typeof pageOrigin !== "string" || pageOrigin.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(pageOrigin.trim());
  } catch {
    return null;
  }
  if (!url.hostname || !url.port) return null;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port)) return null;
  return `${url.protocol}//${url.hostname}:${port + 1}`;
}

/**
 * 分享链接（绝对地址）：`shareLink("/share/<token>", window.location.origin)`。
 *
 * **只接受页面 origin**，不接受 API 基址——这是本模块存在的唯一理由（见文件头）。
 * origin 为空/不可解析时退回相对路径（同源页面里点开仍可用），绝不猜端口。
 */
export function shareLink(path: string, pageOrigin: string): string {
  const raw = typeof path === "string" ? path.trim() : "";
  if (raw === "") return "";
  const normalizedPath = raw.startsWith("/") ? raw : `/${raw}`;
  const origin = typeof pageOrigin === "string" ? pageOrigin.trim().replace(/\/+$/, "") : "";
  if (origin === "") return normalizedPath;
  try {
    return new URL(normalizedPath, origin).href;
  } catch {
    // origin 不可解析（非浏览器环境 / 脏数据）：宁可给相对路径，不给一个肯定打不开的绝对链接。
    return normalizedPath;
  }
}
