/**
 * X34 onboarding 后端通道（P1b）：onboard 状态检测 + 子进程驱动 govio-cli 完成
 * 图库初始化 / 数据源增删改 / 测试连接 / 测试模型 / 一键导元数据 / 环境自检。
 *
 * 凭据纪律（本模块核心约束）：govio-cli 只接受密码 via `--password`/URL（都是 argv），
 * 故凭据类操作（add_datasource / test_datasource）改走**静态 python wrapper + stdin
 * 管道**：wrapper 是静态字符串（无秘密），秘密只经 stdin 进入子进程，由 govio
 * `ConfigManager` 加密落盘——凭据零进入 LLM 上下文 / 日志 / 进程参数 / 环境变量。
 * 无秘密的操作（initGraph/removeDatasource/importMetadata/status）走常规 argv。
 *
 * 可测性（供 P3 verify:onboarding）：所有子进程交互经 `ExecFn` 注入（可 stub）；
 * 错误分类 `classifyDatasourceError` 为纯函数；不依赖模块级隐藏状态。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ensureGovioCli,
  downloadGovioSkills,
  govioSkillsReady,
} from "./govio-installer.js";
import { modelsConfigExists } from "./models-config.js";
import { redactSecrets } from "./secret-guard.js";
import type {
  WSOnboardingAddDatasource,
  WSOnboardingGraphConfig,
  WSOnboardingTestDatasource,
} from "../src/types/ws-protocol.js";

// ── 子进程抽象（可注入） ─────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 子进程被 timeoutMs 探测终止（区别于子进程自行失败） */
  timedOut: boolean;
}

export interface ExecOptions {
  /** 写入子进程 stdin 后关闭（凭据通道；绝不落日志） */
  input?: string;
  timeoutMs?: number;
  /** 实时输出行回调（进度消息用；调用方负责脱敏） */
  onStdout?: (chunk: string) => void;
}

export type ExecFn = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts?.timeoutMs ?? 30_000);
    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      opts?.onStdout?.(text);
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    if (opts?.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });

// ── 结果类型 ─────────────────────────────────────────────────────────────────

export interface OnboardingSuccess<T> {
  ok: true;
  data: T;
}

export interface OnboardingFailure {
  ok: false;
  error: string;
  /** 错误分类（测试连接：dns/host/port/auth/timeout/other；其余动作自定） */
  errorKind?: string;
  /** 可读修复指引（G8：错误 → 可行动修复指引） */
  hint?: string;
}

export type OnboardingResult<T> = OnboardingSuccess<T> | OnboardingFailure;

function fail(error: string, errorKind?: string, hint?: string): OnboardingFailure {
  return { ok: false, error: redactSecrets(error), errorKind, hint };
}

// ── 状态检测 ─────────────────────────────────────────────────────────────────

export interface OnboardingGraphStatus {
  /** 图后端是否已初始化（config.yaml 存在且 graph.backend 已设置） */
  initialized: boolean;
  /** ladybug / falkordb / networkx；未初始化为 null */
  backend: string | null;
  /** 未初始化时的可读原因（govio-cli backend 的 stderr） */
  error?: string;
}

export interface OnboardingStatus {
  cli: { installed: boolean; version: string | null };
  graph: OnboardingGraphStatus;
  datasources: string[];
  /** .agents/skills/govio/SKILL.md 就位（govio 技能包可用） */
  skillsReady: boolean;
  /** ~/.pi/agent/models.json 已配置 */
  modelsConfigured: boolean;
}

/**
 * govio-cli 版本号（x.y.z）；未安装/不可解析为 null。
 * 经 ExecFn 注入（P3 缺口小修）：getOnboardingStatus 的假 exec 测试可覆盖版本探测，
 * 不需要真 govio-cli；调用面不变（仍探测 `govio-cli -V`，失败/超时/解析不了为 null）。
 */
async function detectCliVersion(exec: ExecFn = defaultExec): Promise<string | null> {
  try {
    const res = await exec("govio-cli", ["-V"], { timeoutMs: 15_000 });
    if (res.exitCode !== 0) return null;
    return res.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? (res.stdout.trim() || null);
  } catch {
    return null;
  }
}

