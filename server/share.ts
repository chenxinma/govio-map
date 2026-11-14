/**
 * T3.2 只读分享与 fork 续写（服务端核心逻辑）。
 *
 * 分享 = 画布快照（nodes/edges + 顶层血缘键 + Manifest 抽取清单）固化为一份
 * 不可变 ShareRecord：
 *  - 未绑定 S3：写本机 `.govio/shares/<shareId>.json`（同机只读链接）；
 *  - 已绑定 S3：同时写远端 `<prefix>/shares/<shareId>.json`（跨实例可解析——
 *    对端按自己配置的 profiles 逐个尝试 share key，见 resolveShare）。
 * 令牌即读权限（链接 + randomBytes(16) hex；无账号体系，按任务纪律不做 SSO）。
 *
 * 凭据安全：ShareRecord 允许携带 profile **名称**（用于跨实例发现），绝不携带
 * endpoint 之外的凭据信息；credentials 只在请求时从 env 解析（config.ts）。
 *
 * 只读语义：share API 只提供 GET 快照 / POST fork / POST rerun（生成新副本），
 * 不存在任何把写落回源画布 sidecar 的路径；复跑对齐 T1.2（按 Manifest 固化 SQL
 * 重跑 + checksum 判漂移），结果只进响应与分享视图本地态，不触碰任何画布工件。
 *
 * fork 血缘：新画布在 canvas.json 顶层记 forkFrom（画布级派生关系，与
 * lineage.ts 的数据血缘边互不相干）；派生画布再分享时 ShareRecord 继承 forkFrom。
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadCanvas } from "./session-history.js";
import type { AnalysisManifest } from "../src/types/manifest.js";
import { SHARE_ID_RE, assertValidCanvasId, assertValidShareId, canvasIdFromSessionFile } from "./storage/backend.js";
import { readStorageBinding } from "./storage/canvas-storage.js";
import { loadStorageProfiles, resolveS3Target } from "./storage/config.js";
import { signedS3Request } from "./storage/s3-client.js";

export const SHARE_RECORD_VERSION = 1;
export const FORK_ID_RE = SHARE_ID_RE;
export { SHARE_ID_RE };

/** 画布级派生血缘（记录在 canvas.json 顶层 forkFrom 键；分享/再 fork 时继承）。 */
export interface CanvasForkFrom {
  kind: "share";
  shareId: string;
  canvasId: string;
  sessionName: string | null;
  sharedAt: string;
  forkedAt: string;
}

export interface ShareManifestEntry {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  manifest: AnalysisManifest;
}

export interface ShareRecord {
  version: 1;
  shareId: string;
  canvasId: string;
  sessionName: string | null;
  createdAt: string;
  /** 源画布当时是否绑定 S3（诊断/跨实例发现线索；非凭据）。 */
  originBackend: "local" | "s3";
  /** S3 profile 名称（仅绑定后存在）。 */
  profile?: string;
  canvas: { nodes: unknown[]; edges: unknown[] };
  /** 源画布若已是 fork 产物，继承其派生血缘。 */
  forkFrom?: CanvasForkFrom;
  /** Manifest 抽取清单（只读视图展示 + 复跑输入源）。 */
  manifests: ShareManifestEntry[];
}

export interface ForkResult {
  forkId: string;
  shareId: string;
  canvas: { nodes: unknown[]; edges: unknown[] };
  forkFrom: CanvasForkFrom;
}

export function getSharesDir(): string {
  return resolvePath(process.cwd(), ".govio", "shares");
}

export function getForksDir(): string {
  return resolvePath(process.cwd(), ".govio", "forks");
}

function localSharePath(shareId: string): string {
  assertValidShareId(shareId);
  return resolvePath(getSharesDir(), `${shareId}.json`);
}

function localForkPath(forkId: string): string {
  if (!FORK_ID_RE.test(forkId)) throw new Error(`invalid fork id: ${forkId.slice(0, 16)}`);
  return resolvePath(getForksDir(), `${forkId}.json`);
}

export function newShareId(): string {
  return randomBytes(16).toString("hex");
}

