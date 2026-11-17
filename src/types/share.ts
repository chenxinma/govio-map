/**
 * 只读分享「活视图」的线上载荷类型（T3.5，前后端共享）。
 *
 * 与 T3.2 的快照 ShareRecord 不同：这里没有任何「分享时点」信息——载荷每次请求
 * 现读源会话的当前画布，内容随源画布实时变化。约定见
 * `docs/specs/06-backend.md` 的 share.ts / share-api.ts 小节。
 */
import type { AnalysisManifest } from "./manifest.js";

/** 画布级派生血缘（记录在 canvas.json 顶层 `forkFrom` 键；分享/再 fork 时继承）。
 * `shareId` = 分享 token（T3.5 起 token 由会话指纹派生；字段名沿用既有画布工件契约）。 */
export interface CanvasForkFrom {
  kind: "share";
  shareId: string;
  canvasId: string;
  sessionName: string | null;
  sharedAt: string;
  forkedAt: string;
}

/** 节点的分析留痕摘要条目（只读视图右栏展示；不再是复跑输入源——复跑已从只读页删除）。 */
export interface ShareManifestEntry {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  manifest: AnalysisManifest;
}

/** `GET /api/shares/<token>` 的响应体（活视图载荷 + 内容 etag）。 */
export interface LiveSharePayload {
  readonly: true;
  version: 1;
  /** 画布内容 etag：下一次轮询放进 `If-None-Match`，命中回 304。 */
  etag: string;
  token: string;
  canvasId: string;
  sessionName: string | null;
  /** 画布 sidecar 的最后修改时间（诊断用；变更判等一律走 etag）。 */
  updatedAt: string;
  canvas: { nodes: unknown[]; edges: unknown[] };
  forkFrom?: CanvasForkFrom;
  manifests: ShareManifestEntry[];
}

/** `GET /api/share-state` 的响应体：当前会话的分享开关状态。 */
export interface ShareStatePayload {
  enabled: boolean;
  token: string;
  enabledAt: string | null;
}

/** `POST /api/shares`（开启）与 `DELETE /api/shares`（撤销）的响应体。 */
export interface ShareTogglePayload {
  enabled: boolean;
  token: string;
  enabledAt?: string | null;
  url?: string;
}

/** token 未开启/不存在/形状非法时统一的 404 载荷（不泄露会话是否存在）。 */
export const SHARE_NOT_FOUND_ERROR = "share-not-found";
