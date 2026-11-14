/**
 * T3.1 逐画布存储绑定 + 同步门面（分享与协作的入口模块）。
 *
 * 模型（design.md「配置模型」节）：
 *  - canvasId := 会话文件基名（去 .jsonl）；多端「配置同一 S3 地址」= 绑定同一
 *    profile + canvasId，S3 key `<prefix>/<canvasId>/canvas.json` 即汇聚点。
 *  - 绑定 sidecar `<session>.storage.json` 只记 {backend, profile, canvasId,
 *    lastSyncedHash, remoteEtag}；无绑定文件 = 纯本地，完全向后兼容。
 *  - 写模型「本地写 + 异步同步」：saveCanvas 仍同步写本地（pi/既有测试的同步契约
 *    不变），成功后 fire-and-forget 上传；读路径在会话打开/分享解析时显式
 *    await refreshCanvasFromRemote 拉最新（秒级可接受，交互不卡死）。
 *  - 冲突策略：默认最后写入胜出；同步前用 remoteEtag 做 If-Match，412 时重读远端，
 *    本地无未同步改动则远端覆盖本地，否则本地覆盖远端并记冲突日志（不静默）。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canvasIdFromSessionFile, StorageConflictError } from "./backend.js";
import { S3CanvasBackend } from "./s3-backend.js";
import { canvasPathFor, storageBindingPathFor } from "./paths.js";
import type { CanvasStorageBackend } from "./backend.js";

export const STORAGE_BINDING_VERSION = 1;

export interface StorageBinding {
  version: 1;
  backend: "s3";
  profile: string;
  canvasId: string;
  /** 最近一次成功同步的本地内容 sha256（判断「本地是否有未同步改动」）。 */
  lastSyncedHash?: string;
  /** 最近一次同步后的远端 etag（If-Match 乐观锁输入）。 */
  remoteEtag?: string;
  updatedAt: string;
}

export interface BindOptions {
  profile: string;
  /** 缺省用会话文件基名（同 profile + 同 canvasId = 同一地址）。 */
  canvasId?: string;
}

export interface SyncResult {
  synced: boolean;
  conflict?: boolean;
  etag?: string;
  error?: string;
}

export interface RefreshResult {
  pulled: boolean;
  conflict?: boolean;
  error?: string;
}

// ── 绑定读写 ────────────────────────────────────────────────────────────────

export function readStorageBinding(sessionFile: string): StorageBinding | null {
  const p = storageBindingPathFor(sessionFile);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as Partial<StorageBinding>;
    if (data?.version !== STORAGE_BINDING_VERSION || data.backend !== "s3" || typeof data.profile !== "string" || typeof data.canvasId !== "string") {
      return null;
    }
    return data as StorageBinding;
  } catch {
    return null;
  }
}

export function writeStorageBinding(sessionFile: string, binding: StorageBinding): void {
  writeFileSync(storageBindingPathFor(sessionFile), JSON.stringify(binding));
}

export function bindCanvasStorage(sessionFile: string, opts: BindOptions): StorageBinding {
  const binding: StorageBinding = {
    version: STORAGE_BINDING_VERSION,
    backend: "s3",
    profile: opts.profile,
    canvasId: opts.canvasId ?? canvasIdFromSessionFile(sessionFile),
    updatedAt: new Date().toISOString(),
  };
  writeStorageBinding(sessionFile, binding);
  return binding;
}

