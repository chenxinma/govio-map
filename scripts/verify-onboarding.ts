/**
 * X34 验证脚本：首启向导后端通道——幂等 / 可恢复 / 错误分类 / 凭据无 argv（onboarding.ts）。
 *
 * 复跑：`npm run verify:onboarding`（等价于 `npx tsx scripts/verify-onboarding.ts`）
 *
 * 覆盖（对齐 task-plan X34 acceptance + P3 任务书 §4.2）：
 *  1. 幂等：initGraph 默认参数稳定（ladybug 一键两次调用 argv 逐字一致，落盘
 *     `~/.govio/ontology.lbdb` 由 govio-cli 默认）；addDatasource overwrite 语义正确
 *  2. 可恢复：exitCode≠0 / timedOut → 结构化 {ok:false, error, errorKind, hint}，重试路径可用
 *  3. status 解析各形态（cli 未装 / 未初始化 / 已初始化 / 多数据源 / 非 JSON）
 *  4. 错误分类纯函数样本：auth/host/port/dns/timeout/other 各至少 1 正样本
 *  5. importMetadata 非 DuckDB → 可读引导（不是异常堆栈）；进度回调脱敏
 *  6. removeDatasource 走无秘密 argv；resolveGovioPython 解析与 fallback
 *
 * 全部经 `ExecFn` 假 exec 注入（不需要真 govio-cli/uv；CI 无 govio 环境）。
 * 任一断言失败退出码为 1。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDatasource,
  classifyDatasourceError,
  getOnboardingStatus,
  importMetadata,
  initGraph,
  removeDatasource,
  resolveGovioPython,
  testDatasource,
  type ConnectionErrorKind,
  type ExecFn,
  type ExecOptions,
  type ExecResult,
} from "../server/onboarding.js";

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

interface ExecCall {
  file: string;
  args: string[];
  opts?: ExecOptions;
}

/**
 * 假 exec：记录全部调用供断言；respond 返回 undefined 时给成功回执
 * （wrapper 形态 `{"ok":true}`）。respond 抛错 = 子进程 spawn 失败（如 CLI 未安装）。
 */
function fakeExec(
  respond: (call: ExecCall) => Partial<ExecResult> | undefined = () => undefined,
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const call = { file, args, opts };
    calls.push(call);
    const reply = respond(call) ?? {};
    return {
      stdout: reply.stdout ?? '{"ok":true}',
      stderr: reply.stderr ?? "",
      exitCode: reply.exitCode ?? 0,
      timedOut: reply.timedOut ?? false,
    };
  };
  return { exec, calls };
}

/** wrapper 回执（stdout 末行 JSON 形态） */
function wrapperReply(ok: boolean, extra: Record<string, unknown> = {}): Partial<ExecResult> {
  return { stdout: JSON.stringify({ ok, ...extra }), exitCode: 0 };
}

const EMPTY_REPLY: Partial<ExecResult> = {};

// ── A. initGraph：幂等与参数映射 ────────────────────────────────────────────

console.log("\n[A] initGraph 幂等（默认参数两次调用逐字一致）与参数映射");

{
  const { exec, calls } = fakeExec();
  const first = await initGraph({ backend: "ladybug" }, exec);
  const second = await initGraph({ backend: "ladybug" }, exec);
  const argvs = calls.map((c) => [c.file, ...c.args]);
  check("ladybug 一键两次调用 argv 逐字一致（幂等稳定）",
    JSON.stringify(argvs[0]) === JSON.stringify(argvs[1]),
    JSON.stringify(argvs));
  check("默认参数收敛为 ['onboard','--backend','ladybug']（~/.govio/ontology.lbdb 由 govio-cli 默认落盘）",
    JSON.stringify(argvs[0]) === JSON.stringify(["govio-cli", "onboard", "--backend", "ladybug"]),
    JSON.stringify(argvs[0]));
  check("默认调用不带 --db-path（不覆盖 govio-cli 的默认落盘位置）",
    calls.every((c) => !c.args.includes("--db-path")));
  check("两次调用都成功回执", first.ok && second.ok && first.data.backend === "ladybug");
}

