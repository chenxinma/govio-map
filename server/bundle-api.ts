/**
 * T3.6/T3.7 session 打包的 HTTP 通道：导出取文件集 + 导入落历史会话。
 *
 * 挂载在 `backend.ts` 的 createServer（与 `/api/preview`、T3.5 分享 API 同侧）：
 *  - `GET  /api/session-bundle`（T3.6）→ 服务端独占的会话文件集（含权威 sha256），zip 由前端组装
 *  - `POST /api/session-import`（T3.7）→ 按路径导入一个包，落地为 `.govio/sessions/` 里的历史会话
 *
 * 为什么导出是「返回文件集 JSON」而不是「返回 zip 字节」：`report.html` 只有在浏览器里
 * 才能保真生成（图表要借页面里的 Plotly 静态渲染成内联图片），所以 zip 必须由前端组装；
 * 服务端只负责它独占的东西——磁盘上的会话 sidecar。若改成后端产 zip，就得让前端把
 * 几 MB 的 report.html 上传回来（内联 SVG 图表），代价更高。论证见 T3.6 design.md §3。
 *
 * 为什么导入反过来是「前端给路径、服务端读文件」：浏览器读不到任意本地路径（安全模型），
 * 而包可能几百 KB～几十 MB，走 HTTP 上传既慢又要放开 body 上限；后端本就与页面同机
 * （只绑 loopback），直接按路径读是最短路径。用户裁决 ⑤：读侧路径可任意，**写侧严格限定
 * `.govio/sessions/`**，两侧校验都在 `server/session-import.ts`。
 *
 * 安全边界：
 *  1. 导出**只读**：只调 `collectSessionBundle()`，不写不删不执行命令；`?session=` 一律过
 *     `assertValidSessionPath()`（必须是 `<cwd>/.govio/sessions/` 内的 `.jsonl`），越界 → 400；
 *  2. 导入**只写 sessions 目录**：目标文件名由本机生成，包内路径不参与拼接落盘路径；
 *     校验（格式版本 / 清单 / 逐文件 sha256 / 清单外条目）全绿前零写入（decisions ④）；
 *  3. 不带凭据：`.storage.json` 本体不入包也不落地，只透传 profile 引用名；
 *  4. 错误响应只回**错误码 + 人话文案**，绝不回包内文件内容（会话内容是敏感数据）。
 *
 * CORS：导出只用 GET（CORS 安全方法）⇒ 无需预检；导入是 `POST` + `Content-Type:
 * application/json`，dev 下页面(5173) → API(5174) 跨源会触发预检 —— 预检由 `backend.ts` 的
 * `handleBackendRequest` 在所有 `handle*Api` 之前统一应答（X26：单一来源，不再逐模块自带
 * `OPTIONS` 分支）。`security.ts` 的白名单已含 POST 与 Content-Type（T3.5 起），**无需再改**。
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
import { BundleImportError, importSessionBundle } from "./session-import.js";
import type { ImportErrorCode } from "../src/types/bundle.js";

/** 导入请求体上限：只装一个路径，8KB 已绰绰有余（超限直接 413，不缓冲大包体）。 */
const MAX_IMPORT_BODY_BYTES = 8 * 1024;

/** 服务端当前活动会话文件（与 share-api.ts 的同名 helper 一致：来自 pi AgentSession 单例）。 */
function activeSessionFile(): string | null {
  const session = getSession();
  return session?.sessionManager.getSessionFile() ?? null;
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** 导入错误码 → HTTP 状态（错误码表见 `docs/specs/06-backend.md`）。 */
export function importStatusFor(code: ImportErrorCode): number {
  switch (code) {
    case "invalid-path":
    case "not-a-file":
      return 400;
    case "bundle-not-found":
      return 404;
    case "target-conflict":
      return 409;
    case "bundle-too-large":
    case "too-many-files":
    case "uncompressed-too-large":
      return 413;
    case "write-failed":
      return 500;
    default:
      // 包内容层面的问题（不是合法 zip / 清单不符 / 校验和不符 / 夹带条目 / transcript 非法）：
      // 请求本身没毛病，是**载荷**不可处理 ⇒ 422。
      return 422;
  }
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

  if (url.pathname === "/api/session-bundle") {
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

  if (url.pathname === "/api/session-import") {
    // X26：跨源预检（POST + application/json 不是 CORS 简单请求，dev 5173→5174 下必先预检）
    // 统一由 backend.ts 的 handleBackendRequest 在所有 handle*Api 之前应答。本模块原先自带的
    // OPTIONS 分支在真实服务器上**不可达**（parquet-api 的全局分支先返回 true），属死代码，已删除。
    if (req.method !== "POST") {
      send(405, { error: "method not allowed" });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES);
    } catch (err) {
      const tooLarge = /too large/i.test(err instanceof Error ? err.message : String(err));
      send(tooLarge ? 413 : 400, { error: tooLarge ? "request-too-large" : "invalid-json-body" });
      return true;
    }
    const path = (body as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path.trim() === "") {
      send(400, { error: "invalid-request", message: "缺少 path 字段：用法 /import <bundle 路径>" });
      return true;
    }

    try {
      const result = importSessionBundle(path);
      send(200, { ok: true, ...result }, { "Cache-Control": "no-store" });
    } catch (err) {
      if (err instanceof BundleImportError) {
        send(importStatusFor(err.code), {
          error: err.code,
          message: err.message,
          ...(err.detail ? { detail: err.detail } : {}),
        });
        return true;
      }
      send(500, { error: "import-failed", message: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
