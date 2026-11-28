/**
 * X34 验证脚本：秘密结构性路由——凭据零泄露（检测 / 脱敏 / 三通道拦截 / 凭据通道 / 日志 / 留痕）。
 *
 * 复跑：`npm run verify:secrets-isolation`（等价于 `npx tsx scripts/verify-secrets-isolation.ts`）
 *
 * 覆盖（对齐 task-plan X34 acceptance + P3 任务书 §4.1）：
 *  1. detectSecretLeaks 正样本全命中：各 scheme 连接串（mysql+pymysql/postgresql/duckdb/
 *     mongodb/redis/sqlserver/oracle）、URL-encoded 密码、`password=`/`--password`/`password:`/
 *     JSON `"password"`/中文「密码是/密码：」/`passwd`/`pwd`/全角冒号
 *  2. 负样本不误伤：无密码 duckdb 路径、无密码 user@host URL、普通中文提问、无凭据 SQL
 *  3. redactSecrets：替换 span 与 detect 一致、输出零明文；redactForLog 任意值安全
 *  4. 拦截行为：真实 `setupWebSocket` + stub session（registerHooks 注入 agent/graph-query 桩），
 *     prompt/steer/followUp 三通道命中不进 LLM（stub session 零调用）+ secret_redirect 回执；
 *     干净消息正对照（证明探针存活）
 *  5. 凭据通道不变量：假 exec 捕获 addDatasource/testDatasource，断言密码只经 stdin
 *     `opts.input`，file/args 永不含明文；错误回执经 redactSecrets 二次脱敏
 *  6. 零日志泄露：server/ 源码静态扫描（console.* 不得直写 msg.content/.password/opts.input）
 *     + 针对性正则断言 makePrompt / tool result / onboarding 日志行已脱敏
 *  7. 拦截留痕 sidecar 零明文（临时目录实测 recordSecretGuardAudit：只记哈希，读回/坏行/删除）
 *
 * 全程不调用真实 govio-cli / 模型 / 网络（CI 无 govio 环境）。任一断言失败退出码为 1。
 */
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket as WsClient } from "ws";
import {
  SECRET_GUARD_AUDIT_VERSION,
  buildSecretRedirect,
  deleteSecretGuardAudit,
  detectSecretLeaks,
  readSecretGuardAudit,
  recordSecretGuardAudit,
  redactForLog,
  redactSecrets,
  secretGuardAuditPathFor,
} from "../server/secret-guard.js";
import { addDatasource, testDatasource, type ExecFn, type ExecOptions, type ExecResult } from "../server/onboarding.js";

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

// ── 秘密样本（正样本共用的秘密值，各节断言其零泄露） ────────────────────────

const PW_URI = "Sup3rS3cret";
const PW_KV = "HrSecret2024";
const PW_CLI = "CliSecret1";
const PW_JSON = "JsonSecret9";
const PW_CN = "ZhongSecret1";
const PW_ALT = "AltSecret2";
const PW_URL_ENC = "p%40ss%3Aword";

/** [正样本, 期望类别, 秘密值] */
const POSITIVE_SAMPLES: [string, "connection_string" | "password", string][] = [
  [`mysql+pymysql://root:${PW_URI}@10.0.0.5:3306/sales`, "connection_string", PW_URI],
  [`postgresql://analytics:pg-pass-2024@db.example.com:5432/warehouse`, "connection_string", "pg-pass-2024"],
  [`duckdb://admin:duckpw@localhost/analysis`, "connection_string", "duckpw"],
  [`mongodb://mongo_user:m0ng0PW@cluster0.example.net:27017/app`, "connection_string", "m0ng0PW"],
  [`redis://cache_user:r3d1sPW@redis.example.com:6379/0`, "connection_string", "r3d1sPW"],
  [`sqlserver://sa:Ms-SQL-99@sql.example.com:1433/master`, "connection_string", "Ms-SQL-99"],
  [`oracle://ora_user:OraPw#1@ora.example.com:1521/ORCL`, "connection_string", "OraPw#1"],
  [`mysql://user:${PW_URL_ENC}@h.example.com:3306/db`, "connection_string", PW_URL_ENC],
  [`帮我把 password=${PW_KV} 的库加为数据源`, "password", PW_KV],
  [`govio-cli onboard --password ${PW_CLI}`, "password", PW_CLI],
  [`password: ${PW_KV}`, "password", PW_KV],
  [`{"password": "${PW_JSON}"}`, "password", PW_JSON],
  [`数据库的密码是 ${PW_CN}`, "password", PW_CN],
  [`密码：${PW_CN}`, "password", PW_CN],
  [`passwd=${PW_ALT}`, "password", PW_ALT],
  [`pwd=${PW_ALT}`, "password", PW_ALT],
  [`--passwd ${PW_CLI}`, "password", PW_CLI],
  [`password：${PW_KV}`, "password", PW_KV],
];

