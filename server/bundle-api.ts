/**
 * T3.6 session 打包的 HTTP 只读通道：`GET /api/session-bundle`。
 *
 * 挂载在 `backend.ts` 的 createServer（与 `/api/preview`、T3.5 分享 API 同侧）。
 *
 * 为什么是「返回文件集 JSON」而不是「返回 zip 字节」：`report.html` 只有在浏览器里
 * 才能保真生成（图表要借页面里的 Plotly 静态渲染成内联图片），所以 zip 必须由前端组装；
 * 服务端只负责它独占的东西——磁盘上的会话 sidecar。若改成后端产 zip，就得让前端把
 * 几 MB 的 report.html 上传回来（内联 SVG 图表），代价更高。论证见 design.md §3。
 *
 * 安全边界（与 `/api/permission-audit` 同款三条）：
 *  1. **只读**：只调 `collectSessionBundle()`，不写不删不执行命令；
 *  2. **路径白名单**：`?session=` 一律过 `assertValidSessionPath()`（必须是
 *     `<cwd>/.govio/sessions/` 内的 `.jsonl`），越界 → 400，不泄露存在性；
 *  3. **不带凭据**：`.storage.json` 本体不入包，只回 profile 引用名（见 session-bundle.ts）。
 *
 * CORS：只用 GET（CORS 安全方法）、不要自定义请求头 ⇒ 无需预检，也**无需**改
 * `security.ts` 的白名单（T3.5 为 DELETE/If-None-Match 改过一次，这里刻意不重演）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSession } from "./agent.js";
import { corsHeadersFor } from "./security.js";
import { assertValidSessionPath } from "./session-history.js";
import {
  BundleSessionNotFoundError,
  BundleTooLargeError,
  collectSessionBundle,
} from "./session-bundle.js";

/** 服务端当前活动会话文件（与 share-api.ts 的同名 helper 一致：来自 pi AgentSession 单例）。 */
function activeSessionFile(): string | null {
  const session = getSession();
  return session?.sessionManager.getSessionFile() ?? null;
}

export async function handleBundleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const CORS_HEADERS = corsHeadersFor(req);
  const send = (status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void => {
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders, ...CORS_HEADERS });
    res.end(JSON.stringify(payload));
  };

  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    return false;
  }
  if (url.pathname !== "/api/session-bundle") return false;

  if (req.method !== "GET") {
    send(405, { error: "method not allowed" });
    return true;
  }

  // `?session=<path>`：导出指定会话（前端 /export 用当前会话，指定会话能力留给历史会话导出）；
  // 无参数则取服务端会话单例。两种来源都必须过同一道白名单校验。
  const sessionParam = url.searchParams.get("session");
  let sessionFile: string | null;
  if (sessionParam) {
    try {
      sessionFile = assertValidSessionPath(sessionParam);
    } catch {
      send(400, { error: "invalid-session-path" });
      return true;
    }
  } else {
    sessionFile = activeSessionFile();
    if (!sessionFile) {
      send(409, { error: "session bundle requires an active session" });
      return true;
    }
  }

  try {
    const payload = collectSessionBundle(sessionFile);
    // 会话内容是敏感数据，绝不进任何中间缓存。
    send(200, payload, { "Cache-Control": "no-store" });
  } catch (err) {
    if (err instanceof BundleSessionNotFoundError) {
      send(404, { error: "session-not-found" });
      return true;
    }
    if (err instanceof BundleTooLargeError) {
      send(413, {
        error: "bundle-too-large",
        bytes: err.bytes,
        limitBytes: err.limitBytes,
        path: err.path,
      });
      return true;
    }
    send(500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