/** onboard 状态检测：govio-cli 版本 / 图后端 / 数据源清单 / skills / models.json */
export async function getOnboardingStatus(exec: ExecFn = defaultExec): Promise<OnboardingStatus> {
  const cliVersion = await detectCliVersion(exec);

  let graph: OnboardingGraphStatus = { initialized: false, backend: null };
  if (cliVersion) {
    const backend = await exec("govio-cli", ["backend"], { timeoutMs: 15_000 });
    if (backend.exitCode === 0) {
      const name = backend.stdout.trim();
      graph = name ? { initialized: true, backend: name } : { initialized: false, backend: null };
    } else {
      graph = {
        initialized: false,
        backend: null,
        error: redactSecrets(backend.stderr.trim() || "未检测到图后端配置"),
      };
    }
  }

  let datasources: string[] = [];
  if (graph.initialized || cliVersion) {
    const list = await exec("govio-cli", ["observe", "info", "--datasource"], { timeoutMs: 15_000 });
    if (list.exitCode === 0) {
      try {
        const parsed = JSON.parse(list.stdout);
        if (Array.isArray(parsed)) {
          datasources = parsed.filter((n): n is string => typeof n === "string");
        }
      } catch {
        datasources = [];
      }
    }
  }

  return {
    cli: { installed: cliVersion !== null, version: cliVersion },
    graph,
    datasources,
    skillsReady: await govioSkillsReady(),
    modelsConfigured: await modelsConfigExists(),
  };
}

// ── 图库初始化（govio-cli onboard --backend） ────────────────────────────────

function initGraphArgs(config: WSOnboardingGraphConfig): string[] {
  const args = ["onboard", "--backend", config.backend];
  if (config.backend === "ladybug" && config.dbPath) args.push("--db-path", config.dbPath);
  if (config.backend === "falkordb") {
    if (config.host) args.push("--host", config.host);
    if (config.port) args.push("--port", config.port);
    if (config.graphName) args.push("--graph", config.graphName);
  }
  if (config.backend === "networkx" && config.gmlPath) args.push("--gml-path", config.gmlPath);
  return args;
}

/**
 * 图库初始化（默认 ladybug 一键）。graph 段 upsert，既有数据源由 govio-cli 原样保留，
 * 重复执行幂等。falkordb/networkx 只收参执行，不建运维能力（design.md §8）。
 */
export async function initGraph(
  config: WSOnboardingGraphConfig,
  exec: ExecFn = defaultExec,
): Promise<OnboardingResult<{ backend: string }>> {
  if (config.backend === "networkx" && !config.gmlPath) {
    return fail(
      "networkx 后端需要 GML 文件路径",
      "invalid_args",
      "请填写 GML 文件路径（文件须已存在），或改用默认的 ladybug 本地后端",
    );
  }
  const res = await exec("govio-cli", initGraphArgs(config), { timeoutMs: 60_000 });
  if (res.timedOut) {
    return fail("初始化图库超时", "timeout", "请检查磁盘/网络后重试");
  }
  if (res.exitCode !== 0) {
    return fail(
      res.stderr.trim() || res.stdout.trim() || "初始化图库失败",
      "exec",
      "请检查后端参数（ladybug 无需外部服务；falkordb 需服务可达；networkx 的 GML 文件须已存在）后重试",
    );
  }
  return { ok: true, data: { backend: config.backend } };
}

// ── 凭据通道：静态 python wrapper + stdin JSON ────────────────────────────────

/**
 * 静态 wrapper 源码（**无任何秘密**；秘密只经 stdin JSON 进入子进程）。
 * 复用 govio 安装包内函数：`add_datasource`（ConfigManager 加密落盘）、
 * `parse_cli_connect_args`（与 CLI 一致的 key=value 标量强转）、`_attach_password`
 * （独立密码嵌入 URL）；test_connection 用 sqlalchemy / duckdb 做只读探测，**不落盘**。
 * 异常消息在 wrapper 内先脱敏（替换密码与 URL 用户信息段），Node 侧再过 redactSecrets。
 */