// ── A. detectSecretLeaks 正样本 ─────────────────────────────────────────────

console.log("\n[A] detectSecretLeaks 正样本（连接串 + 明文密码赋值全形态）");

for (const [sample, category, secret] of POSITIVE_SAMPLES) {
  const matches = detectSecretLeaks(sample);
  const hit = matches[0];
  check(
    `命中：${sample.slice(0, 46)}${sample.length > 46 ? "…" : ""}`,
    matches.length >= 1 && hit.category === category,
    `matches=${matches.length} category=${hit?.category}`,
  );
  check(
    `  秘密值落在命中 span 内且不外泄到 snippet：${secret.slice(0, 6)}…`,
    hit !== undefined && sample.slice(hit.offset, hit.offset + hit.length).includes(secret) && !hit.snippet.includes(secret),
  );
}

{
  const both = `mongodb://u:m0ng0PW@h:27017/a 另外 password=${PW_KV}`;
  const matches = detectSecretLeaks(both);
  check(
    "同一文本多形态命中按 offset 升序、互不重叠",
    matches.length === 2 && matches[0].category === "connection_string" && matches[1].category === "password"
      && matches[0].offset + matches[0].length <= matches[1].offset,
    `matches=${JSON.stringify(matches.map((m) => [m.category, m.offset, m.length]))}`,
  );
  const dup = `password=${PW_KV} password=${PW_KV}`;
  check("重复形态各自命中（互不吞并）", detectSecretLeaks(dup).length === 2);
}

// ── B. 负样本（不误伤） ─────────────────────────────────────────────────────

console.log("\n[B] detectSecretLeaks 负样本（无凭据不误伤）");

const NEGATIVE_SAMPLES: string[] = [
  "duckdb://D:/Work/data/sales.duckdb",
  "duckdb://D:/govio/ontology.lbdb",
  "mysql+pymysql://app@10.0.0.5:3306/sales",
  "帮我统计一下上个月各地区的销售额，按销售额降序",
  "SELECT region, SUM(amount) FROM orders WHERE dt >= '2024-01-01' GROUP BY region",
  "请把 password 字段留空，只填 URL 和数据源名称",
  "今天 10:30 开会，预算 3,000 元",
];

for (const sample of NEGATIVE_SAMPLES) {
  const matches = detectSecretLeaks(sample);
  check(`零命中：${sample.slice(0, 46)}${sample.length > 46 ? "…" : ""}`, matches.length === 0, JSON.stringify(matches));
  check(`  脱敏恒等：${sample.slice(0, 24)}…`, redactSecrets(sample) === sample);
}

// ── C. redactSecrets / redactForLog ─────────────────────────────────────────

console.log("\n[C] redactSecrets：替换 span 与 detect 一致、输出零明文");

for (const [sample, , secret] of POSITIVE_SAMPLES) {
  const matches = detectSecretLeaks(sample);
  const redacted = redactSecrets(sample);
  // 手工按 span 还原期望结果，验证「替换区 == detect 命中区」
  let expected = sample;
  for (const m of [...matches].sort((a, b) => b.offset - a.offset)) {
    expected = expected.slice(0, m.offset) + "[REDACTED]" + expected.slice(m.offset + m.length);
  }
  check(`span 替换一致：${secret.slice(0, 6)}…`, redacted === expected);
  check(`  脱敏后不含秘密子串：${secret.slice(0, 6)}…`, !redacted.includes(secret) && redacted.includes("[REDACTED]"));
  check(`  脱敏输出零残留命中`, detectSecretLeaks(redacted).every((m) => m.snippet.includes("[REDACTED]")));
}

{
  check("多命中一次全替换", redactSecrets(`password=${PW_KV} 密码是 ${PW_CN}`).split("[REDACTED]").length === 3);
  const strLog = redactForLog(`password=${PW_KV}`);
  check("redactForLog：字符串走脱敏（整段赋值形态替换为 [REDACTED]）", strLog === "[REDACTED]" && !strLog.includes(PW_KV));
  const obj = redactForLog({ url: "postgresql://u:pg-secret@h:5432/d", note: "ok" });
  check("redactForLog：对象序列化后脱敏", !obj.includes("pg-secret") && obj.includes("[REDACTED]"));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  check("redactForLog：不可序列化值安全降级", redactForLog(circular) === "[unserializable]");
}

