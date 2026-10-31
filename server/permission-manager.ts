import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendPermissionAudit, type PermissionDecisionSource } from "./permission-audit.js";

export type PermissionDecision = "allow" | "deny" | "edit";

export interface PermissionRequest {
  /** 前端回传的关联令牌；与审计日志/Manifest 里的 `decisionId` 同值 */
  requestId: string;
  command: string;
}

export interface PermissionResponse {
  decision: PermissionDecision;
  /**
   * 决策 ID（同一次确认只有一个标识：请求侧叫 `requestId`，审计与 Manifest 侧叫
   * `decisionId`）。全局放行下自动允许的请求没有前端交互，但一样有决策 ID。
   */
  decisionId: string;
  editedCommand?: string;
  reason?: string;
}

/** `resolve()` 的入参：决策 ID 由 manager 从挂起记录里补，调用方无法伪造 */
export type PermissionDecisionInput = Omit<PermissionResponse, "decisionId">;

interface PendingEntry {
  decisionId: string;
  command: string;
  /** pi 的工具调用 ID：同一次调用的 tool_call / tool_result 共享，是最精确的关联键 */
  toolCallId?: string;
  requestedAt: number;
  resolve: (r: PermissionResponse) => void;
  timer: NodeJS.Timeout;
}

const TIMEOUT_MS = 5 * 60 * 1000;

/** 决策索引（命令 / toolCallId）的容量上限：超出按插入序淘汰最旧，防止长会话无限增长 */
const DECISION_INDEX_LIMIT = 200;

/** 决策 ID 前缀：`pd-` = permission decision，`pm-` = permission mode（便于日志检索） */
function newDecisionId(): string {
  return `pd-${randomUUID()}`;
}

function newModeEventId(): string {
  return `pm-${randomUUID()}`;
}

/**
 * 命令归一化：只折叠空白。tool_call（确认）与 tool_result（建节点）之间唯一稳定的
 * 关联键就是命令文本，而 agent 重发同一条命令时换行/缩进可能有差异。
 */
function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

export interface PermissionManagerOptions {
  /** 无人响应时自动拒绝的等待时长（毫秒）；默认 5 分钟，验证脚本用短超时 */
  timeoutMs?: number;
}

/**
 * 取数确认门 + 审计留痕（ROADMAP Phase 1 / KR3）。
 *
 * 每次 `requestPermission()` 都会写两条审计记录（请求 + 决策），放行模式开关变更
 * 再写一条模式记录；记录追加到 `<session-file>.audit.jsonl`（见 `permission-audit.ts`）。
 * 允许/修改的决策同时进入「toolCallId / 命令 → 决策 ID」索引，`observe load` 建节点时
 * 用它把 `decisionId` 写进 Manifest，实现「这个结果是谁批准的」可回查。
 */
export class PermissionManager {
  private acceptAll = false;
  private pending = new Map<string, PendingEntry>();
  private emitter = new EventEmitter();
  private readonly timeoutMs: number;
  /** 归一化命令 → 最近一次会导致执行的决策（插入序，末尾最新） */
  private decisionsByCommand = new Map<string, { decisionId: string; decision: PermissionDecision }>();
  /** toolCallId → 决策 ID（同一次工具调用的确认与结果精确对应） */
  private decisionsByToolCall = new Map<string, string>();

