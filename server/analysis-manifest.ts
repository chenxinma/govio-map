import { createHash } from "node:crypto";
import type {
  AnalysisManifest,
  ManifestChecksum,
  ManifestModel,
  ManifestOrigin,
} from "../src/types/manifest.js";

/**
 * Analysis Manifest 构建（ROADMAP Phase 1 / KR1）。
 *
 * 类型定义在 `src/types/manifest.ts`（前后端共享）；本模块只负责服务端侧的
 * 填充与校验和计算，不读取任何数据内容——规模与结构信息全部来自
 * `observe load` / `observe info` 的 JSON 输出。
 */

/** Manifest 结构版本号；字段增删时递增（与 `AnalysisManifest.schemaVersion` 对应） */
export const MANIFEST_SCHEMA_VERSION = 1;

/** 校验和算法标识 */
export const CHECKSUM_ALGORITHM = "schema-v1" as const;

/** 校验和取 sha256 前 16 位十六进制：64 bit 足以判定「是否同一结果」，节点上也好展示 */
const HASH_HEX_LENGTH = 16;

/** 校验和所需的列信息（`observe` 输出里 name/column/col 三种键名已在上游归一化） */
export interface ManifestColumn {
  name: string;
  dtype: string;
}

/** 会话上下文：会话 ID + 生成模型 */
export interface ManifestSessionContext {
  /** pi 会话 ID；取不到时为空串 */
  sessionId: string;
  /** 生成模型；人工执行（SQL 编辑器）时缺省 */
  model?: ManifestModel;
}

export interface BuildManifestInput {
  /** 产生路径 */
  origin: ManifestOrigin;
  /** SQL 全文；取不到时传空串（该节点不可一键复跑） */
  sql: string;
  /** 数据源标识；`--memory` 派生传 `memory`；未知传空串 */
  datasource: string;
  /** 结果 DataFrame 名（sqlQuery 节点不传） */
  dfName?: string;
  /** 执行时间 ISO；缺省取当前时间 */
  executedAt?: string;
  /** 结果列（提供时连同行列数计算校验和） */
  columns?: ManifestColumn[];
  /** 结果行数 */
  rowCount?: number;
  /** 结果列数 */
  columnCount?: number;
  /** 会话与模型上下文 */
  context: ManifestSessionContext;
  /** 关联权限决策 ID（T1.3 落地后填充，当前透传） */
  permissionDecisionId?: string | null;
  /** `--memory` 派生时的上游 DataFrame 名 */
  sourceDataFrames?: string[];
}

/** sha256 短哈希（前 16 位十六进制），供 schemaHash / sqlHash 复用。 */
export function shortSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, HASH_HEX_LENGTH);
}

/**
 * 计算轻量校验和：规模（行/列数）+ 结构（列名与 dtype）+ SQL 文本。
 * 不哈希数据内容（取舍见 `src/types/manifest.ts` 的 ManifestChecksum 注释）。
 * 列顺序参与哈希——列顺序变化本身就是一次结构漂移。
 */
export function computeChecksum(
  sql: string,
  columns: ManifestColumn[],
  rowCount: number,
  columnCount: number,
): ManifestChecksum {
  // JSON.stringify 避免列名里出现分隔符（逗号/冒号）时的拼接歧义。
  const schemaInput = JSON.stringify([rowCount, columnCount, columns.map((c) => [c.name, c.dtype])]);
  return {
    algorithm: CHECKSUM_ALGORITHM,
    rowCount,
    columnCount,
    schemaHash: shortSha256(schemaInput),
    sqlHash: shortSha256(sql),
  };
}

