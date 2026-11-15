/**
 * T3.1 S3CanvasBackend：逐画布配置 S3 地址的后端实现。
 *
 * key 布局（prefix 来自 profile，canvasId 白名单校验）：
 *   <prefix>/<canvasId>/canvas.json     画布真源
 *   <prefix>/shares/<shareId>.json      只读分享快照（T3.2）
 * 多端把各自的画布绑定到同一 profile+canvasId 即指向同一地址 = 画布协作。
 * 并发策略：write 支持 ifMatch（If-Match）乐观锁，412 → StorageConflictError；
 * 上层默认「最后写入胜出 + 冲突留痕」，详见 design.md。
 */
import { assertValidCanvasId, assertValidShareId, StorageConflictError, type CanvasRecord, type CanvasStorageBackend } from "./backend.js";
import { resolveS3Target, type ResolvedS3Target } from "./config.js";
import { parseListKeys, signedS3Request, S3HttpError } from "./s3-client.js";

export interface S3BackendOptions {
  fetchImpl?: typeof fetch;
  targetResolver?: (profileId: string) => ResolvedS3Target;
  timeoutMs?: number;
}

export class S3CanvasBackend implements CanvasStorageBackend {
  readonly kind = "s3" as const;
  private readonly target: ResolvedS3Target;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(profileId: string, opts: S3BackendOptions = {}) {
    this.target = (opts.targetResolver ?? resolveS3Target)(profileId);
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs;
  }

  private cfg(): Parameters<typeof signedS3Request>[0] {
    const t = this.target;
    return {
      endpoint: t.endpoint,
      region: t.region,
      bucket: t.bucket,
      accessKeyId: t.accessKeyId,
      secretAccessKey: t.secretAccessKey,
      sessionToken: t.sessionToken,
      forcePathStyle: t.forcePathStyle,
    };
  }

  canvasKey(canvasId: string): string {
    assertValidCanvasId(canvasId);
    return this.withPrefix(`${canvasId}/canvas.json`);
  }

  shareKey(shareId: string): string {
    assertValidShareId(shareId);
    return this.withPrefix(`shares/${shareId}.json`);
  }

  private withPrefix(key: string): string {
    return this.target.prefix ? `${this.target.prefix}/${key}` : key;
  }

  async read(canvasId: string): Promise<CanvasRecord | null> {
    const res = await signedS3Request(this.cfg(), "GET", this.canvasKey(canvasId), {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 404) return null;
    if (res.status === 304) throw new S3HttpError(304, `unexpected 304 for ${canvasId}`);
    if (res.status < 200 || res.status >= 300) throw new S3HttpError(res.status, `s3 GET ${canvasId} -> ${res.status}`);
    return { json: res.body, etag: (res.etag ?? "").replace(/^"|"$/g, "") };
  }

  async write(canvasId: string, json: string, opts?: { ifMatch?: string | null }): Promise<{ etag: string }> {
    const res = await signedS3Request(this.cfg(), "PUT", this.canvasKey(canvasId), {
      body: json,
      ifMatch: opts?.ifMatch || undefined,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 412) throw new StorageConflictError(canvasId);
    if (res.status < 200 || res.status >= 300) throw new S3HttpError(res.status, `s3 PUT ${canvasId} -> ${res.status}`);
    return { etag: (res.etag ?? "").replace(/^"|"$/g, "") };
  }

  async remove(canvasId: string): Promise<boolean> {
    const existing = await this.read(canvasId);
    if (!existing) return false;
    const res = await signedS3Request(this.cfg(), "DELETE", this.canvasKey(canvasId), {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw new S3HttpError(res.status, `s3 DELETE ${canvasId} -> ${res.status}`);
    return true;
  }

  async list(): Promise<string[]> {
    const prefix = this.withPrefix("");
    const res = await signedS3Request(this.cfg(), "GET", "", {
      query: prefix ? { "list-type": "2", prefix } : { "list-type": "2" },
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (res.status < 200 || res.status >= 300) throw new S3HttpError(res.status, `s3 LIST -> ${res.status}`);
    const inner = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : "";
    const out: string[] = [];
    for (const key of parseListKeys(res.body)) {
      const m = /^([^/]+)\/canvas\.json$/.exec(key.startsWith(inner) ? key.slice(inner.length) : key);
      if (m) out.push(m[1]);
    }
    return [...new Set(out)].sort();
  }
}