  constructor(options: PermissionManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  /** 全局放行开关。状态真的变了才记一条模式变更事件（重复点击不产生噪音）。 */
  setAcceptAll(value: boolean): void {
    if (this.acceptAll === value) return;
    this.acceptAll = value;
    this.auditMode(
      value,
      value ? "用户选择本会话内全部放行（Accept All）" : "全局放行已关闭",
      this.pending.size,
    );
  }

  isAcceptAll(): boolean {
    return this.acceptAll;
  }

  /** 清空/切换会话：放行模式随会话失效，挂起的请求全部拒绝（审计来源记为 `reset`）。 */
  clearAll(): void {
    const wasAcceptAll = this.acceptAll;
    const pendingAffected = this.pending.size;
    this.acceptAll = false;
    if (wasAcceptAll) {
      this.auditMode(false, "会话重置：全局放行随会话一起失效", pendingAffected);
    }
    this.denyPending("会话已重置", "reset");
    // 决策索引也随会话失效：否则切会话后命令文本兜底会把新会话的执行错绑到
    // 旧会话的 decisionId（交付报告附录 B 里查无此 ID）。
    this.decisionsByCommand.clear();
    this.decisionsByToolCall.clear();
  }

  denyPending(reason: string, source: PermissionDecisionSource = "abort"): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.auditDecision(entry, { decision: "deny", reason }, source);
      entry.resolve({ decision: "deny", decisionId: entry.decisionId, reason });
    }
    this.pending.clear();
  }

  requestPermission(command: string, toolCallId?: string): Promise<PermissionResponse> {
    const decisionId = newDecisionId();
    if (this.acceptAll) {
      // 全局放行同样要留痕：这是「该命令在放行模式下被执行过」的唯一记录。
      const requestedAt = Date.now();
      this.auditRequest(decisionId, command, "accept-all");
      // 没有等人工响应这一步，耗时恒为 0（否则会量到写审计文件本身的耗时）。
      this.auditDecision({ decisionId, command, requestedAt }, { decision: "allow" }, "accept-all", 0);
      this.indexDecision(command, decisionId, "allow", toolCallId);
      return Promise.resolve({ decision: "allow", decisionId });
    }
    return new Promise<PermissionResponse>((resolve) => {
      const requestedAt = Date.now();
      const timer = setTimeout(() => {
        const entry = this.pending.get(decisionId);
        if (!entry) return;
        this.pending.delete(decisionId);
        const reason = `权限请求超时（${Math.round(this.timeoutMs / 60_000)} 分钟未响应）`;
        this.auditDecision(entry, { decision: "deny", reason }, "timeout");
        resolve({ decision: "deny", decisionId, reason });
      }, this.timeoutMs);

      this.pending.set(decisionId, { decisionId, command, requestedAt, resolve, timer, ...(toolCallId ? { toolCallId } : {}) });
      this.auditRequest(decisionId, command, "ask");
      this.emitter.emit("request", { requestId: decisionId, command } satisfies PermissionRequest);
    });
  }

  resolve(requestId: string, response: PermissionDecisionInput): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // 决策晚于超时/中止/重置到达：不再影响执行，但要留痕（见 auditLateDecision）。
      this.auditLateDecision(requestId, response);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.auditDecision(entry, response, "user");
    // 只有「会导致执行」的决策才进索引：allow 是原命令（带上 toolCallId，结果事件能精确对回），
    // edit 是改后的命令（原调用已被 block、不会产生结果；agent 随后用改后的命令重发，
    // 若重发命令不再触发确认门，节点就直接关联这次 edit 决策）。
    if (response.decision === "allow") {
      this.indexDecision(entry.command, entry.decisionId, "allow", entry.toolCallId);
    } else if (response.decision === "edit" && response.editedCommand) {
      this.indexDecision(response.editedCommand, entry.decisionId, "edit");
    }
    entry.resolve({ ...response, decisionId: entry.decisionId });
  }

  /**
   * 查「这次执行对应哪一次确认门的决策」，没有则返回 null。
   * 优先用 pi 的 `toolCallId`（同一次调用的 tool_call / tool_result 共享，精确一对）；
   * 退回命令文本（归一化后比对），覆盖 edit 后重发的命令——它没有自己的确认记录。
   */
  decisionIdForExecution(command: string, toolCallId?: string): string | null {
    if (toolCallId) {
      const byCall = this.decisionsByToolCall.get(toolCallId);
      if (byCall) return byCall;
    }
    return this.decisionsByCommand.get(normalizeCommand(command))?.decisionId ?? null;
  }

  onRequest(callback: (req: PermissionRequest) => void): () => void {
    this.emitter.on("request", callback);
    return () => {
      this.emitter.off("request", callback);
    };
  }

  // ---- 审计写入（内部） ----

  private indexDecision(
    command: string,
    decisionId: string,
    decision: PermissionDecision,
    toolCallId?: string,
  ): void {
    if (toolCallId) this.remember(this.decisionsByToolCall, toolCallId, decisionId);
    const key = normalizeCommand(command);
    if (key) this.remember(this.decisionsByCommand, key, { decisionId, decision });
  }

  /** 写入索引并封顶：先删后设维持插入序，超限时淘汰最旧的一条。 */
  private remember<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > DECISION_INDEX_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private auditRequest(decisionId: string, command: string, gate: "ask" | "accept-all"): void {
    // 本命令正是上一次 edit 决策改出来的：记下来源决策，形成「改命令 → 重新确认」的链。
    const previous = this.decisionsByCommand.get(normalizeCommand(command));
    const followsDecisionId = previous && previous.decision === "edit" ? previous.decisionId : undefined;
    appendPermissionAudit({
      type: "permission_request",
      at: new Date().toISOString(),
      decisionId,
      command,
      gate,
      ...(followsDecisionId && followsDecisionId !== decisionId ? { followsDecisionId } : {}),
    });
  }

  private auditDecision(
    entry: { decisionId: string; command: string; requestedAt: number },
    response: PermissionDecisionInput,
    source: PermissionDecisionSource,
    elapsedMs = Math.max(0, Date.now() - entry.requestedAt),
  ): void {
    appendPermissionAudit({
      type: "permission_decision",
      at: new Date().toISOString(),
      decisionId: entry.decisionId,
      decision: response.decision,
      command: entry.command,
      ...(response.editedCommand ? { editedCommand: response.editedCommand } : {}),
      ...(response.reason ? { reason: response.reason } : {}),
      source,
      elapsedMs,
    });
  }

  private auditMode(acceptAll: boolean, reason: string, pendingAffected: number): void {
    appendPermissionAudit({
      type: "permission_mode",
      at: new Date().toISOString(),
      decisionId: newModeEventId(),
      acceptAll,
      reason,
      pendingAffected,
    });
  }

  /**
   * 决策晚于超时/中止/重置到达时补记一条「未生效」的决策记录。
   *
   * 原决策（timeout/abort/reset 的 deny）已经生效并记账，这条迟到的用户决策不会
   * 改变执行结果，但必须留痕——否则「用户点了却没反应」在审计里查无此事。
   * 只接受 `pd-` 形态的 decisionId，避免伪造/垃圾 requestId 灌日志；命令原文此时
   * 已不在挂起表里，如实记为空串。静默、不抛错（appendPermissionAudit 自身兜底）。
   */
  private auditLateDecision(requestId: string, response: PermissionDecisionInput): void {
    if (!requestId.startsWith("pd-")) return;
    appendPermissionAudit({
      type: "permission_decision",
      at: new Date().toISOString(),
      decisionId: requestId,
      decision: response.decision,
      command: "",
      ...(response.editedCommand ? { editedCommand: response.editedCommand } : {}),
      reason: "决策晚于超时，未生效",
      source: "user",
      elapsedMs: 0,
    });
  }
}

export const permissionManager = new PermissionManager();
