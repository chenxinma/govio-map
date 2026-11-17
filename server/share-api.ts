/**
 * T3.5 只读分享「活视图」HTTP API（挂载在 backend.ts 的 createServer，与 /api/preview 同侧）。
 *
 * 路由：
 *  - GET    /api/share-state            → 当前会话的分享开关状态 `{enabled, token}`（无活动会话 409）
 *  - POST   /api/shares                 → **开启**当前会话分享（幂等：重复调用返回同一 token）
 *  - DELETE /api/shares                 → **撤销**当前会话分享（幂等：删除开关 sidecar，链接立即失效）
 *  - GET    /api/shares/<token>         → 当前画布**活视图**载荷（不再写快照文件）；带 ETag，
 *                                         `If-None-Match` 命中回 304；token 未开启/不存在 → 404
 *  - POST   /api/shares/<token>/fork    → fork 出可写副本（从当前活画布暂存 forkId，供主界面
 *                                         canvas_fork_apply 应用，不回写源画布）
 *  - GET/POST /api/canvas-storage       → 逐画布 S3 绑定查询/配置（T3.1；不属本 API 的变更范围）
 *
 * T3.5 删除：`POST /api/shares/<token>/rerun`（只读页复跑）。活视图语义下「动手」一律走 fork，
 * 且复跑会对服务端当前会话产生执行副作用，与只读纪律冲突（用户裁决 ⑥）。
 *
 * 只读纪律：以上路由不存在任何写源画布 sidecar 的路径；写只发生在分享开关 sidecar
 * （`<session>.jsonl.share.json`，仅 `{version,enabled,enabledAt,token}`）与暂存 fork 的创建。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSession } from "./agent.js";
import { corsHeadersFor } from "./security.js";
import { SHARE_NOT_FOUND_ERROR, type LiveSharePayload } from "../src/types/share.js";
import { assertValidShareId } from "./storage/backend.js";
import {
  bindCanvasStorage,
  clearStorageBinding,
  readStorageBinding,
  syncCanvasToRemote,
  type SyncResult,
} from "./storage/canvas-storage.js";
import {
  disableShare,
  enableShare,
  forkShare,
  ifNoneMatchHits,
  liveShareView,
  shareStateOf,
} from "./share.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

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
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function activeSessionFile(): string | null {
  const session = getSession();
  return session?.sessionManager.getSessionFile() ?? null;
}

/** token 未开启/不存在/形状非法一律同一个 404，不区分「没有这个会话」与「分享已关闭」（不泄露存在性）。 */
const SHARE_NOT_FOUND = { error: SHARE_NOT_FOUND_ERROR };

export async function handleShareApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const CORS_HEADERS = corsHeadersFor(req);
  const send = (status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(payload));
  };

  if (req.url === "/api/share-state" && req.method === "GET") {
    const file = activeSessionFile();
    if (!file) {
      send(409, { error: "share state requires an active session" });
      return true;
    }
    const state = shareStateOf(file);
    send(200, { enabled: state.enabled, token: state.token, enabledAt: state.enabledAt });
    return true;
  }

  if (req.url === "/api/shares" && req.method === "POST") {
    try {
      const file = activeSessionFile();
      if (!file) {
        send(409, { error: "share requires an active session" });
        return true;
      }
      const state = enableShare(file);
      send(200, {
        enabled: true,
        token: state.token,
        enabledAt: state.enabledAt,
        url: `/share/${state.token}`,
      });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.url === "/api/shares" && req.method === "DELETE") {
    try {
      const file = activeSessionFile();
      if (!file) {
        send(409, { error: "share requires an active session" });
        return true;
      }
      const state = disableShare(file);
      send(200, { enabled: false, token: state.token });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const shareMatch = /^\/api\/shares\/([A-Za-z0-9]+)(\/fork)?$/.exec(req.url ?? "");
  if (shareMatch) {
    const token = shareMatch[1];
    const action = shareMatch[2];
    try {
      assertValidShareId(token);
    } catch {
      send(404, SHARE_NOT_FOUND);
      return true;
    }
    if (req.method === "GET" && !action) {
      try {
        const view = liveShareView(token);
        if (!view) {
          send(404, SHARE_NOT_FOUND);
          return true;
        }
        const etag = `"${view.etag}"`;
        // 活视图绝不进浏览器 HTTP 缓存（否则轮询会拿到陈旧副本）；304 由 If-None-Match 显式协商。
        const headers = { ETag: etag, "Cache-Control": "no-store", ...CORS_HEADERS };
        if (ifNoneMatchHits(req.headers["if-none-match"], view.etag)) {
          res.writeHead(304, headers);
          res.end();
          return true;
        }
        res.writeHead(200, { "Content-Type": "application/json", ...headers });
        // etag 同时进 body：跨源时读响应头需要 Access-Control-Expose-Headers，
        // body 里的值前端无条件可读，作为下一次 If-None-Match 的来源更稳。
        const payload: LiveSharePayload = { readonly: true, etag: view.etag, ...view.record };
        res.end(JSON.stringify(payload));
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "POST" && action === "/fork") {
      try {
        const result = forkShare(token);
        if (!result) {
          send(404, SHARE_NOT_FOUND);
          return true;
        }
        send(201, { forkId: result.forkId, shareId: result.shareId, forkFrom: result.forkFrom });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    send(405, { error: "method not allowed" });
    return true;
  }

  if (req.url === "/api/canvas-storage" && req.method === "GET") {
    const file = activeSessionFile();
    const binding = file ? readStorageBinding(file) : null;
    send(200, {
      sessionActive: Boolean(file),
      binding: binding ? { backend: binding.backend, profile: binding.profile, canvasId: binding.canvasId } : null,
    });
    return true;
  }

  if (req.url === "/api/canvas-storage" && req.method === "POST") {
    (async () => {
      try {
        const file = activeSessionFile();
        if (!file) {
          send(409, { error: "canvas storage requires an active session" });
          return true;
        }
        const parsed = await readJsonBody(req);
        const body = (parsed ?? {}) as { profile?: unknown; canvasId?: unknown; clear?: unknown };
        if (body.clear === true) {
          clearStorageBinding(file);
          send(200, { binding: null });
          return;
        }
        if (typeof body.profile !== "string" || !body.profile) {
          send(400, { error: "Missing required field: profile" });
          return;
        }
        const binding = bindCanvasStorage(file, {
          profile: body.profile,
          canvasId: typeof body.canvasId === "string" ? body.canvasId : undefined,
        });
        const sync = await syncCanvasToRemote(file).catch((err): SyncResult => ({ synced: false, error: err instanceof Error ? err.message : String(err) }));
        send(200, {
          binding: { backend: binding.backend, profile: binding.profile, canvasId: binding.canvasId },
          sync,
        });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
}
