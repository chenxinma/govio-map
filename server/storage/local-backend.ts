/**
 * T3.1 LocalBackend：本地文件系统画布存储（默认后端，行为与旧 session-history
 * sidecar 完全一致：同目录 `<canvasId>.canvas.json`，等价旧 `sessionFile + ".canvas.json"`）。
 *
 * 注意与旧行为的对齐点（回归基线 624/194/31 直接调用 saveCanvas/loadCanvas，
 * 走的仍是 session-history 的同步 fs 路径；LocalBackend 主要服务「远端绑定后
 * 的同步/分享读路径」与接口契约测试，两者读写同一物理文件，语义必须一致）：
 *  - 坏 JSON：read 原样返回文本（上层 loadCanvas 语义是返回 null，不在这里做形状判断）；
 *  - etag：内容 sha256 前 16 位，与 S3 ETag 同为不透明字符串；
 *  - ifMatch：etag 不符 → StorageConflictError。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { assertValidCanvasId, StorageConflictError, type CanvasRecord, type CanvasStorageBackend } from "./backend.js";

export class LocalCanvasBackend implements CanvasStorageBackend {
  readonly kind = "local" as const;

  private readonly root: string;

  /** @param root 画布工件根目录（生产为 getSessionDir()；测试注入 tmp 目录） */
  constructor(root: string) {
    this.root = root;
  }

  private pathFor(canvasId: string): string {
    assertValidCanvasId(canvasId);
    const p = resolvePath(this.root, `${canvasId}.canvas.json`);
    // 双保险：解析后必须仍在 root 内（防白名单被绕过时的目录穿越）
    if (p !== this.rootResolved() && !p.startsWith(this.rootResolved())) {
      throw new Error(`invalid canvas id: ${canvasId}`);
    }
    return p;
  }

  private rootResolved(): string {
    return resolvePath(this.root);
  }

  async read(canvasId: string): Promise<CanvasRecord | null> {
    const p = this.pathFor(canvasId);
    if (!existsSync(p)) return null;
    const json = readFileSync(p, "utf-8");
    return { json, etag: localEtag(json) };
  }

  async write(canvasId: string, json: string, opts?: { ifMatch?: string | null }): Promise<{ etag: string }> {
    const p = this.pathFor(canvasId);
    const current = existsSync(p) ? readFileSync(p, "utf-8") : null;
    if (opts?.ifMatch && (current === null || localEtag(current) !== opts.ifMatch)) {
      throw new StorageConflictError(canvasId);
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, json);
    return { etag: localEtag(json) };
  }

  async remove(canvasId: string): Promise<boolean> {
    const p = this.pathFor(canvasId);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  async list(): Promise<string[]> {
    // 轻量扫描：只列 <canvasId>.canvas.json（不引 readdir 选项依赖）
    const { readdirSync } = await import("node:fs");
    if (!existsSync(this.rootResolved())) return [];
    return readdirSync(this.rootResolved())
      .filter((f) => f.endsWith(".canvas.json"))
      .map((f) => f.slice(0, -".canvas.json".length))
      .sort();
  }
}

export function localEtag(json: string): string {
  return createHash("sha256").update(json, "utf-8").digest("hex").slice(0, 16);
}

/** join 供测试拼路径（避免各处再引 path 语义） */
export function localCanvasFileName(canvasId: string): string {
  return join(`${canvasId}.canvas.json`);
}