// ── D. 拦截行为（stub session：三通道命中零调用 + secret_redirect 回执） ────

console.log("\n[D] 拦截行为（真实 ws-handler + stub session，prompt/steer/followUp 三通道）");

interface StubState {
  calls: { prompt: number; steer: number; followUp: number };
  sessionFile: string | null;
}

const stubState: StubState = ((globalThis as Record<string, unknown>).__x34SecretGuardStub ??= {
  calls: { prompt: 0, steer: 0, followUp: 0 },
  sessionFile: null,
}) as StubState;

const agentStubSrc = `
const S = globalThis.__x34SecretGuardStub;
const session = {
  sessionId: "sess-stub", isStreaming: false,
  subscribe: () => () => {},
  prompt: async () => { S.calls.prompt++; },
  steer: async () => { S.calls.steer++; return "queued"; },
  followUp: async () => { S.calls.followUp++; return "queued"; },
  abort: () => {}, clearQueue: () => ({ steering: [], followUp: [] }),
  getSteeringMessages: () => [], getFollowUpMessages: () => [],
  modelRuntime: { getModel: () => null }, setModel: async () => {}, model: undefined,
  thinkingLevel: "medium", setThinkingLevel: async () => {},
  sessionManager: { getSessionFile: () => S.sessionFile, getBranch: () => [] },
};
export const getOrCreateSession = async () => session;
export const openSessionFile = async () => session;
export const resetSession = () => {};
export const runGovioCli = async () => "[]";
`;
const graphStubSrc = `
export const runGraphQuery = async () => [];
export const prewarmGraphCache = async () => {};
`;

