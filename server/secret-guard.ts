/**
 * X34 秘密结构性路由（后端守卫）。
 *
 * 动机：用户在对话里让 agent 加数据源时，含密码的连接串会随 prompt 发给大模型
 * （`docs/tasks/X34-onboarding-gui/design.md` §4/§8.3）。本模块把「凭据只走表单」
 * 从提示（软约束）变成结构约束（硬拦截）：
 *   - {@link detectSecretLeaks}：识别连接串（`scheme://user:pass@host`，密码段
 *     含 URL-encoded 形态）与明文密码赋值形态（`password=...` / `--password ...` /
 *     `password: ...` / JSON `"password": "..."` / 中文「密码是 ...」），返回
 *     类别与位置，**不返回秘密全文**（只回显脱敏片段）；
 *   - {@link redactSecrets}：命中片段替换为 `[REDACTED]`，供一切必须留痕/日志的
 *     场合使用；
 *   - 拦截留痕：`<session-file>.secret-guard.jsonl` sidecar（permission-audit 同款
 *     append-only 模式），只记 sessionId/时间/类别/内容 SHA-256，**绝不含明文**。
 *
 * 误伤权衡（design.md 遗留问题 2 的 P1a 裁决）：宁可误拦不可漏拦；拦截语义是
 * 「拒绝执行 + 可读引导」（secret_redirect）而非静默丢弃。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { WSServerMessage } from "../src/types/ws-protocol.js";

// ---- 检测 ----

/** 命中类别：连接串 / 明文密码赋值 */
export type SecretLeakCategory = "connection_string" | "password";

/** 一次命中：类别 + 位置 + 脱敏回显片段（**绝不含秘密明文**） */
export interface SecretLeakMatch {
  category: SecretLeakCategory;
  /** 命中片段在原文中的起点 */
  offset: number;
  /** 命中片段长度（span 与 `redactSecrets` 的替换区一致） */
  length: number;
  /** 脱敏片段（秘密值已替换为 `[REDACTED]`，仅用于回显提示） */
  snippet: string;
}

const REDACTED = "[REDACTED]";
/** 脱敏回显片段最大长度（超出截断加省略号） */
const SNIPPET_MAX = 60;
/** secret_redirect 中最多回显的脱敏片段数 */
const MAX_REDIRECT_SNIPPETS = 3;

