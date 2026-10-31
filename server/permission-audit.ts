import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionDecision } from "./permission-manager.js";

/**
 * 权限确认审计留痕（ROADMAP Phase 1 / KR3 取数确认门）。
 *
 * 每一次「高风险取数命令是否放行」的确认都落成一条 JSONL 记录，追加到会话
 * transcript 的 sidecar：`<session-file>.audit.jsonl`（与 `<session-file>.canvas.json`
 * 同一套生命周期，`deleteSession()` 一并删除）。
 *
 * 设计约束：
 * - **只追加、不回改**：审计记录一旦写下就是事实，任何后续动作（复跑、导出）
 *   都只读它，避免留痕被覆盖后失去质证价值。
 * - **写失败不阻断确认流**：落盘异常只告警，绝不让「记不上账」变成「命令执行不了」
 *   或「用户点了没反应」。
 * - **不读数据内容**：记录里只有命令文本与决策，不含任何查询结果。
 *
 * 会话归属由 `setAuditSessionResolver()` 注入（`server/agent.ts` 在模块加载时注册），
 * 本模块不反向依赖 agent/permission-manager，避免循环导入。
 */

/** 审计记录结构版本；字段增删时递增，供导出与迁移做兼容判断 */
export const PERMISSION_AUDIT_VERSION = 1;

/** 审计记录类型：请求 / 决策 / 放行模式变更 */
export type PermissionAuditEventType = "permission_request" | "permission_decision" | "permission_mode";

/**
 * 决策来源：区分「用户亲手点的」与「系统代答的」。
 * - `user`：前端 PermissionCard 上点了允许/拒绝/修改
 * - `accept-all`：全局放行模式下自动允许（没有人工确认这一步）
 * - `timeout`：5 分钟无人响应，自动拒绝
 * - `abort`：用户中止本轮对话，挂起的请求被自动拒绝
 * - `reset`：清空/切换会话，挂起的请求被自动拒绝
 */
export type PermissionDecisionSource = "user" | "accept-all" | "timeout" | "abort" | "reset";

interface PermissionAuditEntryBase {
  /** 记录结构版本，见 {@link PERMISSION_AUDIT_VERSION} */
  v: number;
  /** ISO 8601 时间戳（服务端时钟） */
  at: string;
  /**
   * 决策 ID：一次确认的唯一标识（`pd-<uuid>` / 模式事件为 `pm-<uuid>`）。
   * 与 `AnalysisManifest.permissionDecisionId` 同值，是节点留痕回查确认记录的唯一钥匙。
   */
  decisionId: string;
  /** pi 会话 ID；取不到时为空串 */
  sessionId: string;
  /** 会话 transcript 文件路径（审计 sidecar 的主体） */
  sessionFile: string;
}

/** 确认门被触发（命令原文 + 走人工确认还是全局放行） */
export interface PermissionRequestAuditEntry extends PermissionAuditEntryBase {
  type: "permission_request";
  /** 命令原文（agent 生成的 bash 命令，未做任何改写） */
  command: string;
  /** `ask` = 推给前端等用户决定；`accept-all` = 全局放行下自动允许 */
  gate: "ask" | "accept-all";
  /** 本命令正是上一次 `edit` 决策改出来的命令时，指回那次决策（链式溯源） */
  followsDecisionId?: string;
}

/** 确认门的最终决策（allow / deny / edit） */
export interface PermissionDecisionAuditEntry extends PermissionAuditEntryBase {
  type: "permission_decision";
  decision: PermissionDecision;
  /** 被确认的命令原文（`edit` 时这是**修改前**的命令） */
  command: string;
  /** `edit` 决策修改后的命令；其他决策无此字段 */
  editedCommand?: string;
  /** 拒绝/中止原因，或前端随决策带回的备注 */
  reason?: string;
  /** 决策来源，见 {@link PermissionDecisionSource} */
  source: PermissionDecisionSource;
  /** 从触发确认门到决策落定的毫秒数（自动放行为 0） */
  elapsedMs: number;
}

/** 全局放行（Accept All）开关的模式变更 */
export interface PermissionModeAuditEntry extends PermissionAuditEntryBase {
  type: "permission_mode";
  /** 变更后的开关状态 */
  acceptAll: boolean;
  /** 变更原因（用户选择 / 会话重置） */
  reason: string;
  /** 变更时仍挂起的请求数（`acceptAll: false` 的变更会把它们自动拒绍） */
  pendingAffected: number;
}

