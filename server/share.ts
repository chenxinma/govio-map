/**
 * T3.5 只读分享「画布活视图」服务端核心（取代 T3.2 的快照语义）。
 *
 * 语义变更（用户裁决 2026-11-16，见 docs/task-plan.json → T3.5.decisions）：
 *  - **不做快照**：`GET /api/shares/<token>` 每次读**当前**会话画布 sidecar，
 *    内容随源画布实时变化；`.govio/shares/*.json` 快照机制整体废弃删除
 *    （不迁移、不做只读兼容——旧随机 token 解析不到即 404）。
 *  - **token 由会话指纹派生**：`sha256("govio-share-v1:" + sessionId)` 前 32 位小写 hex，
 *    同一会话的链接**恒定**（从根上消除 T3.2「重点分享只复制旧链接」的陈旧缺陷）。
 *  - **分享开关即访问控制**：token 不可逆，服务端只能「枚举会话 → 算指纹 → 匹配」；
 *    只有 `<session>.jsonl.share.json` 存在且 `enabled:true` 的会话参与匹配，
 *    所以「撤销 = 删掉开关 sidecar」，之后链接立即失效，无需黑名单。
 *
 * 只读纪律（继承 T3.2 三层实现的 API 层）：本模块只提供读当前画布 / 暂存 fork，
 * 不存在任何把写落回源画布 sidecar 的路径；复跑路由已删除（活视图语义下动手一律走 fork）。
 *
 * 凭据安全：活视图载荷只含画布内容与 Manifest，**不含** profile 名/绑定信息/凭据；
 * share 开关 sidecar 只有 `{version, enabled, enabledAt, token}`。
 *
 * fork 血缘：新画布在 canvas.json 顶层记 forkFrom（画布级派生关系，与 lineage.ts 的
 * 数据血缘边互不相干）；派生画布再分享时活视图载荷继承 forkFrom。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { getSessionDir, loadCanvas } from "./session-history.js";
import type { CanvasForkFrom, LiveSharePayload, ShareManifestEntry } from "../src/types/share.js";
import { SHARE_ID_RE, assertValidCanvasId, assertValidShareId, canvasIdFromSessionFile } from "./storage/backend.js";
import { canvasPathFor, shareStatePathFor } from "./storage/paths.js";

export type { CanvasForkFrom, ShareManifestEntry };

/** 分享开关 sidecar 的版本号（形状变更时递增）。 */
export const SHARE_STATE_VERSION = 1;
/** 活视图载荷的版本号（前端据此判断载荷形状）。 */
export const LIVE_SHARE_VERSION = 1;
/**
 * token 派生的域分隔前缀：防止同一 sessionId 在别的用途上算出同一个 hash
 * （跨用途碰撞），也让「token 原文」不可能与任何裸 sessionId 相等。
 */
export const SHARE_TOKEN_DOMAIN = "govio-share-v1:";
export const FORK_ID_RE = SHARE_ID_RE;
export { SHARE_ID_RE };

/** 分享开关 sidecar 的落盘形状（`<session>.jsonl.share.json`）。 */
export interface ShareState {
  version: 1;
  enabled: boolean;
  /** 最近一次开启的时间；从未开启/已撤销为 null。 */
  enabledAt: string | null;
  /** 由会话指纹派生的 token（撤销后仍返回同值，重新开启即恢复同一链接）。 */
  token: string;
}

/**
 * 活视图载荷（服务端侧）：每次请求现读当前画布，不含任何快照时点信息。
 * 形状 = 线上载荷去掉由 HTTP 层补上的 `readonly` / `etag` 两个键（单一事实源：src/types/share.ts）。
 */
export type LiveShareRecord = Omit<LiveSharePayload, "readonly" | "etag">;

/** 活视图响应：载荷 + 内容 etag（`If-None-Match` 命中则回 304）。 */
export interface LiveShareView {
  record: LiveShareRecord;
  etag: string;
}

export interface ForkResult {
  forkId: string;
  shareId: string;
  canvas: { nodes: unknown[]; edges: unknown[] };
  forkFrom: CanvasForkFrom;
}

export function getForksDir(): string {
  return resolvePath(process.cwd(), ".govio", "forks");
}