/**
 * 密码值形态：引号串优先（含转义），否则连续非空白/非句读字符。
 * 刻意宽（宁可多吞）：span 越宽 `redactSecrets` 删得越干净，误吞只影响回显美观。
 */
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s<>，。；、,;]+)`;

/** 密码键名（赋值形态 ②）：password / passwd / pwd，允许 `--`、引号键名与 = / : / ： 分隔 */
const PASSWORD_KEY = String.raw`(?:--)?["']?(?:password|passwd|pwd)["']?\s*[:=：]\s*`;

/** 中文明文密码形态：「密码是 xxx」「密码：xxx」「密码=xxx」 */
const PASSWORD_CN_KEY = String.raw`密码\s*(?:是|为|[:=：])\s*`;

function truncateSnippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/**
 * 识别 content 中的秘密形态（纯函数，可直接断言）。
 *
 * 覆盖形态（宁可误拦不可漏拦）：
 *   ① 连接串 `scheme://user:pass@host`（scheme 任意，mysql/postgresql/duckdb/
 *      mongodb/redis/sqlserver/oracle 等全覆盖；密码段含 URL-encoded 形态也命中）；
 *   ② 明文密码赋值：`password=...`、`--password ...`、`password: ...`、
 *      JSON `"password": "..."`、中文「密码是 ...」（含 passwd/pwd 键名与
 *      `密码：`/`密码=` 中文变体）。
 *
 * 返回按 offset 升序、互不重叠的命中列表；重叠时保留起点更早/片段更长者。
 */
export function detectSecretLeaks(content: string): SecretLeakMatch[] {
  const found: SecretLeakMatch[] = [];
  const push = (category: SecretLeakCategory, m: RegExpMatchArray, snippet: string) => {
    found.push({
      category,
      offset: m.index ?? 0,
      length: m[0].length,
      snippet: truncateSnippet(snippet),
    });
  };

  // ① 连接串 scheme://user:pass@host（rest 组收 host:port/db?params，尾部句读不入 span）。
  // user/pass 段类宽（含 / 与 URL-encoded 字符）：宁可误拦不可漏拦；duckdb://D:/... 等
  // 无密码路径因缺少 `user:pass@` 结构天然不命中。
  const connRe = new RegExp(
    String.raw`\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@'"` + "`" + String.raw`<>]+:)([^\s@'"` + "`" + String.raw`<>]+)(@[^\s'"` + "`" + String.raw`<>]*[^\s'"` + "`" + String.raw`<>,.;:!?，。；、）)\]}>》」』])`,
    "g",
  );
  for (const m of content.matchAll(connRe)) {
    const prefix = m[1] ?? "";
    const tail = m[3] ?? "";
    push("connection_string", m, `${prefix}${REDACTED}${tail}`);
  }

  // ② 明文密码赋值形态（同一段文本多形态命中时由重叠归并去重）
  const kvRe = new RegExp(`(${PASSWORD_KEY})(${VALUE})`, "gi");
  for (const m of content.matchAll(kvRe)) {
    push("password", m, `${m[1] ?? ""}${REDACTED}`);
  }

  // `--password <value>`（空格形态；`--password=...` 已被 KV 形态覆盖）
  const cliRe = new RegExp(`((?:--)(?:password|passwd|pwd)\\s+)(${VALUE})`, "gi");
  for (const m of content.matchAll(cliRe)) {
    push("password", m, `${m[1] ?? ""}${REDACTED}`);
  }

  const cnRe = new RegExp(`(${PASSWORD_CN_KEY})(${VALUE})`, "g");
  for (const m of content.matchAll(cnRe)) {
    push("password", m, `${m[1] ?? ""}${REDACTED}`);
  }

  // 归并：offset 升序、同起点长者优先，剔除重叠片段
  found.sort((a, b) => a.offset - b.offset || b.length - a.length);
  const merged: SecretLeakMatch[] = [];
  let end = -1;
  for (const m of found) {
    if (m.offset >= end) {
      merged.push(m);
      end = m.offset + m.length;
    }
  }
  return merged;
}

/**
 * 命中片段替换为 `[REDACTED]`（纯函数）。供一切必须留痕/日志的场合使用；
 * 无命中时原样返回。
 */
export function redactSecrets(content: string): string {
  const matches = detectSecretLeaks(content);
  if (matches.length === 0) return content;
  let out = content;
  for (const m of [...matches].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, m.offset) + REDACTED + out.slice(m.offset + m.length);
  }
  return out;
}

/** 日志脱敏出口：任意日志值安全序列化为字符串后过 `redactSecrets`（纯函数）。 */
export function redactForLog(value: unknown): string {
  if (typeof value === "string") return redactSecrets(value);
  try {
    return redactSecrets(JSON.stringify(value) ?? String(value));
  } catch {
    return "[unserializable]";
  }
}

// ---- secret_redirect 消息（microcopy 为一等对象，面向非技术用户） ----

/**
 * 组装拦截回执（纯函数）。文案三段：为什么拦（凭据会发给大模型）→ 正确路径
 * （数据源管理表单，凭据加密存本机、不发往大模型）→ 脱敏片段提示。
 */
export function buildSecretRedirect(
  matches: SecretLeakMatch[],
): Extract<WSServerMessage, { type: "secret_redirect" }> {
  const categories = [...new Set(matches.map((m) => m.category))];
  const hasUri = categories.includes("connection_string");
  const hasPassword = categories.includes("password");
  let found: string;
  if (hasUri && hasPassword) {
    found = "这条消息里包含数据库连接地址和明文密码";
  } else if (hasUri) {
    found = "这条消息里包含带账号密码的数据库连接地址";
  } else {
    found = "这条消息里包含明文密码";
  }
  return {
    type: "secret_redirect",
    message:
      `${found}，已经拦下，没有发给大模型。` +
      "\n密码一旦贴进对话，就会被发送给大模型，可能被记录或泄露。" +
      "\n请改用「数据源管理」表单添加数据源：密码只会加密保存在你自己的电脑上，" +
      "绝不会发给大模型。填好后直接继续提问即可，提问时不需要再带密码。",
    categories,
    redactedSnippets: matches.slice(0, MAX_REDIRECT_SNIPPETS).map((m) => m.snippet),
  };
}