// registerHooks：把 ws-handler 的 agent 会话与 prompt-injection 的图谱执行器换成桩，
// 驱动真实 `setupWebSocket` 全链路（解析/拦截/审计/回执均为生产代码）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = String(context.parentURL ?? "");
    if (specifier === "./agent.js" && parent.includes("/server/ws-handler.")) {
      return { url: "data:text/javascript," + encodeURIComponent(agentStubSrc), shortCircuit: true };
    }
    if (specifier === "./graph-query.js" && parent.includes("/server/prompt-injection.")) {
      return { url: "data:text/javascript," + encodeURIComponent(graphStubSrc), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

{
  const sessionDir = mkdtempSync(join(tmpdir(), "govio-secrets-"));
  stubState.sessionFile = join(sessionDir, "2026-11-28T00-00-00-000Z_sess-stub.jsonl");
  writeFileSync(stubState.sessionFile, "");

  const { setupWebSocket } = await import("../server/ws-handler.js");
  const server = createServer();
  setupWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const client = new WsClient(`ws://127.0.0.1:${port}/ws`);
  const msgs: { type: string; [k: string]: unknown }[] = [];
  client.on("message", (data: Buffer) => msgs.push(JSON.parse(data.toString())));
  await new Promise((resolve) => client.on("open", resolve));

  const redirects = () => msgs.filter((m) => m.type === "secret_redirect");
  const send = (msg: Record<string, unknown>) => client.send(JSON.stringify(msg));

  // prompt 通道：连接串命中
  send({ type: "prompt", content: `帮我连上 mysql+pymysql://root:${PW_URI}@10.0.0.5:3306/sales`, clientMsgId: "c1" });
  await waitFor(() => redirects().length === 1);
  const r1 = redirects()[0];
  check("prompt 通道命中连接串 → secret_redirect 回执", r1 !== undefined);
  check(
    "secret_redirect 文案含可读引导（数据源表单 + 未发给大模型）",
    typeof r1?.message === "string" && r1.message.includes("没有发给大模型") && r1.message.includes("数据源管理"),
  );
  check(
    "secret_redirect 的 categories 含 connection_string",
    Array.isArray(r1?.categories) && (r1.categories as string[]).includes("connection_string"),
  );
  const snippets = (r1?.redactedSnippets ?? []) as string[];
  check(
    "redactedSnippets 仅含脱敏片段（[REDACTED]、零明文）",
    snippets.length >= 1 && snippets.every((s) => s.includes("[REDACTED]")) && snippets.every((s) => !s.includes(PW_URI)),
  );
  await new Promise((r) => setTimeout(r, 300));
  check(
    "prompt 拦截后 stub session 的 prompt/steer/followUp 零调用",
    stubState.calls.prompt === 0 && stubState.calls.steer === 0 && stubState.calls.followUp === 0,
    JSON.stringify(stubState.calls),
  );

  // steer 通道：password= 命中
  send({ type: "steer", content: `顺便把 password=${PW_KV} 也存上`, clientMsgId: "c2" });
  await waitFor(() => redirects().length === 2);
  check("steer 通道命中明文密码 → secret_redirect 回执", redirects().length === 2);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "steer 拦截后仍零调用",
    stubState.calls.prompt === 0 && stubState.calls.steer === 0 && stubState.calls.followUp === 0,
    JSON.stringify(stubState.calls),
  );

  // followUp 通道：中文「密码是」命中
  send({ type: "followUp", content: `对了，密码是 ${PW_CN}`, clientMsgId: "c3" });
  await waitFor(() => redirects().length === 3);
  check("followUp 通道命中中文密码 → secret_redirect 回执", redirects().length === 3);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "followUp 拦截后仍零调用（三通道全部不进 LLM）",
    stubState.calls.prompt === 0 && stubState.calls.steer === 0 && stubState.calls.followUp === 0,
    JSON.stringify(stubState.calls),
  );

  // 正对照：干净消息必须抵达 session（证明探针/链路存活）
  send({ type: "steer", content: "继续按刚才的口径出结果", clientMsgId: "c4" });
  await waitFor(() => stubState.calls.steer === 1);
  check("正对照：干净 steer 进入 session.steer（拦截不是无差别丢弃）", stubState.calls.steer === 1);
  send({ type: "prompt", content: "统计订单金额", clientMsgId: "c5" });
  await waitFor(() => stubState.calls.prompt === 1);
  check("正对照：干净 prompt 进入 session.prompt", stubState.calls.prompt === 1);

  // 拦截留痕 sidecar（真实拦截路径落盘）
  const entries = readSecretGuardAudit(stubState.sessionFile);
  check("拦截留痕恰 3 条且 kind 覆盖 prompt/steer/followUp", entries.length === 3
    && ["prompt", "steer", "followUp"].every((k) => entries.some((e) => e.kind === k)),
    `entries=${entries.length}`);
  const contents = [
    `帮我连上 mysql+pymysql://root:${PW_URI}@10.0.0.5:3306/sales`,
    `顺便把 password=${PW_KV} 也存上`,
    `对了，密码是 ${PW_CN}`,
  ];
  check(
    "每条留痕 contentSha256 与被拦内容哈希一致（只记哈希不记明文）",
    entries.every((e) => contents.some((c) => createHash("sha256").update(c, "utf8").digest("hex") === e.contentSha256)),
  );
  const sidecarText = readFileSync(secretGuardAuditPathFor(stubState.sessionFile), "utf8");
  check(
    "sidecar 文件全文零明文（三种秘密值均不出现）",
    [PW_URI, PW_KV, PW_CN].every((pw) => !sidecarText.includes(pw)) && sidecarText.includes("[REDACTED]") === false,
    sidecarText.slice(0, 120),
  );

  client.close();
  server.close();
  await new Promise((r) => setTimeout(r, 100));
  rmSync(sessionDir, { recursive: true, force: true });
}

// ── E. 凭据通道不变量（假 exec：密码只经 stdin，argv 零明文） ────────────────

console.log("\n[E] 凭据通道不变量（addDatasource/testDatasource：秘密只走 stdin JSON）");

interface ExecCall {
  file: string;
  args: string[];
  opts?: ExecOptions;
}

function fakeExec(wrapperReply: Partial<ExecResult>): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (args[0] === "tool") return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    return {
      stdout: wrapperReply.stdout ?? '{"ok":true}',
      stderr: wrapperReply.stderr ?? "",
      exitCode: wrapperReply.exitCode ?? 0,
      timedOut: wrapperReply.timedOut ?? false,
    };
  };
  return { exec, calls };
}

const SECRET_URL = "mysql+pymysql://app@10.0.0.5:3306/sales";