export type PermissionAuditEntry =
  | PermissionRequestAuditEntry
  | PermissionDecisionAuditEntry
  | PermissionModeAuditEntry;

/** 写入时的入参：会话归属、版本号由本模块补齐 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PermissionAuditEntryInput = DistributiveOmit<
  PermissionAuditEntry,
  "v" | "sessionId" | "sessionFile"
>;

/** 审计 sidecar 路径：`<session-file>.audit.jsonl` */
export function auditPathFor(sessionFile: string): string {
  return `${sessionFile}.audit.jsonl`;
}

// ---- 会话归属 ----

/** 当前会话的审计归属：会话 ID + transcript 文件路径 */
export interface AuditSessionRef {
  sessionId: string;
  /** 会话尚未落盘时为 null，此时审计条目无法归档（只告警） */
  sessionFile: string | null;
}

let sessionResolver: (() => AuditSessionRef | null) | null = null;

/**
 * 注册「当前会话」解析器（`server/agent.ts` 在模块加载时调用一次）。
 * 验证脚本可注册指向临时目录的解析器，从而不污染真实会话。
 */
export function setAuditSessionResolver(resolver: (() => AuditSessionRef | null) | null): void {
  sessionResolver = resolver;
}

/** 取当前会话归属；解析器缺失或抛错时退化为「无会话」。 */
export function currentAuditSession(): AuditSessionRef {
  try {
    return sessionResolver?.() ?? { sessionId: "", sessionFile: null };
  } catch {
    return { sessionId: "", sessionFile: null };
  }
}

// ---- 读写 ----

/**
 * 追加一条审计记录，返回补齐版本号与会话归属后的完整记录。
 * 无会话文件或写盘失败时返回 `null`（只告警，不抛错）。
 */
export function appendPermissionAudit(input: PermissionAuditEntryInput): PermissionAuditEntry | null {
  const ref = currentAuditSession();
  if (!ref.sessionFile) {
    console.warn(`[permission-audit] 当前无会话文件，${input.type}(${input.decisionId}) 未落盘`);
    return null;
  }
  const entry = {
    ...input,
    v: PERMISSION_AUDIT_VERSION,
    sessionId: ref.sessionId,
    sessionFile: ref.sessionFile,
  } as PermissionAuditEntry;
  const path = auditPathFor(ref.sessionFile);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error(`[permission-audit] 写入 ${path} 失败:`, err);
    return null;
  }
  return entry;
}

/**
 * 解析单行审计记录。坏行（写入被截断、手工编辑过）返回 null 而不是抛错：
 * 一行坏掉不应该让整份审计日志读不出来。
 */
export function parsePermissionAuditLine(line: string): PermissionAuditEntry | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<PermissionAuditEntry>;
    if (typeof parsed.type !== "string" || typeof parsed.decisionId !== "string") return null;
    return parsed as PermissionAuditEntry;
  } catch {
    return null;
  }
}

/** 读回某会话的全部审计记录（文件不存在返回空数组，坏行跳过）。 */
export function readPermissionAudit(sessionFile: string): PermissionAuditEntry[] {
  const path = auditPathFor(sessionFile);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map(parsePermissionAuditLine)
      .filter((e): e is PermissionAuditEntry => e !== null);
  } catch (err) {
    console.error(`[permission-audit] 读取 ${path} 失败:`, err);
    return [];
  }
}

/** 删除某会话的审计 sidecar（`deleteSession()` 调用）。返回是否真的删掉了文件。 */
export function deletePermissionAudit(sessionFile: string): boolean {
  const path = auditPathFor(sessionFile);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

if (process.env.NODE_ENV !== "production") {
  // 自检：sidecar 命名与单行解析（纯函数，不碰文件系统）。
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  assert(auditPathFor("/tmp/s/a.jsonl") === "/tmp/s/a.jsonl.audit.jsonl", "audit sidecar naming");
  assert(parsePermissionAuditLine("") === null, "empty line skipped");
  assert(parsePermissionAuditLine("{ not json") === null, "broken line skipped");
  assert(parsePermissionAuditLine('{"type":"permission_mode"}') === null, "entry without decisionId rejected");
  const line = JSON.stringify({ type: "permission_decision", at: "2026-10-30T00:00:00.000Z", decisionId: "pd-1", decision: "allow", command: "ls", source: "user", elapsedMs: 3, v: 1, sessionId: "s", sessionFile: "/tmp/s/a.jsonl" });
  assert(parsePermissionAuditLine(line)?.type === "permission_decision", "valid line parsed");
  assert(currentAuditSession().sessionFile === null, "no resolver -> no session file");
}