{
  const { exec, calls } = fakeExec();
  await initGraph({ backend: "ladybug", dbPath: "~/.govio/ontology.lbdb" }, exec);
  check("显式 dbPath 映射 --db-path（幂等参数仍逐字确定）",
    JSON.stringify(calls[0].args) === JSON.stringify(["onboard", "--backend", "ladybug", "--db-path", "~/.govio/ontology.lbdb"]),
    JSON.stringify(calls[0].args));
}

{
  const { exec, calls } = fakeExec();
  await initGraph({ backend: "falkordb", host: "10.1.2.3", port: "6380", graphName: "gov" }, exec);
  check("falkordb 只收参执行（host/port/graph 映射 argv）",
    JSON.stringify(calls[0].args) === JSON.stringify(["onboard", "--backend", "falkordb", "--host", "10.1.2.3", "--port", "6380", "--graph", "gov"]),
    JSON.stringify(calls[0].args));
}

{
  const { exec, calls } = fakeExec();
  const res = await initGraph({ backend: "networkx", gmlPath: "D:/graph/model.gml" }, exec);
  check("networkx 映射 --gml-path", res.ok
    && JSON.stringify(calls[0].args) === JSON.stringify(["onboard", "--backend", "networkx", "--gml-path", "D:/graph/model.gml"]));
  const { exec: exec2 } = fakeExec();
  const bad = await initGraph({ backend: "networkx" }, exec2);
  check("networkx 缺 GML 路径 → 结构化拒绝（invalid_args + 修复指引）",
    !bad.ok && bad.errorKind === "invalid_args" && (bad.hint ?? "").includes("GML"));
}

{
  const { exec } = fakeExec(() => ({ exitCode: 0, timedOut: true, stdout: "", stderr: "" }));
  const res = await initGraph({ backend: "ladybug" }, exec);
  check("timedOut → {ok:false, errorKind:timeout, message, hint} 结构化",
    !res.ok && res.errorKind === "timeout" && res.error.length > 0 && (res.hint ?? "").length > 0);
}
{
  const { exec } = fakeExec(() => ({ exitCode: 3, stdout: "", stderr: "错误: falkordb 服务不可达" }));
  const res = await initGraph({ backend: "falkordb", host: "10.9.9.9" }, exec);
  check("exitCode≠0 → errorKind=exec、message 取 stderr、hint 非空",
    !res.ok && res.errorKind === "exec" && res.error.includes("falkordb 服务不可达") && (res.hint ?? "").length > 0,
    res.ok ? "unexpected ok" : `${res.errorKind}:${res.hint}`);
}

// ── B. addDatasource：overwrite 语义 ───────────────────────────────────────

console.log("\n[B] addDatasource overwrite 语义（同名数据源默认不覆盖）");

for (const overwrite of [true, false] as const) {
  const { exec, calls } = fakeExec();
  const res = await addDatasource({ name: "sales", url: "mysql+pymysql://app@10.0.0.5:3306/sales", overwrite }, exec);
  const input = JSON.parse(calls.find((c) => c.args.includes("-c"))?.opts?.input ?? "{}") as Record<string, unknown>;
  check(`overwrite=${overwrite} 透传进 wrapper 载荷`, res.ok && input.overwrite === overwrite);
}
{
  const { exec, calls } = fakeExec();
  await addDatasource({ name: "sales", url: "duckdb:///D:/data/sales.duckdb" }, exec);
  const input = JSON.parse(calls.find((c) => c.args.includes("-c"))?.opts?.input ?? "{}") as Record<string, unknown>;
  check("overwrite 缺省 false（重复添加不静默覆盖）", input.overwrite === false);
}