function localForkPath(forkId: string): string {
  if (!FORK_ID_RE.test(forkId)) throw new Error(`invalid fork id: ${forkId.slice(0, 16)}`);
  return resolvePath(getForksDir(), `${forkId}.json`);
}

/** fork 暂存文件的不透明 id（与 token 同形状但**不同来源**：fork 是一次性工件，必须随机）。 */
export function newForkId(): string {
  return randomBytes(16).toString("hex");
}

// ── token 派生与分享开关 ──

/**
 * 由 sessionId 派生分享 token：`sha256("govio-share-v1:" + sessionId)` 前 32 位小写 hex。
 *
 * 防猜测性：sessionId 由 pi 生成（毫秒时间戳 + 128-bit uuid），原像空间不可枚举；
 * hash 单向，从 token 反推 sessionId 需要暴力搜索整个 uuid 空间。形状仍是 32 位
 * 小写 hex，与 `SHARE_ID_RE`、`src/main.tsx` 的分享路由正则完全兼容（无需改动）。
 */
export function deriveShareToken(sessionId: string): string {
  return createHash("sha256").update(`${SHARE_TOKEN_DOMAIN}${sessionId}`, "utf-8").digest("hex").slice(0, 32);
}

/** 会话文件路径 → sessionId（basename 去 `.jsonl`）。 */
export function sessionIdFromFile(sessionFile: string): string {
  return canvasIdFromSessionFile(sessionFile);
}

/** 读分享开关 sidecar；不存在/坏 JSON/形状不符一律视为「未开启」（返回 null）。 */
export function readShareState(sessionFile: string): ShareState | null {
  const p = shareStatePathFor(sessionFile);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ShareState>;
    if (raw?.version !== SHARE_STATE_VERSION || typeof raw.enabled !== "boolean") return null;
    const token = typeof raw.token === "string" && SHARE_ID_RE.test(raw.token)
      ? raw.token
      : deriveShareToken(sessionIdFromFile(sessionFile));
    return {
      version: SHARE_STATE_VERSION,
      enabled: raw.enabled,
      enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : null,
      token,
    };
  } catch {
    return null;
  }
}

/** 当前会话的分享状态视图（无 sidecar = 默认关）。 */
export function shareStateOf(sessionFile: string): ShareState {
  const state = readShareState(sessionFile);
  const token = deriveShareToken(sessionIdFromFile(sessionFile));
  return state ?? { version: SHARE_STATE_VERSION, enabled: false, enabledAt: null, token };
}

function writeShareState(sessionFile: string, state: ShareState): ShareState {
  assertValidCanvasId(canvasIdFromSessionFile(sessionFile));
  writeFileSync(shareStatePathFor(sessionFile), JSON.stringify(state));
  // 目录 mtime 粒度粗的文件系统上，写 sidecar 可能不足以让索引缓存失效——显式清一次。
  clearShareIndexCache();
  return state;
}

/**
 * 开启分享（**幂等**）：token 由会话指纹派生，重复开启返回同一 token、同一链接。
 * 已开启时只刷新 `enabledAt` 不改变 token（避免链接漂移）。
 */
export function enableShare(sessionFile: string): ShareState {
  const token = deriveShareToken(sessionIdFromFile(sessionFile));
  const existing = readShareState(sessionFile);
  if (existing?.enabled && existing.token === token) return existing;
  return writeShareState(sessionFile, {
    version: SHARE_STATE_VERSION,
    enabled: true,
    enabledAt: existing?.enabledAt ?? new Date().toISOString(),
    token,
  });
}

/**
 * 撤销分享（**幂等**）：删除开关 sidecar。token 随即解析不到 → 链接立即失效。
 * 无 sidecar 时同样返回「已关闭」状态，不抛错。
 */
export function disableShare(sessionFile: string): ShareState {
  const p = shareStatePathFor(sessionFile);
  if (existsSync(p)) unlinkSync(p);
  clearShareIndexCache();
  return {
    version: SHARE_STATE_VERSION,
    enabled: false,
    enabledAt: null,
    token: deriveShareToken(sessionIdFromFile(sessionFile)),
  };
}