/** 把 pi 的 `Model` / AgentSession 的 `model` 归一化成 ManifestModel。 */
export function toManifestModel(
  model: { provider?: string; id?: string; name?: string } | null | undefined,
): ManifestModel | undefined {
  if (!model) return undefined;
  const out: ManifestModel = {};
  if (typeof model.provider === "string" && model.provider) out.provider = model.provider;
  if (typeof model.id === "string" && model.id) out.id = model.id;
  if (typeof model.name === "string" && model.name) out.name = model.name;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从助手消息（pi 的 AssistantMessage）取「实际生成本条消息的模型」。
 * 比 `ctx.model`（当前选择）更准确：一轮对话中途切模型时，消息自带的
 * provider/model 才是真实来源；`responseModel` 与请求 `model` 不同时一并记下。
 */
export function toManifestModelFromMessage(message: {
  provider?: string;
  model?: string;
  responseModel?: string;
} | null | undefined): ManifestModel | undefined {
  if (!message || (!message.model && !message.provider)) return undefined;
  const out: ManifestModel = {};
  if (message.provider) out.provider = message.provider;
  if (message.model) out.id = message.model;
  if (message.responseModel && message.responseModel !== message.model) {
    out.responseModel = message.responseModel;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 pi 扩展事件上下文取会话 ID 与当前模型。
 * `ctx.sessionManager` 只读，会话未落盘时 getSessionId() 可能抛错，故整体兜底为空串。
 */
export function piSessionContext(ctx: {
  sessionManager?: { getSessionId(): string };
  model?: { provider?: string; id?: string; name?: string };
} | undefined): ManifestSessionContext {
  return { sessionId: readSessionId(ctx), model: toManifestModel(ctx?.model) };
}

function readSessionId(ctx: { sessionManager?: { getSessionId(): string } } | undefined): string {
  try {
    return ctx?.sessionManager?.getSessionId() ?? "";
  } catch {
    return "";
  }
}

/** 从 AgentSession（`server/agent.ts` 的 getSession()）取会话 ID 与当前模型。 */
export function agentSessionContext(session: {
  sessionId?: string;
  model?: { provider?: string; id?: string; name?: string };
} | null | undefined): ManifestSessionContext {
  return {
    sessionId: session?.sessionId ?? "",
    model: toManifestModel(session?.model),
  };
}

/**
 * 组装 Manifest。行列数与列信息齐备时计算校验和，否则（如 sqlQuery 节点
 * 只有 SQL 尚未执行）省略结果指标字段。
 * 列信息为空时不产出校验和：「空 schema 哈希」会在下次拿到真实列信息时
 * 造成假漂移（T1.2）；此时仍保留 rowCount/columnCount 供规模对比。
 */
export function buildManifest(input: BuildManifestInput): AnalysisManifest {
  const rowCount = input.rowCount;
  const columnCount = input.columnCount;
  const manifest: AnalysisManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    origin: input.origin,
    sql: input.sql,
    datasource: input.datasource,
    executedAt: input.executedAt ?? new Date().toISOString(),
    sessionId: input.context.sessionId,
  };
  if (input.dfName) manifest.dfName = input.dfName;
  if (typeof rowCount === "number") manifest.rowCount = rowCount;
  if (typeof columnCount === "number") manifest.columnCount = columnCount;
  if (input.columns && input.columns.length > 0 && typeof rowCount === "number" && typeof columnCount === "number") {
    manifest.checksum = computeChecksum(input.sql, input.columns, rowCount, columnCount);
  }
  if (input.context.model) manifest.model = input.context.model;
  // T1.3 之前恒为 null：显式写出「未关联权限决策」，与「旧节点没有该字段」区分开。
  manifest.permissionDecisionId = input.permissionDecisionId ?? null;
  if (input.sourceDataFrames && input.sourceDataFrames.length > 0) {
    manifest.sourceDataFrames = input.sourceDataFrames;
  }
  return manifest;
}

if (process.env.NODE_ENV !== "production") {
  // 自检：校验和确定性（同输入同哈希）+ 结构变化可检出。
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const cols: ManifestColumn[] = [{ name: "id", dtype: "BIGINT" }, { name: "amt", dtype: "DOUBLE" }];
  const a = computeChecksum("SELECT 1", cols, 10, 2);
  const b = computeChecksum("SELECT 1", cols, 10, 2);
  assert(a.schemaHash === b.schemaHash && a.sqlHash === b.sqlHash, "checksum must be deterministic");
  assert(a.schemaHash.length === HASH_HEX_LENGTH, "schemaHash is 16 hex chars");
  assert(computeChecksum("SELECT 1", cols, 11, 2).schemaHash !== a.schemaHash, "row count changes the hash");
  assert(computeChecksum("SELECT 1", [{ name: "id", dtype: "INTEGER" }, cols[1]], 10, 2).schemaHash !== a.schemaHash, "dtype changes the hash");
  assert(buildManifest({ origin: "assistant-sql", sql: "SELECT 1", datasource: "", context: { sessionId: "" } }).checksum === undefined, "sqlQuery manifest has no checksum");
  assert(buildManifest({ origin: "observe-load", sql: "SELECT 1", datasource: "ds", columns: [], rowCount: 3, columnCount: 0, context: { sessionId: "" } }).checksum === undefined, "no columns -> no checksum");
}