{
  const { exec } = fakeExec(() => wrapperReply(false, { excClass: "ValueError", message: "数据源 'sales' 已存在" }));
  const res = await addDatasource({ name: "sales", url: "duckdb:///x.duckdb" }, exec);
  check("同名冲突 → 可读修复指引（提示勾选「覆盖」）",
    !res.ok && (res.hint ?? "").includes("覆盖"), res.ok ? "unexpected ok" : res.hint);
}
{
  const { exec } = fakeExec(() => wrapperReply(false, { excClass: "ValueError", message: "URL 不含用户信息（user@host），无法单独传密码" }));
  const res = await addDatasource({ name: "x", url: "duckdb:///x.duckdb", password: "pw" }, exec);
  check("URL 缺用户信息 → 指引账号写进 URL", !res.ok && (res.hint ?? "").includes("user@host"));
}

// ── C. 可恢复（结构化失败 + 重试路径） ──────────────────────────────────────

console.log("\n[C] 可恢复：结构化失败 {ok:false, error, errorKind, hint}，重试路径可用");

{
  const failing = fakeExec(() => ({ exitCode: 0, timedOut: true, stdout: "", stderr: "" }));
  const timeoutRes = await testDatasource({ url: "mysql+pymysql://app@10.0.0.5:3306/sales", timeoutMs: 1_000 }, failing.exec);
  check("testDatasource timedOut → errorKind=timeout + 可读指引",
    !timeoutRes.ok && timeoutRes.errorKind === "timeout" && (timeoutRes.hint ?? "").includes("超时"),
    timeoutRes.ok ? "unexpected ok" : `${timeoutRes.errorKind}:${timeoutRes.hint}`);
  const retry = fakeExec();
  const retryRes = await testDatasource({ url: "mysql+pymysql://app@10.0.0.5:3306/sales", timeoutMs: 1_000 }, retry.exec);
  check("失败后重试路径可用（同一参数换好回执即成功）", retryRes.ok && retryRes.data.latencyMs >= 0);
}

{
  const { exec } = fakeExec(() => ({ exitCode: 0, stdout: "警告: 奇怪的非 JSON 输出", stderr: "" }));
  const res = await testDatasource({ url: "duckdb:///x.duckdb" }, exec);
  check("wrapper 无结构化回执 → 可读兜底（不是异常堆栈）",
    !res.ok && res.error === "wrapper 无结构化回执" && res.errorKind === "other" && (res.hint ?? "").length > 0);
}
{
  const { exec } = fakeExec(() => wrapperReply(false, { excClass: "OperationalError", message: "Connection refused" }));
  const res = await addDatasource({ name: "x", url: "postgresql://app@10.0.0.5:5432/d" }, exec);
  check("addDatasource 失败结构化齐全（error/errorKind/hint 三件套）",
    !res.ok && res.error === "Connection refused" && res.errorKind === "exec" && (res.hint ?? "").length > 0);
}

// ── D. status 解析各形态 ───────────────────────────────────────────────────

console.log("\n[D] getOnboardingStatus 解析各形态（假 exec：-V / backend / observe info）");

/** 组装按命令分发的假 exec：-V / backend / observe info --datasource */
function statusExec(opts: {
  versionStdout?: string | null; // null = spawn 失败（CLI 未安装）
  backendStdout?: string;
  backendExit?: number;
  backendStderr?: string;
  datasourcesStdout?: string;
}): { exec: ExecFn; calls: ExecCall[] } {
  return fakeExec((call) => {
    const key = call.args.join(" ");
    if (key === "-V") {
      if (opts.versionStdout === null) throw new Error("spawn govio-cli ENOENT");
      return { stdout: opts.versionStdout ?? "govio-cli 0.8.0", exitCode: 0 };
    }
    if (key === "backend") {
      return { stdout: opts.backendStdout ?? "", exitCode: opts.backendExit ?? 0, stderr: opts.backendStderr ?? "" };
    }
    return { stdout: opts.datasourcesStdout ?? "[]", exitCode: 0 };
  });
}