// ── token 解析（hash 不可逆 ⇒ 只能枚举会话算指纹匹配）──

interface ShareIndexEntry {
  sessionId: string;
  sessionFile: string;
  token: string;
}

/**
 * sessionId → token 的派生索引缓存。
 *
 * 只缓存**派生结果**（纯计算，不含任何状态判断），按「sessions 目录路径 + 目录 mtime」失效：
 * 新建会话 / 开启分享（写新 sidecar）/ 撤销分享（删 sidecar）都会改目录 mtime。
 * `enabled` 一律在命中后**现读 sidecar**确认——撤销必须立即生效，不能被缓存拖住。
 */
let shareIndexCache: { dir: string; dirMtimeMs: number; entries: ShareIndexEntry[] } | null = null;

export function clearShareIndexCache(): void {
  shareIndexCache = null;
}

function dirMtimeMs(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return -1;
  }
}

function shareIndex(): ShareIndexEntry[] {
  const dir = getSessionDir();
  const mtime = dirMtimeMs(dir);
  if (shareIndexCache && shareIndexCache.dir === dir && shareIndexCache.dirMtimeMs === mtime) {
    return shareIndexCache.entries;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const entries: ShareIndexEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    entries.push({ sessionId, sessionFile: resolvePath(dir, name), token: deriveShareToken(sessionId) });
  }
  shareIndexCache = { dir, dirMtimeMs: mtime, entries };
  return entries;
}

/**
 * 解析分享 token → 会话文件。
 *
 * 只有「已开启分享」的会话可解析：无 sidecar / `enabled:false` / 坏 sidecar 一律 null。
 * 旧的随机 token（T3.2 快照时代）在这里天然解析不到 → 调用方回 404，链接失效。
 */
export function resolveShareToken(token: string): { sessionFile: string; state: ShareState } | null {
  let normalized: string;
  try {
    normalized = assertValidShareId(token);
  } catch {
    return null;
  }
  for (const entry of shareIndex()) {
    if (entry.token !== normalized) continue;
    const state = readShareState(entry.sessionFile);
    if (!state?.enabled || state.token !== normalized) continue;
    return { sessionFile: entry.sessionFile, state };
  }
  return null;
}

// ── 活视图载荷 ──

/** 从画布节点抽取 Manifest 清单（node.data.manifest，schema 由 analysis-manifest 保证）。 */
export function extractManifests(nodes: unknown[]): ShareManifestEntry[] {
  const out: ShareManifestEntry[] = [];
  for (const raw of nodes) {
    const node = raw as { id?: unknown; type?: unknown; data?: { title?: unknown; manifest?: ShareManifestEntry["manifest"] } };
    if (typeof node?.id !== "string" || !node.data?.manifest || typeof node.data.manifest !== "object") continue;
    out.push({
      nodeId: node.id,
      nodeTitle: typeof node.data.title === "string" ? node.data.title : "",
      nodeType: typeof node.type === "string" ? node.type : "",
      manifest: node.data.manifest,
    });
  }
  return out;
}

/** 读画布 sidecar 顶层血缘键（saveCanvas meta 的落点）。 */
export function readCanvasForkMeta(sessionFile: string): CanvasForkFrom | undefined {
  const p = canvasPathFor(sessionFile);
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { forkFrom?: CanvasForkFrom };
    return data?.forkFrom && typeof data.forkFrom === "object" ? data.forkFrom : undefined;
  } catch {
    return undefined;
  }
}

/** 活视图载荷的内容 etag（sha256 前 32 位；不透明字符串，只用于变更判等）。 */
export function liveShareEtag(json: string): string {
  return createHash("sha256").update(json, "utf-8").digest("hex").slice(0, 32);
}

/**
 * `If-None-Match` 命中判断：容忍 `W/` 弱校验前缀、引号与 `*`，支持逗号分隔的多值。
 * 解析不了的脏头一律视为不命中（宁可多发一次 200，不可错发 304）。
 */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined || etag === "") return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const normalize = (v: string): string => v.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  return raw
    .split(",")
    .map(normalize)
    .filter((v) => v !== "")
    .some((v) => v === "*" || v === etag);
}

