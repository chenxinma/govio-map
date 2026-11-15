/**
 * T3.2 分享 HTTP API（挂载在 backend.ts 的 createServer，与 /api/preview 同侧）。
 *
 * 路由：
 *  - POST /api/shares                  → 分享当前活动会话画布（生成快照 + 令牌）
 *  - GET  /api/shares/<token>          → 只读打开分享（含 Manifest 清单与派生血缘；
 *                                        永远不含 profile/凭据）
 *  - POST /api/shares/<token>/fork     → fork 出可写副本（暂存 forkId，供主界面
 *                                        canvas_fork_apply 应用，不回写源画布）
 *  - POST /api/shares/<token>/rerun    → 只读态复跑（T1.2 语义，按快照 Manifest 固化
 *                                        SQL 重跑并判漂移；结果只进响应，不写任何画布）
 *  - GET/POST /api/canvas-storage      → 逐画布 S3 绑定查询/配置（T3.1；响应只含
 *                                        profile 名与 canvasId，不含凭据）
 *
 * 只读纪律：以上路由不存在任何写源画布 sidecar 的路径；写只发生在
 * 分享记录/暂存 fork 的创建与绑定配置（服务端自有文件，且不含凭据）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getSession } from "./agent.js";
import { rerunDataFrame } from "./dataframe-rerun.js";
import { corsHeadersFor } from "./security.js";
import { canvasIdFromSessionFile, assertValidShareId } from "./storage/backend.js";
import {
  bindCanvasStorage,
  clearStorageBinding,
  readStorageBinding,
  syncCanvasToRemote,
  type SyncResult,
} from "./storage/canvas-storage.js";
import {
  createShare,
  forkShare,
  resolveShare,
  shareViewPayload,
  type ShareRecord,
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

export async function handleShareApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const CORS_HEADERS = corsHeadersFor(req);
  const send = (status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(payload));
  };

  if (req.method === "POST" && req.url === "/api/shares") {
    try {
      const file = activeSessionFile();
      if (!file) {
        send(409, { error: "share requires an active session" });
        return true;
      }
      const record = await createShare(file, canvasIdFromSessionFile(file));
      send(201, { shareId: record.shareId, url: `/share/${record.shareId}`, createdAt: record.createdAt });
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const shareMatch = /^\/api\/shares\/([A-Za-z0-9]+)(\/(fork|rerun))?$/.exec(req.url ?? "");
  if (shareMatch) {
    const token = shareMatch[1];
    const action = shareMatch[3];
    try {
      assertValidShareId(token);
    } catch {
      send(404, { error: "share not found" });
      return true;
    }
    if (req.method === "GET" && !action) {
      try {
        const record = await resolveShare(token);
        if (!record) {
          send(404, { error: "share not found" });
          return true;
        }
        send(200, { readonly: true, ...shareViewPayload(record) });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "POST" && action === "fork") {
      try {
        const result = await forkShare(token);
        if (!result) {
          send(404, { error: "share not found" });
          return true;
        }
        send(201, { forkId: result.forkId, shareId: result.shareId, forkFrom: result.forkFrom });
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "POST" && action === "rerun") {
      (async () => {
        try {
          const parsed = await readJsonBody(req);
          const nodeId = (parsed as { nodeId?: unknown })?.nodeId;
          if (typeof nodeId !== "string" || !nodeId) {
            send(400, { error: "Missing required field: nodeId" });
            return;
          }
          const record = await resolveShare(token);
          const entry = record?.manifests.find((m) => m.nodeId === nodeId);
          if (!entry) {
            send(409, { error: `分享快照中找不到节点 ${nodeId} 的分析留痕（Manifest），无法复跑` });
            return;
          }
          // 只读复跑：结果只进响应（前端在分享视图本地追加新副本节点），不写任何画布工件。
          const rerunRecord = await rerunDataFrame(entry.manifest, { sessionId: `share:${token}` });
          send(200, { record: rerunRecord });
        } catch (err) {
          send(500, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
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
          return;
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

export type { ShareRecord };