{
  const { exec, calls } = statusExec({ versionStdout: null });
  const status = await getOnboardingStatus(exec);
  check("CLI 未安装 → cli.installed=false、version=null", status.cli.installed === false && status.cli.version === null);
  check("CLI 未安装时不再探测图后端/数据源（零多余子进程）",
    calls.every((c) => c.args.join(" ") === "-V"), JSON.stringify(calls.map((c) => c.args)));
  check("skillsReady/modelsConfigured 为布尔（fs 探测，不受 exec 影响）",
    typeof status.skillsReady === "boolean" && typeof status.modelsConfigured === "boolean");
}

{
  const { exec } = statusExec({ versionStdout: "govio-cli 0.8.0", backendExit: 1, backendStderr: "未检测到图后端配置", datasourcesStdout: "[]" });
  const status = await getOnboardingStatus(exec);
  check("已装 CLI 但未初始化 → graph.initialized=false、error 可读",
    status.cli.installed && status.cli.version === "0.8.0" && status.graph.initialized === false
      && status.graph.backend === null && (status.graph.error ?? "").includes("未检测到图后端"));
  check("未初始化时数据源为空", status.datasources.length === 0);
}

{
  const { exec } = statusExec({ backendStdout: "ladybug", datasourcesStdout: '["sales"]' });
  const status = await getOnboardingStatus(exec);
  check("已初始化（ladybug）→ graph.initialized=true、backend=ladybug",
    status.graph.initialized === true && status.graph.backend === "ladybug");
  check("单数据源解析", JSON.stringify(status.datasources) === JSON.stringify(["sales"]));
}

{
  const { exec } = statusExec({ backendStdout: "ladybug", datasourcesStdout: '["sales","hr","finance"]' });
  const status = await getOnboardingStatus(exec);
  check("多数据源解析（顺序保持）", JSON.stringify(status.datasources) === JSON.stringify(["sales", "hr", "finance"]));
}

{
  const { exec } = statusExec({ backendStdout: "ladybug", datasourcesStdout: "not json at all" });
  const status = await getOnboardingStatus(exec);
  check("observe info 非 JSON → datasources 降级为空（不抛错）", status.datasources.length === 0);
  const { exec: exec2 } = statusExec({ backendStdout: "ladybug", datasourcesStdout: '{"a":1}' });
  const status2 = await getOnboardingStatus(exec2);
  check("observe info 非数组 JSON → datasources 降级为空", status2.datasources.length === 0);
}

{
  const { exec } = statusExec({ versionStdout: "govio version 0.9.1 build 2026-11-28", backendStdout: "falkordb" });
  const status = await getOnboardingStatus(exec);
  check("版本号从任意输出抽取 x.y.z", status.cli.version === "0.9.1" && status.graph.backend === "falkordb");
}

{
  // graph.error 走 redactSecrets（后端 stderr 可能夹带连接串）
  const { exec } = statusExec({
    backendExit: 1,
    backendStderr: "连接 mysql+pymysql://root:LeakPW9@10.0.0.5:3306 失败",
  });
  const status = await getOnboardingStatus(exec);
  check("graph.error 经 redactSecrets（stderr 夹带凭据零明文）",
    !(status.graph.error ?? "").includes("LeakPW9") && (status.graph.error ?? "").includes("[REDACTED]"));
}

// ── E. classifyDatasourceError 纯函数样本 ──────────────────────────────────

console.log("\n[E] classifyDatasourceError 错误分类（auth/host/port/dns/timeout/other 各正样本）");

const CLASSIFY_SAMPLES: [string, ConnectionErrorKind, string | undefined][] = [
  ["getaddrinfo ENOTFOUND db.example.com", "dns", undefined],
  ["OperationalError: temporary failure in name resolution", "dns", undefined],
  ["OSError: [Errno 113] No route to host", "host", undefined],
  ["psycopg2.OperationalError: Connection refused (127.0.0.1:5432)", "port", undefined],
  ['FATAL: 28P01: password authentication failed for user "x"', "auth", "OperationalError"],
  ["(pymysql.err.OperationalError) (1045, \"Access denied for user 'root'\")", "auth", undefined],
  ["sqlalchemy.exc.OperationalError: connection timed out", "timeout", undefined],
  ["duckdb.HTTPException: 操作超时", "timeout", undefined],
  ['psycopg2.errors.SyntaxError: syntax error at or near "SELEC"', "other", undefined],
];