/** 从画布节点抽取 Manifest 清单（node.data.manifest，schema 由 analysis-manifest 保证）。 */
export function extractManifests(nodes: unknown[]): ShareManifestEntry[] {
  const out: ShareManifestEntry[] = [];
  for (const raw of nodes) {
    const node = raw as { id?: unknown; type?: unknown; data?: { title?: unknown; manifest?: AnalysisManifest } };
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
  const p = resolvePath(sessionFile + ".canvas.json");
  if (!existsSync(p)) return undefined;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { forkFrom?: CanvasForkFrom };
    return data?.forkFrom && typeof data.forkFrom === "object" ? data.forkFrom : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 为当前会话画布创建分享：快照固化 → 本地必写；S3 绑定画布 best-effort 同步写远端
 * （远端失败不阻断分享创建，originBackend 记录来源供诊断）。
 */
export async function createShare(sessionFile: string, sessionName: string | null): Promise<ShareRecord> {
  const canvas = loadCanvas(sessionFile);
  if (!canvas) throw new Error("share requires a saved canvas (nodes/edges sidecar)");
  const binding = readStorageBinding(sessionFile);
  const record: ShareRecord = {
    version: SHARE_RECORD_VERSION,
    shareId: newShareId(),
    canvasId: canvasIdFromSessionFile(sessionFile),
    sessionName,
    createdAt: new Date().toISOString(),
    originBackend: binding ? "s3" : "local",
    ...(binding?.profile ? { profile: binding.profile } : {}),
    canvas: { nodes: canvas.nodes, edges: canvas.edges },
    ...(readCanvasForkMeta(sessionFile) ? { forkFrom: readCanvasForkMeta(sessionFile) } : {}),
    manifests: extractManifests(canvas.nodes),
  };
  assertValidCanvasId(record.canvasId);
  mkdirSync(getSharesDir(), { recursive: true });
  writeFileSync(localSharePath(record.shareId), JSON.stringify(record));
  if (binding?.profile) {
    try {
      await putRemoteShare(binding.profile, record.shareId, JSON.stringify(record));
    } catch (err) {
      console.warn(`[share] remote share write failed (local share still valid): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return record;
}

// ── 远端 share 存取（S3 兼容后端；测试经 setShareTransportFactoryForTests 注入替身）──

export interface ShareTransport {
  put(key: string, json: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

type ShareTransportFactory = (profileId: string) => ShareTransport;

let shareTransportFactory: ShareTransportFactory | null = null;

export function setShareTransportFactoryForTests(factory: ShareTransportFactory | null): void {
  shareTransportFactory = factory;
}

/** 远端 key 统一 `<prefix>/shares/<shareId>.json`（prefix 取自 profile 配置，凭据不参与）。 */
export function remoteShareKey(profileId: string, shareId: string): string {
  assertValidShareId(shareId);
  const p = loadStorageProfiles().profiles[profileId];
  if (!p) throw new Error(`storage profile not found: ${profileId}`);
  const prefix = p.prefix ?? "";
  return `${prefix ? prefix + "/" : ""}shares/${shareId}.json`;
}

function defaultShareTransport(profileId: string): ShareTransport {
  const t = resolveS3Target(profileId);
  const cfg = {
    endpoint: t.endpoint,
    region: t.region,
    bucket: t.bucket,
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    sessionToken: t.sessionToken,
    forcePathStyle: t.forcePathStyle,
  };
  return {
    async put(key, json) {
      const res = await signedS3Request(cfg, "PUT", key, { body: json });
      if (res.status < 200 || res.status >= 300) throw new Error(`s3 share PUT ${key} -> ${res.status}`);
    },
    async get(key) {
      const res = await signedS3Request(cfg, "GET", key, {});
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw new Error(`s3 share GET ${key} -> ${res.status}`);
      return res.body;
    },
  };
}

export async function putRemoteShare(profileId: string, shareId: string, json: string): Promise<void> {
  const transport = (shareTransportFactory ?? defaultShareTransport)(profileId);
  await transport.put(remoteShareKey(profileId, shareId), json);
}

export async function getRemoteShare(profileId: string, shareId: string): Promise<string | null> {
  const transport = (shareTransportFactory ?? defaultShareTransport)(profileId);
  return transport.get(remoteShareKey(profileId, shareId));
}

/** 逐个已配置 profile 尝试远端 share key（跨实例发现；profile 名不是凭据）。 */
async function findRemoteShare(shareId: string): Promise<ShareRecord | null> {
  for (const profileId of Object.keys(loadStorageProfiles().profiles)) {
    try {
      const raw = await getRemoteShare(profileId, shareId);
      if (raw) {
        const parsed = parseShareRecord(raw);
        if (parsed) return parsed;
      }
    } catch (err) {
      console.warn(`[share] remote resolve failed via profile ${profileId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

export function parseShareRecord(raw: string): ShareRecord | null {
  try {
    const rec = JSON.parse(raw) as Partial<ShareRecord>;
    if (
      rec?.version !== SHARE_RECORD_VERSION ||
      typeof rec.shareId !== "string" ||
      !SHARE_ID_RE.test(rec.shareId) ||
      !Array.isArray(rec.canvas?.nodes) ||
      !Array.isArray(rec.canvas?.edges)
    ) {
      return null;
    }
    return {
      ...(rec as ShareRecord),
      manifests: Array.isArray(rec.manifests) ? rec.manifests : [],
    };
  } catch {
    return null;
  }
}

/** 解析分享：本机记录优先，其次逐个配置 profile 查远端。坏记录视为不存在。 */
export async function resolveShare(shareId: string): Promise<ShareRecord | null> {
  const local = localSharePath(shareId);
  if (existsSync(local)) {
    try {
      const rec = parseShareRecord(readFileSync(local, "utf-8"));
      if (rec) return rec;
    } catch {
      return null;
    }
  }
  return findRemoteShare(shareId);
}

/** fork：把分享快照固化为暂存可写副本（`.govio/forks/<forkId>.json`），返回 forkId。 */
export async function forkShare(shareId: string): Promise<ForkResult | null> {
  const record = await resolveShare(shareId);
  if (!record) return null;
  const forkId = newShareId();
  const forkFrom: CanvasForkFrom = {
    kind: "share",
    shareId: record.shareId,
    canvasId: record.canvasId,
    sessionName: record.sessionName,
    sharedAt: record.createdAt,
    forkedAt: new Date().toISOString(),
  };
  const payload = {
    version: SHARE_RECORD_VERSION,
    forkId,
    forkFrom,
    canvas: { nodes: record.canvas.nodes, edges: record.canvas.edges },
  };
  mkdirSync(getForksDir(), { recursive: true });
  writeFileSync(localForkPath(forkId), JSON.stringify(payload));
  return { forkId, shareId: record.shareId, canvas: payload.canvas, forkFrom };
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

/** 分享的只读序列化：剥掉 profile 名（视图不需要后端拓扑信息），保留血缘与 Manifest。 */
export function shareViewPayload(record: ShareRecord): Omit<ShareRecord, "profile" | "originBackend"> {
  const rest = { ...record } as Partial<ShareRecord>;
  delete rest.profile;
  delete rest.originBackend;
  return rest as Omit<ShareRecord, "profile" | "originBackend">;
}