const GOVIO_WRAPPER_SOURCE = `
import json, re, sys

def _redact(msg, pw):
    if pw:
        msg = msg.replace(pw, "[REDACTED]")
    return re.sub(r"(://[^/@\\s:]+):([^/@\\s]+)@", r"\\1:[REDACTED]@", msg)

data = json.loads(sys.stdin.read())
op = data.get("op")
pw = data.get("password") or ""
try:
    connect_args = {}
    if data.get("connect_args"):
        from govio.cli.onboard import parse_cli_connect_args
        connect_args = parse_cli_connect_args(
            [f"{k}={v}" for k, v in data["connect_args"].items()]
        )
    if op == "add_datasource":
        from govio.cli.onboard import add_datasource
        add_datasource(
            data["name"], data["url"],
            connect_args=connect_args, password=data.get("password"),
            overwrite=bool(data.get("overwrite")),
        )
        print(json.dumps({"ok": True}))
    elif op == "test_connection":
        url = data["url"]
        if pw:
            from govio.cli.onboard import _attach_password
            url = _attach_password(url, pw)
        if url.startswith("duckdb://"):
            import duckdb
            con = duckdb.connect(url[len("duckdb://"):], read_only=True)
            try:
                con.execute("SELECT 1")
            finally:
                con.close()
        else:
            from sqlalchemy import create_engine, text
            engine = create_engine(url, connect_args=connect_args)
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        print(json.dumps({"ok": True}))
    else:
        print(json.dumps({"ok": False, "excClass": "ValueError", "message": "unknown op: %s" % op}))
except Exception as exc:  # noqa: BLE001 — 统一结构化出口
    print(json.dumps({
        "ok": False,
        "excClass": type(exc).__name__,
        "message": _redact(str(exc), pw)[:800],
    }))
`;

/** govio 工具环境内可 `import govio.cli.onboard` 的解释器（uv tool 安装布局） */
export interface GovioPython {
  file: string;
  /** file 为 `uv` 时的前置参数（fallback：uv run --from govio python） */
  prefixArgs: string[];
}

/**
 * 解析 govio 工具环境的 python 解释器：Windows `<uv tool dir>/govio/Scripts/python.exe`、
 * POSIX `<uv tool dir>/govio/bin/python`；找不到时 fallback `uv run --from govio python`。
 */
export async function resolveGovioPython(exec: ExecFn = defaultExec): Promise<GovioPython> {
  try {
    const res = await exec("uv", ["tool", "dir"], { timeoutMs: 15_000 });
    if (res.exitCode === 0) {
      const dir = res.stdout.trim();
      const candidate =
        process.platform === "win32"
          ? join(dir, "govio", "Scripts", "python.exe")
          : join(dir, "govio", "bin", "python");
      if (dir && existsSync(candidate)) {
        return { file: candidate, prefixArgs: [] };
      }
    }
  } catch {
    // fall through to uv run
  }
  return { file: "uv", prefixArgs: ["run", "--from", "govio", "python"] };
}

interface WrapperReply {
  ok: boolean;
  excClass?: string;
  message?: string;
}

type WrapperRun =
  | { ok: true }
  | { ok: false; timedOut: boolean; message: string; excClass?: string };

/** 以 stdin JSON 驱动静态 wrapper（凭据零 argv/env/日志）；stdout 末行 JSON 为结构化回执 */
async function runGovioWrapper(
  payload: Record<string, unknown>,
  exec: ExecFn,
  timeoutMs: number,
): Promise<WrapperRun> {
  const python = await resolveGovioPython(exec);
  const res = await exec(python.file, [...python.prefixArgs, "-c", GOVIO_WRAPPER_SOURCE], {
    input: JSON.stringify(payload),
    timeoutMs,
  });
  if (res.timedOut) {
    return { ok: false, timedOut: true, message: "timeout" };
  }
  const lines = res.stdout.trim().split("\n").filter(Boolean);
  let reply: WrapperReply | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as WrapperReply;
      if (typeof parsed.ok === "boolean") reply = parsed;
    } catch {
      // 非 JSON 行（如告警）忽略，继续找结构化回执
    }
  }
  if (!reply) {
    return {
      ok: false,
      timedOut: false,
      message: res.stderr.trim() || "wrapper 无结构化回执",
    };
  }
  if (reply.ok) {
    return { ok: true };
  }
  return { ok: false, timedOut: false, message: reply.message ?? "操作失败", excClass: reply.excClass };
}

// ── 数据源增删改（凭据走 stdin wrapper） ─────────────────────────────────────

/** 添加数据源（update = 同名 + overwrite：单次 ConfigManager.save，保留备份语义，无中间态） */
export async function addDatasource(
  payload: WSOnboardingAddDatasource,
  exec: ExecFn = defaultExec,
): Promise<OnboardingResult<{ name: string }>> {
  const run = await runGovioWrapper(
    {
      op: "add_datasource",
      name: payload.name,
      url: payload.url,
      password: payload.password,
      connect_args: payload.connectArgs ?? {},
      overwrite: payload.overwrite ?? false,
    },
    exec,
    30_000,
  );
  if (run.ok) {
    return { ok: true, data: { name: payload.name } };
  }
  if (run.timedOut) {
    return fail("保存数据源超时", "timeout", "请重试；若反复超时请检查磁盘状态");
  }
  return fail(run.message, "exec", datasourceHint(run.message));
}