for (const [message, kind, excClass] of CLASSIFY_SAMPLES) {
  check(`分类 ${kind}：${message.slice(0, 44)}…`, classifyDatasourceError(message, excClass) === kind,
    `got=${classifyDatasourceError(message, excClass)}`);
}

{
  // 分类 → 修复指引映射（testDatasource 出口）
  const { exec } = fakeExec(() => wrapperReply(false, { excClass: "OperationalError", message: "Connection refused (127.0.0.1:5432)" }));
  const portRes = await testDatasource({ url: "postgresql://app@10.0.0.5:5432/d" }, exec);
  check("port 分类出口带端口修复指引",
    !portRes.ok && portRes.errorKind === "port" && (portRes.hint ?? "").includes("端口"));
  const { exec: exec2 } = fakeExec(() => wrapperReply(false, { excClass: "OperationalError", message: "Access denied for user 'root'" }));
  const authRes = await testDatasource({ url: "mysql+pymysql://root@10.0.0.5:3306/d" }, exec2);
  check("auth 分类出口带密码/账号修复指引",
    !authRes.ok && authRes.errorKind === "auth" && (authRes.hint ?? "").includes("密码"));
}

// ── F. importMetadata：非 DuckDB 可读引导 + 进度脱敏 ────────────────────────

console.log("\n[F] importMetadata（非 DuckDB 可读引导、argv 映射、进度脱敏）");

{
  const { exec } = fakeExec(() => ({
    exitCode: 1,
    stdout: "",
    stderr: "Traceback (most recent call last):\n  File ...\n错误: 数据源 'mysql_x' 不是 duckdb://，一键导元数据仅支持 DuckDB",
  }));
  const res = await importMetadata({ datasource: "mysql_x", schemas: "main" }, undefined, exec);
  check("非 DuckDB → errorKind=unsupported + 可读引导（不是异常堆栈）",
    !res.ok && res.errorKind === "unsupported" && res.error.includes("仅支持 DuckDB")
      && (res.hint ?? "").includes("聊天") && !res.error.includes("Traceback") && !(res.hint ?? "").includes("Traceback"));
}

{
  const { exec } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "错误: 数据源 'ghost' 不存在" }));
  const res = await importMetadata({ datasource: "ghost", schemas: "main" }, undefined, exec);
  check("数据源不存在 → not_found + 指引先添加数据源",
    !res.ok && res.errorKind === "not_found" && (res.hint ?? "").includes("数据源管理器"));
}

{
  const { exec, calls } = fakeExec();
  const res = await importMetadata({ datasource: "sales", schemas: "main,aux", mode: "rebuild" }, undefined, exec);
  check("成功路径 argv 映射（meta import-schema + mode）",
    res.ok && res.data.mode === "rebuild"
      && JSON.stringify(calls[0].args) === JSON.stringify(["meta", "import-schema", "--datasource", "sales", "--schemas", "main,aux", "--mode", "rebuild"]),
    JSON.stringify(calls[0]?.args));
  const { exec: exec2, calls: calls2 } = fakeExec();
  await importMetadata({ datasource: "sales", schemas: "main" }, undefined, exec2);
  check("mode 缺省 update", calls2[0].args.includes("update"));
}

{
  const progress: string[] = [];
  const { exec } = fakeExec((call) => {
    call.opts?.onStdout?.("读取 password=LeakPW9 的连接串\n已导入 3 张表\n");
    return EMPTY_REPLY;
  });
  await importMetadata({ datasource: "sales", schemas: "main" }, (m) => progress.push(m), exec);
  check("进度回调经 redactSecrets（stdout 夹带密码零明文）",
    progress.length > 0 && progress.every((m) => !m.includes("LeakPW9")) && progress.some((m) => m.includes("[REDACTED]")),
    JSON.stringify(progress));
}

