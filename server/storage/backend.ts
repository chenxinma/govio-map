/**
 * T3.1 画布存储抽象：CanvasStorageBackend 接口与画布标识校验。
 *
 * 设计要点（详见 docs/tasks/T3.1-canvas-team-storage/design.md）：
 *  - 会话 jsonl 由 pi SessionManager 直接写本地盘，**不纳入远端后端**；
 *    本接口只抽象「画布工件」（canvas.json 及其派生记录），即团队共享的真源。
 *  - 后端以 `canvasId` 为主键（= 会话文件基名去掉 `.jsonl`），不接收调用方
 *    拼好的路径：LocalBackend 由 canvasId 派生路径、S3Backend 由 canvasId 派生
 *    key，`assertValidCanvasId` 与 `assertValidSessionPath` 保持等价安全边界
 *    （只放行会话目录内单段、无穿越的合法标识）。
 *  - 写返回 etag，可选 ifMatch 乐观锁（S3 无原子 rename/文件锁的替代策略）。
 */

/** 画布工件记录：原文 JSON 文本 + 不透明 etag（本地=内容 sha256 前 16 位，S3=S3 ETag）。 */
export interface CanvasRecord {
  json: string;
  etag: string;
}

/** ifMatch 前置条件失败（并发写冲突）。调用方据此决定重读合并或最后写入胜出。 */
export class StorageConflictError extends Error {
  readonly canvasId: string;
  constructor(canvasId: string) {
    super(`storage conflict: canvas ${canvasId} changed remotely (etag mismatch)`);
    this.name = "StorageConflictError";
    this.canvasId = canvasId;
  }
}

export interface CanvasStorageBackend {
  readonly kind: "local" | "s3";
  /** 读画布工件；不存在返回 null。坏 JSON 原样返回，形状校验留给上层（与 loadCanvas 语义一致）。 */
  read(canvasId: string): Promise<CanvasRecord | null>;
  /** 写画布工件；opts.ifMatch 提供时做乐观并发检查，冲突抛 StorageConflictError。 */
  write(canvasId: string, json: string, opts?: { ifMatch?: string | null }): Promise<{ etag: string }>;
  /** 删除画布工件；返回是否真的删掉了。 */
  remove(canvasId: string): Promise<boolean>;
  /** 列出该后端下所有画布 id（分享/归集发现用）。 */
  list(): Promise<string[]>;
}

/**
 * canvasId 白名单：会话文件基名由 pi 生成（时间戳+uuid 风格），此处只放行
 * 「单一路径段、无穿越、以合法字符开头」的标识，显式拒绝 `..`、绝对路径与分隔符。
 */
export const CANVAS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidCanvasId(canvasId: string): string {
  if (!CANVAS_ID_RE.test(canvasId) || canvasId.includes("..") || canvasId.includes("/") || canvasId.includes("\\")) {
    throw new Error(`invalid canvas id: ${canvasId}`);
  }
  return canvasId;
}

/** 分享令牌：32 位十六进制（randomBytes(16)），拒绝一切其它形状。 */
export const SHARE_ID_RE = /^[a-f0-9]{32}$/;

export function assertValidShareId(shareId: string): string {
  if (!SHARE_ID_RE.test(shareId)) {
    throw new Error(`invalid share id: ${shareId.slice(0, 16)}`);
  }
  return shareId;
}

/** 从会话文件路径取 canvasId（基名去掉 .jsonl）。服务端 sidecar 路径已由 assertValidSessionPath 把关。 */
export function canvasIdFromSessionFile(sessionFile: string): string {
  const base = sessionFile.split(/[\\/]/).pop() ?? "";
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}