{
  const { exec, calls } = fakeExec({});
  const res = await addDatasource({ name: "sales", url: SECRET_URL, password: PW_URI, connectArgs: { charset: "utf8mb4" }, overwrite: false }, exec);
  const wrapper = calls.find((c) => c.args.includes("-c"));
  check("addDatasource 成功回执", res.ok && res.data.name === "sales");
  check(
    "wrapper 调用的 file 与 args.join(' ') 零密码明文",
    wrapper !== undefined && !wrapper.file.includes(PW_URI) && !wrapper.args.join(" ").includes(PW_URI),
  );
  check(
    "wrapper 调用的 argv 也不含 URL 明文（凭据类载荷全走 stdin）",
    wrapper !== undefined && !wrapper.args.join(" ").includes(SECRET_URL),
  );
  const input = JSON.parse(wrapper?.opts?.input ?? "{}") as Record<string, unknown>;
  check("秘密只在 opts.input：password 原值直达 stdin JSON", input.password === PW_URI);
  check(
    "stdin JSON 载荷完整（op/name/url/connectArgs/overwrite 透传）",
    input.op === "add_datasource" && input.name === "sales" && input.url === SECRET_URL
      && JSON.stringify(input.connect_args) === JSON.stringify({ charset: "utf8mb4" }) && input.overwrite === false,
  );
  check("其余调用（uv tool dir 探测）同样零明文", calls.every((c) => !c.args.join(" ").includes(PW_URI) && (c.opts?.input ?? "").includes(PW_URI) === (c === wrapper)));
}

for (const overwrite of [true, false] as const) {
  const { exec, calls } = fakeExec({});
  await addDatasource({ name: "sales", url: SECRET_URL, password: PW_URI, overwrite }, exec);
  const input = JSON.parse(calls.find((c) => c.args.includes("-c"))?.opts?.input ?? "{}") as Record<string, unknown>;
  check(`overwrite=${overwrite} 语义透传进 stdin JSON`, input.overwrite === overwrite);
}
{
  const { exec, calls } = fakeExec({});
  await addDatasource({ name: "sales", url: SECRET_URL }, exec);
  const input = JSON.parse(calls.find((c) => c.args.includes("-c"))?.opts?.input ?? "{}") as Record<string, unknown>;
  check("overwrite 缺省为 false（不静默覆盖同名数据源）", input.overwrite === false && input.password === undefined);
}

{
  const { exec, calls } = fakeExec({});
  const res = await testDatasource({ url: SECRET_URL, password: PW_URI, timeoutMs: 5_000 }, exec);
  const wrapper = calls.find((c) => c.args.includes("-c"));
  const input = JSON.parse(wrapper?.opts?.input ?? "{}") as Record<string, unknown>;
  check("testDatasource 成功回执带 latencyMs", res.ok && res.data.latencyMs >= 0);
  check("testDatasource 秘密同样只走 stdin", input.op === "test_connection" && input.password === PW_URI
    && wrapper !== undefined && !wrapper.args.join(" ").includes(PW_URI));
}

{
  // wrapper 回执里夹带明文（如数据库原生报错带密码）→ Node 侧 redactSecrets 二次脱敏
  const { exec } = fakeExec({ stdout: `{"ok":false,"excClass":"OperationalError","message":"access denied for password=${PW_URI}"}` });
  const res = await testDatasource({ url: SECRET_URL, password: PW_URI }, exec);
  check(
    "错误回执经 redactSecrets 二次脱敏（error 零明文）",
    !res.ok && !res.error.includes(PW_URI) && res.error.includes("[REDACTED]"),
    res.ok ? "unexpected ok" : res.error,
  );
}

// ── F. 零日志泄露（静态扫描 + 针对性脱敏断言） ──────────────────────────────

console.log("\n[F] 零日志泄露（server/ 源码：用户 content/秘密不得直落 console）");

function serverSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverSourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

