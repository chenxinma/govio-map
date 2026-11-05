import { SessionManager, type SessionEntry, type SessionMessageEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { deletePermissionAudit } from "./permission-audit.js";
import { deleteInjectionTrace } from "./prompt-injection.js";

export function getSessionDir(): string {
  return resolvePath(process.cwd(), ".govio", "sessions");
}

export interface DisplayToolCall {
  toolName: string;
  success?: boolean;
  /** 工具入参（pi transcript toolCall block 的 arguments），供前端 ToolRow 展开查看 */
  args?: unknown;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: DisplayToolCall[];
  referencedNodes?: Array<{ nodeId: string; label: string; type: string; data?: string | null }>;
}

export interface SessionListItem {
  id: string;
  path: string;
  name: string | null;
  preview: string;
  messageCount: number;
  modified: string;
}

export async function listSessions(): Promise<SessionListItem[]> {
  const dir = getSessionDir();
  if (!existsSync(dir)) return [];
  const infos: SessionInfo[] = await SessionManager.list(process.cwd(), dir);
  return infos
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .map((s) => ({
      id: s.id,
      path: s.path,
      name: s.name ?? null,
      preview: (s.firstMessage || "").slice(0, 100),
      messageCount: s.messageCount,
      modified: s.modified.toISOString(),
    }));
}

/**
 * Validate a client-supplied session path: must be a .jsonl file inside the
 * session directory. Returns the resolved path or throws.
 */
export function assertValidSessionPath(path: string): string {
  const dir = getSessionDir();
  const resolved = resolvePath(path);
  if (!resolved.startsWith(dir + sep) || !resolved.endsWith(".jsonl")) {
    throw new Error(`invalid session path: ${path}`);
  }
  return resolved;
}

export function deleteSession(path: string): void {
  const resolved = assertValidSessionPath(path);
  if (existsSync(resolved)) unlinkSync(resolved);
  const canvas = canvasPathFor(resolved);
  if (existsSync(canvas)) unlinkSync(canvas);
  // 权限审计 / 注入留痕 sidecar 与会话同生命周期：会话删了，记录一并删。
  deletePermissionAudit(resolved);
  deleteInjectionTrace(resolved);
}

// ---- canvas sidecar ----

/** 画布 sidecar 路径；同目录下还有权限审计 sidecar（`permission-audit.ts` 的 `auditPathFor`） */
export function canvasPathFor(sessionFile: string): string {
  return sessionFile + ".canvas.json";
}

export function saveCanvas(sessionFile: string, nodes: unknown, edges: unknown): void {
  writeFileSync(canvasPathFor(sessionFile), JSON.stringify({ nodes, edges }));
}

export function loadCanvas(sessionFile: string): { nodes: unknown[]; edges: unknown[] } | null {
  const p = canvasPathFor(sessionFile);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (!Array.isArray(data?.nodes) || !Array.isArray(data?.edges)) return null;
    return data;
  } catch {
    return null;
  }
}

// ---- transcript ----

/**
 * Parse the `REF:[{"label": "data"},...]\n` prefix produced by makePrompt(),
 * plus the optional `CTX:<json>\n` 语义上下文注入行（T2.1，随消息留痕但不上屏）。
 */
function parseRefPrefix(text: string): { content: string; referencedNodes: DisplayMessage["referencedNodes"] } {
  let rest = text;
  let referencedNodes: DisplayMessage["referencedNodes"] = undefined;
  const match = /^REF:\[([\s\S]*?)\]\n/.exec(rest);
  if (match) {
    // Original data values may contain unescaped quotes, so only labels are recovered.
    const refs: NonNullable<DisplayMessage["referencedNodes"]> = [];
    const re = /\{"([^"]*)":/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(match[1])) !== null) {
      refs.push({ nodeId: `ref-${i++}`, label: m[1], type: "", data: null });
    }
    if (refs.length > 0) referencedNodes = refs;
    rest = rest.slice(match[0].length);
  }
  // CTX 注入行为单行 JSON（不含换行）；无 REF 时（问题实体命中注入）也可能出现在开头。
  if (rest.startsWith("CTX:")) {
    const nl = rest.indexOf("\n");
    rest = nl >= 0 ? rest.slice(nl + 1) : "";
  }
  return { content: rest, referencedNodes };
}

interface Round {
  firstEntryId: string;
  messages: DisplayMessage[];
}