/** 删除数据源（无秘密，走 govio-cli argv；单次 save，图后端配置不受影响） */
export async function removeDatasource(
  name: string,
  exec: ExecFn = defaultExec,
): Promise<OnboardingResult<{ name: string }>> {
  const res = await exec("govio-cli", ["onboard", "--remove-datasource", name], { timeoutMs: 30_000 });
  if (res.exitCode === 0) {
    return { ok: true, data: { name } };
  }
  const message = res.stderr.trim() || res.stdout.trim() || "删除数据源失败";
  return fail(
    message,
    "exec",
    message.includes("不存在") ? "该数据源已不存在，刷新列表即可" : "请稍后重试",
  );
}

// ── 测试连接（stdin wrapper 探测，不落盘） ───────────────────────────────────

export type ConnectionErrorKind = "dns" | "host" | "port" | "auth" | "timeout" | "other";

const CONNECTION_HINTS: Record<ConnectionErrorKind, string> = {
  dns: "无法解析主机名，请检查 URL 中的主机名拼写，或检查本地 DNS 设置",
  host: "主机不可达，请检查网络连通性与防火墙规则",
  port: "连接被拒绝，请确认数据库服务已启动且端口正确",
  auth: "认证失败，请检查用户名与密码是否正确、账号是否被允许远程连接",
  timeout: "连接超时，请检查网络状况，或调大超时后重试",
  other: "连接失败，请检查 URL 格式与数据库服务状态",
};

/**
 * 连接错误分类（纯函数）：按异常类名 + 消息关键词归入 dns/host/port/auth/timeout/other。
 * 关键词启发式，阈值待 verify:secrets-isolation / 可用性测试实测后调（design.md 遗留）。
 */
export function classifyDatasourceError(message: string, excClass?: string): ConnectionErrorKind {
  const text = `${excClass ?? ""} ${message}`.toLowerCase();
  if (/timeout|timed out|超时/.test(text)) return "timeout";
  if (/getaddrinfo|resolve host|name or service not known|nodename nor servname|temporary failure in name resolution|no such host|dns/.test(text)) return "dns";
  if (/connection refused|actively refused|connection reset|could not connect|无法连接|拒绝连接/.test(text)) return "port";
  if (/authentication|access denied|password|auth|credential|login failed|28p01|1045|1698|凭证|认证/.test(text)) return "auth";
  if (/no route to host|host is down|network is unreachable|网络不可达|主机/.test(text)) return "host";
  return "other";
}

function datasourceHint(message: string): string {
  if (message.includes("已存在")) return "同名数据源已存在：勾选「覆盖」以更新，或换一个名称";
  if (message.includes("不含用户信息")) return "该 URL 不含用户信息（user@host），无法单独传密码：请把账号写进 URL（如 mysql+pymysql://user@host:3306/db），或去掉密码字段";
  if (message.includes("已包含密码")) return "URL 中已含密码，请清空单独的密码字段（二选一）";
  if (message.includes("URL 格式无效")) return "URL 需包含协议前缀，如 mysql+pymysql://user@host:3306/db 或 duckdb:///path/to/file.duckdb";
  return "请检查数据源名称与 URL 后重试";
}

/**
 * 测试连接：stdin wrapper 内 sqlalchemy.create_engine(url).connect()（duckdb 走只读文件探测），
 * **探测不落盘**（凭据只在内存 + stdin 管道）。失败给分类（errorKind）+ 可读修复指引。
 */
export async function testDatasource(
  payload: WSOnboardingTestDatasource,
  exec: ExecFn = defaultExec,
): Promise<OnboardingResult<{ latencyMs: number }>> {
  const started = Date.now();
  const run = await runGovioWrapper(
    {
      op: "test_connection",
      url: payload.url,
      password: payload.password,
      connect_args: payload.connectArgs ?? {},
    },
    exec,
    payload.timeoutMs ?? 20_000,
  );
  const latencyMs = Date.now() - started;
  if (run.ok) {
    return { ok: true, data: { latencyMs } };
  }
  if (run.timedOut) {
    return fail("连接超时", "timeout", CONNECTION_HINTS.timeout);
  }
  const kind = classifyDatasourceError(run.message, run.excClass);
  return fail(run.message, kind, CONNECTION_HINTS[kind]);
}

// ── 测试模型（ModelRuntime 轻探测） ──────────────────────────────────────────

export type TestModelRuntime = Pick<ModelRuntime, "getModel" | "getAvailable" | "completeSimple">;