{
  // 不变量扫描：console.* 同一行不得出现用户内容/秘密载荷（msg.content/.password/opts.input）
  // 除非该行走 redactSecrets/redactForLog 脱敏出口。多行 console 调用按行扫描（针对性
  // 断言补盲区）。
  const secretCarriers = ["msg.content", ".password", "opts.input"];
  const offenders: string[] = [];
  for (const file of serverSourceFiles(join(process.cwd(), "server"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!/console\.(log|debug|info|warn|error)\s*\(/.test(line)) continue;
      const carries = secretCarriers.some((t) => line.includes(t));
      const redacted = line.includes("redactSecrets(") || line.includes("redactForLog(");
      if (carries && !redacted) offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
    }
  }
  check("console.* 无未脱敏的秘密载荷直写（msg.content/.password/opts.input）", offenders.length === 0, offenders.join(" | "));
}

const wsHandlerSrc = readFileSync(join(process.cwd(), "server", "ws-handler.ts"), "utf8");
check(
  "makePrompt 日志行已脱敏（console.debug + redactSecrets(prompt)）",
  wsHandlerSrc.includes('console.debug("[ws] prompt: " + redactSecrets(prompt))'),
);
check(
  "onboarding 失败日志已脱敏（redactForLog(err)）",
  /console\.error\(`\[onboarding\] \$\{payload\.action\} failed:`,\s*redactForLog\(err\)\)/.test(wsHandlerSrc),
);
check(
  "onboarding 进度消息已脱敏（redactSecrets(message)）",
  wsHandlerSrc.includes("message: redactSecrets(message)"),
);

const canvasExtSrc = readFileSync(join(process.cwd(), "server", "extensions", "govio-canvas.ts"), "utf8");
check(
  "tool result 日志行已脱敏（redactSecrets(cmd).slice）",
  /tool_result subcommand:.*redactSecrets\(cmd\)\.slice/.test(canvasExtSrc),
);

const cliExecSrc = readFileSync(join(process.cwd(), "server", "govio-cli-exec.ts"), "utf8");
check(
  "govio-cli 执行日志已脱敏（redactForLog(args) + redactSecrets(stderr)）",
  cliExecSrc.includes("redactForLog(args)") && cliExecSrc.includes("redactSecrets(stderr || error.message)"),
);

// ── G. 拦截留痕 sidecar（临时目录实测：零明文 / 读回 / 坏行 / 删除） ─────────

console.log("\n[G] 拦截留痕 sidecar（recordSecretGuardAudit 零明文）");

{
  const dir = mkdtempSync(join(tmpdir(), "govio-secrets-audit-"));
  const sessionFile = join(dir, "sess-audit.jsonl");
  writeFileSync(sessionFile, "");
  const content = `密码是 ${PW_CN}，另外 password=${PW_KV}`;
  const matches = detectSecretLeaks(content);
  const entry = recordSecretGuardAudit({ sessionId: "sess-audit", sessionFile, kind: "prompt", content, matches });

  check("留痕条目结构（v/at/sessionId/sessionFile/kind/categories/contentSha256）",
    entry !== null && entry.v === SECRET_GUARD_AUDIT_VERSION && Number.isFinite(Date.parse(entry.at))
      && entry.sessionId === "sess-audit" && entry.sessionFile === sessionFile && entry.kind === "prompt"
      && entry.categories.length === 1 && entry.categories[0] === "password");
  check("contentSha256 == sha256(被拦内容)（内容本身不落盘）",
    entry !== null && entry.contentSha256 === createHash("sha256").update(content, "utf8").digest("hex"));
  check("留痕字段表无明文槽位（entry 序列化零明文）",
    entry !== null && !JSON.stringify(entry).includes(PW_CN) && !JSON.stringify(entry).includes(PW_KV));

  appendFileSync(sessionFile, "{坏行\n", "utf8");
  const readBack = readSecretGuardAudit(sessionFile);
  check("读回往返 + 坏行跳过（一条坏行不影响整份留痕）", readBack.length === 1 && readBack[0].contentSha256 === entry?.contentSha256);

  const noSession = recordSecretGuardAudit({ sessionId: "s", sessionFile: null, kind: "steer", content, matches });
  check("会话未落盘（sessionFile=null）时跳过留痕、不抛错", noSession === null);

  check("deleteSecretGuardAudit 删除 sidecar（二次删除返回 false）",
    deleteSecretGuardAudit(sessionFile) === true && existsSync(secretGuardAuditPathFor(sessionFile)) === false
      && deleteSecretGuardAudit(sessionFile) === false);
  rmSync(dir, { recursive: true, force: true });
}

{
  const redirect = buildSecretRedirect(detectSecretLeaks(`password=${PW_KV}`));
  check(
    "buildSecretRedirect 纯函数回执（categories + 脱敏摘要，零明文）",
    redirect.type === "secret_redirect" && redirect.categories.includes("password")
      && redirect.redactedSnippets.every((s) => s.includes("[REDACTED]") && !s.includes(PW_KV)),
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\nverify-secrets-isolation: ${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  console.error(`失败断言 ${failures.length} 项: ${failures.join(" | ")}`);
  process.exit(1);
}
process.exit(0);