{
  const { exec } = fakeExec(() => ({ exitCode: 2, stdout: "", stderr: "schema 校验失败：'nope' 不在导入清单内" }));
  const res = await importMetadata({ datasource: "sales", schemas: "nope" }, undefined, exec);
  check("通用失败 → errorKind=exec + hint", !res.ok && res.errorKind === "exec" && (res.hint ?? "").length > 0);
}

// ── G. removeDatasource：无秘密 argv ───────────────────────────────────────

console.log("\n[G] removeDatasource（无秘密 argv：删除只带数据源名）");

{
  const { exec, calls } = fakeExec();
  const res = await removeDatasource("sales", exec);
  check("删除 argv 精确为 ['onboard','--remove-datasource',name]",
    res.ok && JSON.stringify(calls[0].args) === JSON.stringify(["onboard", "--remove-datasource", "sales"])
      && calls[0].file === "govio-cli");
  check("删除不走 stdin 通道（opts.input 为空，无秘密载荷）", calls[0].opts?.input === undefined);
}
{
  const { exec } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "错误: 数据源 'ghost' 不存在" }));
  const res = await removeDatasource("ghost", exec);
  check("删除不存在 → 指引刷新列表（不报异常堆栈）",
    !res.ok && (res.hint ?? "").includes("刷新列表") && !res.error.includes("Traceback"));
  const { exec: exec2 } = fakeExec(() => ({ exitCode: 1, stdout: "", stderr: "配置文件写入失败" }));
  const res2 = await removeDatasource("sales", exec2);
  check("通用删除失败 → 可读 hint", !res2.ok && (res2.hint ?? "").includes("稍后重试") && res2.error.includes("配置文件写入失败"));
}

// ── H. resolveGovioPython：解析与 fallback ─────────────────────────────────

console.log("\n[H] resolveGovioPython（govio 工具环境解释器解析 + uv run fallback）");

{
  const dir = mkdtempSync(join(tmpdir(), "govio-uv-"));
  const candidate = process.platform === "win32"
    ? join(dir, "govio", "Scripts", "python.exe")
    : join(dir, "govio", "bin", "python");
  mkdirSync(join(candidate, ".."), { recursive: true });
  writeFileSync(candidate, "");
  const { exec, calls } = fakeExec((call) => (call.args.join(" ") === "tool dir" ? { stdout: dir, exitCode: 0 } : undefined));
  const py = await resolveGovioPython(exec);
  check("uv tool dir 下的 govio 解释器被解析（无 prefixArgs）",
    py.file === candidate && py.prefixArgs.length === 0 && calls[0].args.join(" ") === "tool dir",
    JSON.stringify(py));

  const { exec: exec2 } = fakeExec((call) =>
    call.args.join(" ") === "tool dir" ? { stdout: join(dir, "empty"), exitCode: 0 } : undefined);
  const py2 = await resolveGovioPython(exec2);
  check("tool dir 下无 govio 环境 → fallback uv run --from govio python",
    py2.file === "uv" && JSON.stringify(py2.prefixArgs) === JSON.stringify(["run", "--from", "govio", "python"]));

  const { exec: exec3 } = fakeExec((call) =>
    call.args.join(" ") === "tool dir" ? { exitCode: 1, stdout: "", stderr: "uv 未安装" } : undefined);
  const py3 = await resolveGovioPython(exec3);
  check("uv tool dir 失败 → 同样 fallback（不抛错）",
    py3.file === "uv" && JSON.stringify(py3.prefixArgs) === JSON.stringify(["run", "--from", "govio", "python"]));
  rmSync(dir, { recursive: true, force: true });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`\nverify-onboarding: ${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  console.error(`失败断言 ${failures.length} 项: ${failures.join(" | ")}`);
  process.exit(1);
}
process.exit(0);