/**
 * 测试模型：getAvailable 验证凭据可用性后对目标模型发最小请求（maxTokens=1），
 * 失败给可读原因（模型未注册 / 凭据不可用 / 请求失败 / 超时）。
 */
export async function testModel(
  runtime: TestModelRuntime,
  provider: string,
  modelId: string,
  timeoutMs = 30_000,
): Promise<OnboardingResult<{ latencyMs: number }>> {
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    return fail(
      `未找到模型 ${provider}/${modelId}`,
      "not_found",
      "请先在模型配置中保存该供应商与模型条目，然后再测试",
    );
  }
  let available: readonly { id: string }[];
  try {
    available = await runtime.getAvailable(provider);
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err),
      "auth",
      "请检查该供应商的 API key 是否正确、网络是否可达",
    );
  }
  if (!available.some((m) => m.id === modelId)) {
    return fail(
      "该模型当前不可用（API key 缺失或无效）",
      "auth",
      "请检查该供应商的 API key 是否正确、账户是否可用",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const reply = await runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
      { maxTokens: 1, maxRetries: 0, signal: controller.signal },
    );
    const latencyMs = Date.now() - started;
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      const timedOut = reply.stopReason === "aborted";
      return fail(
        timedOut ? "测试请求超时" : redactSecrets(reply.errorMessage ?? "模型请求失败"),
        timedOut ? "timeout" : "request",
        timedOut ? "请检查网络后重试" : "请检查 API key、baseUrl 与模型 ID 是否正确",
      );
    }
    return { ok: true, data: { latencyMs } };
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err),
      controller.signal.aborted ? "timeout" : "request",
      "请检查 API key、baseUrl 与网络后重试",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── 一键导元数据（govio-cli meta import-schema，仅 DuckDB） ──────────────────

export interface ImportMetadataParams {
  datasource: string;
  schemas: string;
  mode?: "update" | "rebuild" | "clear";
}

/**
 * 一键导元数据：`govio-cli meta import-schema`（仅 DuckDB）。非 DuckDB 不支持一键，
 * 返回可读引导文案（不是错误堆栈）。长耗时：onStdout 行经脱敏后转进度回调。
 */
export async function importMetadata(
  params: ImportMetadataParams,
  onProgress?: (message: string) => void,
  exec: ExecFn = defaultExec,
): Promise<OnboardingResult<{ mode: string }>> {
  const args = ["meta", "import-schema", "--datasource", params.datasource, "--schemas", params.schemas];
  const mode = params.mode ?? "update";
  args.push("--mode", mode);
  const res = await exec("govio-cli", args, {
    timeoutMs: 600_000,
    onStdout: (chunk) => onProgress?.(redactSecrets(chunk.trim()).slice(0, 200)),
  });
  if (res.exitCode === 0) {
    return { ok: true, data: { mode } };
  }
  const message = res.stderr.trim() || res.stdout.trim() || "导入元数据失败";
  if (message.includes("仅支持 DuckDB") || message.includes("不是 duckdb://")) {
    return fail(
      "一键导元数据目前仅支持 DuckDB 数据源",
      "unsupported",
      "其它类型（MySQL/PostgreSQL 等）请在聊天中描述要导入的表，由 agent 使用 govio-cli meta meta 命令导入",
    );
  }
  if (message.includes("不存在")) {
    return fail(message, "not_found", "请先在数据源管理器中添加该数据源，再导入元数据");
  }
  return fail(message, "exec", "请检查数据源与 schema 列表后重试");
}

// ── 环境自检（Step0 带进度自动修复） ─────────────────────────────────────────

/**
 * 环境自检/修复：包装 ensureGovioCli + downloadGovioSkills，带阶段进度回调。
 * 已就位时为快速 no-op（向导幂等可续做）。
 */
export async function runEnvCheck(
  onProgress?: (message: string) => void,
): Promise<OnboardingResult<{ cliVersion: string | null; skillsReady: boolean }>> {
  onProgress?.("检查 govio-cli…");
  try {
    await ensureGovioCli();
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err),
      "cli_install",
      "请确认已安装 uv（https://docs.astral.sh/uv/）且在 PATH 中，然后重试",
    );
  }
  onProgress?.("检查 govio 技能包…");
  try {
    await downloadGovioSkills();
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : String(err),
      "skills_download",
      "技能包从 GitHub Releases 下载失败：请检查网络（必要时配置代理）后重试",
    );
  }
  onProgress?.("环境就绪");
  return { ok: true, data: { cliVersion: await detectCliVersion(), skillsReady: await govioSkillsReady() } };
}