// ---- 拦截留痕（sidecar JSONL，append-only，permission-audit 同款模式） ----

/** 拦截留痕记录结构版本；字段增删时递增 */
export const SECRET_GUARD_AUDIT_VERSION = 1;

/** 被拦截的入口（均是进入 LLM 上下文的用户消息通道） */
export type SecretGuardEntryKind = "prompt" | "steer";

/**
 * 拦截审计条目：只记类别与内容哈希，**绝不含秘密明文**（内容本身也不落盘，
 * 只留 SHA-256 供事后核对同一内容是否重复出现）。
 */
export interface SecretGuardAuditEntry {
  v: number;
  /** ISO 8601 时间戳（服务端时钟） */
  at: string;
  sessionId: string;
  sessionFile: string;
  kind: SecretGuardEntryKind;
  categories: SecretLeakCategory[];
  /** 被拦截内容的 SHA-256（hex） */
  contentSha256: string;
}

/** 拦截留痕 sidecar 路径：`<session-file>.secret-guard.jsonl` */
export function secretGuardAuditPathFor(sessionFile: string): string {
  return `${sessionFile}.secret-guard.jsonl`;
}

/** 由拦截事件组装审计条目（纯函数，可断言；哈希不含明文） */
export function buildSecretGuardAuditEntry(input: {
  sessionId: string;
  sessionFile: string;
  kind: SecretGuardEntryKind;
  content: string;
  matches: SecretLeakMatch[];
}): SecretGuardAuditEntry {
  return {
    v: SECRET_GUARD_AUDIT_VERSION,
    at: new Date().toISOString(),
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    kind: input.kind,
    categories: [...new Set(input.matches.map((m) => m.category))],
    contentSha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
  };
}

/**
 * 追加一条拦截留痕（只追加、不回改；写失败只告警不抛错，绝不阻断拦截本身）。
 * sessionFile 为空（会话尚未落盘）时跳过留痕，返回 null。
 */
export function recordSecretGuardAudit(input: {
  sessionId: string;
  sessionFile: string | null;
  kind: SecretGuardEntryKind;
  content: string;
  matches: SecretLeakMatch[];
}): SecretGuardAuditEntry | null {
  if (!input.sessionFile) {
    console.warn("[secret-guard] 当前无会话文件，拦截留痕未落盘");
    return null;
  }
  const entry = buildSecretGuardAuditEntry({ ...input, sessionFile: input.sessionFile });
  const path = secretGuardAuditPathFor(input.sessionFile);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.error(`[secret-guard] 写入 ${path} 失败:`, err);
    return null;
  }
  return entry;
}

/** 读回某会话的全部拦截留痕（文件不存在返回空数组，坏行跳过）。 */
export function readSecretGuardAudit(sessionFile: string): SecretGuardAuditEntry[] {
  const path = secretGuardAuditPathFor(sessionFile);
  if (!existsSync(path)) return [];
  try {
    const entries: SecretGuardAuditEntry[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        entries.push(JSON.parse(text) as SecretGuardAuditEntry);
      } catch {
        // 坏行跳过：一行坏掉不应让整份留痕读不出来
      }
    }
    return entries;
  } catch (err) {
    console.error(`[secret-guard] 读取 ${path} 失败:`, err);
    return [];
  }
}

/** 删除某会话的拦截留痕 sidecar（`deleteSession()` 调用）。返回是否真的删掉了文件。 */
export function deleteSecretGuardAudit(sessionFile: string): boolean {
  const path = secretGuardAuditPathFor(sessionFile);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