export function clearStorageBinding(sessionFile: string): boolean {
  const p = storageBindingPathFor(sessionFile);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// ── 后端解析（测试可注入替身）──────────────────────────────────────────────

type BackendFactory = (profileId: string) => CanvasStorageBackend;

let backendFactory: BackendFactory | null = null;

/** 测试钩子：注入 profile→backend 工厂（真实实现按 config.resolveS3Target 建 S3CanvasBackend）。 */
export function setBackendFactoryForTests(factory: BackendFactory | null): void {
  backendFactory = factory;
}

export function backendForProfile(profileId: string): CanvasStorageBackend {
  if (backendFactory) return backendFactory(profileId);
  return new S3CanvasBackend(profileId);
}

/** 该会话工件生效的后端（无绑定 = null = 本地默认路径，调用方保持旧行为）。 */
export function effectiveBackend(sessionFile: string): CanvasStorageBackend | null {
  const binding = readStorageBinding(sessionFile);
  return binding ? backendForProfile(binding.profile) : null;
}

export function contentHash(json: string): string {
  return createHash("sha256").update(json, "utf-8").digest("hex").slice(0, 16);
}

function readLocalCanvasJson(sessionFile: string): string | null {
  const p = canvasPathFor(sessionFile);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

function writeLocalCanvasJson(sessionFile: string, json: string): void {
  writeFileSync(canvasPathFor(sessionFile), json);
}

// ── 同步（异步；失败只留日志，不影响交互）─────────────────────────────────

/** 本地画布工件上传远端；无绑定即 no-op。冲突时重读远端再最后写入胜出。 */
export async function syncCanvasToRemote(sessionFile: string): Promise<SyncResult> {
  const binding = readStorageBinding(sessionFile);
  if (!binding) return { synced: false };
  const localJson = readLocalCanvasJson(sessionFile);
  if (localJson === null) return { synced: false };
  const localHash = contentHash(localJson);
  if (binding.lastSyncedHash === localHash) return { synced: false };
  const backend = backendForProfile(binding.profile);
  let conflict = false;
  try {
    try {
      const res = await backend.write(binding.canvasId, localJson, { ifMatch: binding.remoteEtag ?? null });
      persistSyncMeta(sessionFile, localHash, res.etag);
      return { synced: true, conflict, etag: res.etag };
    } catch (err) {
      if (err instanceof StorageConflictError) {
        conflict = true;
        console.warn(`[storage] canvas ${binding.canvasId} remote changed since last sync; last-write-wins`);
        const res = await backend.write(binding.canvasId, localJson);
        persistSyncMeta(sessionFile, localHash, res.etag);
        return { synced: true, conflict: true, etag: res.etag };
      }
      throw err;
    }
  } catch (err) {
    return { synced: false, conflict, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 远端画布工件拉回本地缓存；无绑定即 no-op。本地有未同步改动时不强覆盖（返回 conflict）。 */
export async function refreshCanvasFromRemote(sessionFile: string): Promise<RefreshResult> {
  const binding = readStorageBinding(sessionFile);
  if (!binding) return { pulled: false };
  const backend = backendForProfile(binding.profile);
  try {
    const remote = await backend.read(binding.canvasId);
    if (!remote) return { pulled: false };
    const localJson = readLocalCanvasJson(sessionFile);
    const remoteHash = contentHash(remote.json);
    if (localJson !== null && contentHash(localJson) === remoteHash) {
      persistSyncMeta(sessionFile, remoteHash, remote.etag);
      return { pulled: false };
    }
    if (localJson !== null && binding.lastSyncedHash && contentHash(localJson) !== binding.lastSyncedHash) {
      // 本地有未同步改动 + 远端不同 → 冲突：保持本地（下一次 sync 走最后写入胜出），不静默覆盖。
      return { pulled: false, conflict: true };
    }
    writeLocalCanvasJson(sessionFile, remote.json);
    persistSyncMeta(sessionFile, remoteHash, remote.etag);
    return { pulled: true };
  } catch (err) {
    return { pulled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function persistSyncMeta(sessionFile: string, lastSyncedHash: string, remoteEtag: string | undefined): void {
  const binding = readStorageBinding(sessionFile);
  if (!binding) return;
  writeStorageBinding(sessionFile, {
    ...binding,
    lastSyncedHash,
    remoteEtag: remoteEtag ?? binding.remoteEtag,
    updatedAt: new Date().toISOString(),
  });
}

/** fire-and-forget 上传（saveCanvas 挂点）；错误只打日志（消息不含凭据，见 config.ts）。 */
export function queueRemoteSync(sessionFile: string): void {
  if (!existsSync(storageBindingPathFor(sessionFile))) return;
  void syncCanvasToRemote(sessionFile).then((res) => {
    if (res.error) console.warn(`[storage] canvas sync failed: ${res.error}`);
  });
}


/** fire-and-forget 远端删除（deleteSession 级联）。 */
export function queueRemoteDelete(sessionFile: string): void {
  const binding = readStorageBinding(sessionFile);
  if (!binding) return;
  void backendForProfile(binding.profile)
    .remove(binding.canvasId)
    .then(() => undefined)
    .catch((err) => console.warn(`[storage] canvas remote delete failed: ${err instanceof Error ? err.message : String(err)}`));
}
