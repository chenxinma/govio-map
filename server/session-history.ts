import { SessionManager, type SessionEntry, type SessionMessageEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";

export function getSessionDir(): string {
  return resolvePath(process.cwd(), ".govio", "sessions");
}

export interface DisplayToolCall {
  toolName: string;
  success?: boolean;
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

export function deleteSession(path: string): void {
  const dir = getSessionDir();
  const resolved = resolvePath(path);
  if (!resolved.startsWith(dir + sep) || !resolved.endsWith(".jsonl")) {
    throw new Error(`invalid session path: ${path}`);
  }
  if (existsSync(resolved)) unlinkSync(resolved);
  const canvas = canvasPathFor(resolved);
  if (existsSync(canvas)) unlinkSync(canvas);
}

// ---- canvas sidecar ----

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

/** Parse the `REF:[{"label": "data"},...]\n` prefix produced by makePrompt(). */
function parseRefPrefix(text: string): { content: string; referencedNodes: DisplayMessage["referencedNodes"] } {
  const match = /^REF:\[([\s\S]*?)\]\n/.exec(text);
  if (!match) return { content: text, referencedNodes: undefined };
  // Original data values may contain unescaped quotes, so only labels are recovered.
  const refs: NonNullable<DisplayMessage["referencedNodes"]> = [];
  const re = /\{"([^"]*)":/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(match[1])) !== null) {
    refs.push({ nodeId: `ref-${i++}`, label: m[1], type: "", data: null });
  }
  return { content: text.slice(match[0].length), referencedNodes: refs.length > 0 ? refs : undefined };
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
      for (const b of (m.content ?? []) as Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string }>) {
        if (b.type === "text") text += b.text ?? "";
        else if (b.type === "thinking") thinking += b.thinking ?? "";
        else if (b.type === "toolCall" && b.id && b.name) {
          toolIndex.set(b.id, { tools, idx: tools.length });
          tools.push({ toolName: b.name });
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
    entries.push(entry(`a${i}`, { role: "assistant", content: [{ type: "text", text: `answer ${i}` }, { type: "toolCall", id: `t${i}`, name: "bash" }] }));
    entries.push(entry(`r${i}`, { role: "toolResult", toolCallId: `t${i}`, isError: false }));
  }
  const page1 = buildTranscript(entries, { rounds: 10 });
  assert(page1.messages.length === 20, "page1 should hold 10 rounds x2 messages");
  assert(page1.hasMore, "page1 hasMore");
  assert(page1.messages[0].content === "question 2", "page1 starts at round 2");
  assert(page1.messages[1].tools?.[0].success === true, "tool success backfilled");
  const page2 = buildTranscript(entries, { rounds: 10, beforeEntryId: page1.oldestEntryId });
  assert(page2.messages.length === 4 && !page2.hasMore, "page2 holds rounds 0-1");
  const ref = buildTranscript([entry("x", { role: "user", content: 'REF:[{"tbl_a": "data"}, {"tbl_b": "d2"}]\nreal question' })]);
  assert(ref.messages[0].content === "real question", "REF prefix stripped");
  assert(ref.messages[0].referencedNodes?.length === 2, "REF labels parsed");
}