/** Convert leaf-path session entries into display messages, grouped into rounds. */
function buildRounds(entries: SessionEntry[]): Round[] {
  const rounds: Round[] = [];
  const toolIndex = new Map<string, { tools: DisplayToolCall[]; idx: number }>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = (entry as SessionMessageEntry).message as {
      role: string;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
    };

    if (m.role === "user") {
      const raw = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
          : "";
      const { content, referencedNodes } = parseRefPrefix(raw);
      if (!content && !referencedNodes) continue;
      const msg: DisplayMessage = { id: entry.id, role: "user", content };
      if (referencedNodes) msg.referencedNodes = referencedNodes;
      rounds.push({ firstEntryId: entry.id, messages: [msg] });
    } else if (m.role === "assistant") {
      let text = "";
      let thinking = "";
      const tools: DisplayToolCall[] = [];
      for (const b of (m.content ?? []) as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; args?: unknown; input?: unknown }>) {
        if (b.type === "text") text += b.text ?? "";
        else if (b.type === "thinking") thinking += b.thinking ?? "";
        else if (b.type === "toolCall" && b.id && b.name) {
          toolIndex.set(b.id, { tools, idx: tools.length });
          const call: DisplayToolCall = { toolName: b.name };
          // pi transcript 结构为 {type:"toolCall", id, name, arguments}；
          // 兼容 args/input 变体，取不到留空（前端降级为无参数信息）。
          const args = b.arguments ?? b.args ?? b.input;
          if (args !== undefined) call.args = args;
          tools.push(call);
        }
      }
      if (!text && !thinking && tools.length === 0) continue;
      const msg: DisplayMessage = { id: entry.id, role: "assistant", content: text };
      if (thinking) msg.thinking = thinking;
      if (tools.length > 0) msg.tools = tools;
      if (rounds.length === 0) rounds.push({ firstEntryId: entry.id, messages: [] });
      rounds[rounds.length - 1].messages.push(msg);
    } else if (m.role === "toolResult" && m.toolCallId) {
      const rec = toolIndex.get(m.toolCallId);
      if (rec) rec.tools[rec.idx].success = !m.isError;
    }
  }
  return rounds;
}

export interface TranscriptPage {
  messages: DisplayMessage[];
  hasMore: boolean;
  oldestEntryId: string | null;
}

/** Paginate rounds from newest to oldest. `beforeEntryId` = first round of a previous page. */
export function buildTranscript(
  entries: SessionEntry[],
  opts: { beforeEntryId?: string | null; rounds?: number } = {},
): TranscriptPage {
  const rounds = buildRounds(entries);
  const per = opts.rounds ?? 10;
  let end = rounds.length;
  if (opts.beforeEntryId) {
    const i = rounds.findIndex((r) => r.firstEntryId === opts.beforeEntryId);
    if (i <= 0) return { messages: [], hasMore: false, oldestEntryId: opts.beforeEntryId };
    end = i;
  }
  const start = Math.max(0, end - per);
  const slice = rounds.slice(start, end);
  return {
    messages: slice.flatMap((r) => r.messages),
    hasMore: start > 0,
    oldestEntryId: slice.length > 0 ? slice[0].firstEntryId : null,
  };
}

if (process.env.NODE_ENV !== "production") {
  // Minimal self-check for round grouping + pagination.
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const entry = (id: string, message: unknown): SessionEntry =>
    ({ type: "message", id, parentId: null, timestamp: "", message } as unknown as SessionEntry);
  const entries: SessionEntry[] = [];
  for (let i = 0; i < 12; i++) {
    entries.push(entry(`u${i}`, { role: "user", content: `question ${i}` }));
    entries.push(entry(`a${i}`, { role: "assistant", content: [{ type: "text", text: `answer ${i}` }, { type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `echo ${i}` } }] }));
    entries.push(entry(`r${i}`, { role: "toolResult", toolCallId: `t${i}`, isError: false }));
  }
  const page1 = buildTranscript(entries, { rounds: 10 });
  assert(page1.messages.length === 20, "page1 should hold 10 rounds x2 messages");
  assert(page1.hasMore, "page1 hasMore");
  assert(page1.messages[0].content === "question 2", "page1 starts at round 2");
  assert(page1.messages[1].tools?.[0].success === true, "tool success backfilled");
  assert((page1.messages[1].tools?.[0].args as { command?: string })?.command === "echo 2", "tool args parsed");
  const page2 = buildTranscript(entries, { rounds: 10, beforeEntryId: page1.oldestEntryId });
  assert(page2.messages.length === 4 && !page2.hasMore, "page2 holds rounds 0-1");
  const ref = buildTranscript([entry("x", { role: "user", content: 'REF:[{"tbl_a": "data"}, {"tbl_b": "d2"}]\nreal question' })]);
  assert(ref.messages[0].content === "real question", "REF prefix stripped");
  assert(ref.messages[0].referencedNodes?.length === 2, "REF labels parsed");
  const ctx1 = buildTranscript([entry("y", { role: "user", content: 'REF:[{"tbl_a": "data"}]\nCTX:{"tables":[]}\nreal question' })]);
  assert(ctx1.messages[0].content === "real question", "CTX prefix stripped after REF");
  assert(ctx1.messages[0].referencedNodes?.length === 1, "REF labels parsed with CTX");
  const ctx2 = buildTranscript([entry("z", { role: "user", content: 'CTX:{"tables":[]}\nplain question' })]);
  assert(ctx2.messages[0].content === "plain question", "CTX-only prefix stripped");
  assert(ctx2.messages[0].referencedNodes === undefined, "CTX-only has no refs");
}
