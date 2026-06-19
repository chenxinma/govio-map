import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type PermissionDecision = "allow" | "deny" | "edit";

export interface PermissionRequest {
  requestId: string;
  command: string;
}

export interface PermissionResponse {
  decision: PermissionDecision;
  editedCommand?: string;
  reason?: string;
}

interface PendingEntry {
  resolve: (r: PermissionResponse) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS = 5 * 60 * 1000;

class PermissionManager {
  private acceptAll = false;
  private pending = new Map<string, PendingEntry>();
  private emitter = new EventEmitter();

  setAcceptAll(value: boolean): void {
    this.acceptAll = value;
  }

  isAcceptAll(): boolean {
    return this.acceptAll;
  }

  clearAll(): void {
    this.acceptAll = false;
    this.denyPending("会话已重置");
  }

  denyPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: "deny", reason });
    }
    this.pending.clear();
  }

  requestPermission(command: string): Promise<PermissionResponse> {
    if (this.acceptAll) {
      return Promise.resolve({ decision: "allow" });
    }
    const requestId = randomUUID();
    return new Promise<PermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve({ decision: "deny", reason: "权限请求超时（5 分钟未响应）" });
        }
      }, TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timer });
      this.emitter.emit("request", { requestId, command } satisfies PermissionRequest);
    });
  }

  resolve(requestId: string, response: PermissionResponse): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(response);
  }

  onRequest(callback: (req: PermissionRequest) => void): () => void {
    this.emitter.on("request", callback);
    return () => {
      this.emitter.off("request", callback);
    };
  }
}

export const permissionManager = new PermissionManager();