/** 当前画布内容（sidecar 缺失 = 会话还没存过画布，视为空画布而不是「分享不存在」）。 */
function currentCanvas(sessionFile: string): { nodes: unknown[]; edges: unknown[] } {
  return loadCanvas(sessionFile) ?? { nodes: [], edges: [] };
}

/** 画布 sidecar 的最后修改时间（诊断用；内容判等一律走 etag）。读不到则归零时间。 */
function canvasUpdatedAt(sessionFile: string): string {
  try {
    return new Date(statSync(canvasPathFor(sessionFile)).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** 现读当前画布组装活视图载荷（token 已解析成功时总有载荷，画布为空则为空画布）。 */
export function liveShareRecord(sessionFile: string, token: string): LiveShareRecord {
  const canvas = currentCanvas(sessionFile);
  const canvasId = canvasIdFromSessionFile(sessionFile);
  assertValidCanvasId(canvasId);
  const forkFrom = readCanvasForkMeta(sessionFile);
  return {
    version: LIVE_SHARE_VERSION,
    token,
    canvasId,
    sessionName: canvasId,
    updatedAt: canvasUpdatedAt(sessionFile),
    canvas: { nodes: canvas.nodes, edges: canvas.edges },
    ...(forkFrom ? { forkFrom } : {}),
    manifests: extractManifests(canvas.nodes),
  };
}

/** 解析 token 并组装当前活视图（含 etag）；token 不可解析返回 null（→ 404）。 */
export function liveShareView(token: string): LiveShareView | null {
  const resolved = resolveShareToken(token);
  if (!resolved) return null;
  const record = liveShareRecord(resolved.sessionFile, token);
  return { record, etag: liveShareEtag(JSON.stringify(record.canvas)) };
}

/**
 * fork：把**当前活画布**暂存为可写副本（`.govio/forks/<forkId>.json`），返回 forkId。
 * 源画布零写入；派生血缘 forkFrom 随暂存件走，应用后落新画布 canvas.json 顶层。
 */
export function forkShare(token: string): ForkResult | null {
  const resolved = resolveShareToken(token);
  if (!resolved) return null;
  const canvas = currentCanvas(resolved.sessionFile);
  const canvasId = canvasIdFromSessionFile(resolved.sessionFile);
  const forkId = newForkId();
  const forkFrom: CanvasForkFrom = {
    kind: "share",
    shareId: token,
    canvasId,
    sessionName: canvasId,
    sharedAt: resolved.state.enabledAt ?? new Date(0).toISOString(),
    forkedAt: new Date().toISOString(),
  };
  const payload = {
    version: LIVE_SHARE_VERSION,
    forkId,
    forkFrom,
    canvas: { nodes: canvas.nodes, edges: canvas.edges },
  };
  mkdirSync(getForksDir(), { recursive: true });
  writeFileSync(localForkPath(forkId), JSON.stringify(payload));
  return { forkId, shareId: token, canvas: payload.canvas, forkFrom };
}

export interface StagedFork {
  forkId: string;
  forkFrom: CanvasForkFrom;
  canvas: { nodes: unknown[]; edges: unknown[] };
}

/** 读暂存 fork（canvas_fork_apply 落点）；坏文件视为不存在。 */
export function readStagedFork(forkId: string): StagedFork | null {
  if (!FORK_ID_RE.test(forkId)) return null;
  const p = localForkPath(forkId);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as Partial<StagedFork>;
    if (
      typeof data?.forkId !== "string" ||
      !FORK_ID_RE.test(data.forkId) ||
      typeof data.forkFrom !== "object" ||
      data.forkFrom === null ||
      !Array.isArray(data.canvas?.nodes) ||
      !Array.isArray(data.canvas?.edges)
    ) {
      return null;
    }
    return { forkId: data.forkId, forkFrom: data.forkFrom, canvas: { nodes: data.canvas.nodes, edges: data.canvas.edges } };
  } catch {
    return null;
  }
}

/** fork 应用后清理暂存（血缘已进 canvas.json，暂存使命完成）。 */
export function consumeStagedFork(forkId: string): boolean {
  if (!FORK_ID_RE.test(forkId)) return false;
  const p = localForkPath(forkId);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
