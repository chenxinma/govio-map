/**
 * T2.3 口径冲突检测（map 侧）：调用 `govio-cli sql caliber` 完成 SQL 与图谱指标
 * 定义的比对，把结果挂到 sqlQuery 节点事件的 `caliberCheck` 字段。
 *
 * 比对逻辑只在 govio CLI（govio 仓 `src/govio/metadata/caliber.py`），本模块只做
 * 调用编排与结果透传，**不解析 SQL**。降级纪律（与 T2.1/T2.2 同款）：CLI 缺失/
 * 超时/报错/非 JSON/形状非法一律返回 undefined（调用方省略键）、不阻断、不重试。
 */
import type { CaliberCheck, CaliberDifference, CaliberStatus } from "../src/types/semantic.js";
import { runGovioCliWithArgs } from "./govio-cli-exec.js";

/**
 * 口径比对 CLI 超时。
 *
 * 12s 而非 6s：实测单次 `sql caliber` 约 1.3s，但它在 message_end 钩子里执行，与
 * agent 自身的 govio-cli（observe load 等）并发，负载下会迅速膨胀；旧 6s 一旦超时
 * 就被降级为 undefined → 节点静默无 caliberCheck（实测 gov-46/48/52：有 semanticRefs 但无 check）。
 */
export const CALIBER_CLI_TIMEOUT_MS = 12000;

/** CLI 执行器签名（与 runGovioCliWithArgs 一致），verify 脚本可注入 stub */
export type CaliberCliRunner = (args: string[], timeoutMs?: number) => Promise<string>;

const STATUSES: readonly CaliberStatus[] = ["consistent", "conflict", "unknown"];

/**
 * 组装 `govio-cli sql caliber` 参数。SQL 全文作为单个参数传 `--sql`，
 * 指标（semanticRef 的 code，缺 code 用节点 ID）经可重复 `--metric` 传入。
 */
export function buildCaliberArgs(sql: string, metricRefs: string[]): string[] {
  return ["sql", "caliber", "--sql", sql, ...metricRefs.flatMap((ref) => ["--metric", ref])];
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function parseDifference(raw: unknown, metricCode?: string, metricName?: string): CaliberDifference | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  if (!isString(d.aspect) || !isString(d.expected) || !isString(d.found)) return undefined;
  return {
    ...(metricCode !== undefined ? { metricCode } : {}),
    ...(metricName !== undefined ? { metricName } : {}),
    aspect: d.aspect,
    expected: d.expected,
    found: d.found,
    ...(isString(d.detail) ? { detail: d.detail } : {}),
  };
}

/**
 * 解析 CLI stdout JSON 为 `CaliberCheck`。
 *
 * CLI 形态：`{results: [{metric: {id?,code?,name?}, status, differences: [...]}]}`。
 * 汇总 status：任一 conflict → conflict；否则任一 unknown → unknown；否则 consistent。
 * 形状非法（非对象/缺 results/status 越界/differences 非法）返回 undefined（省略键）。
 */
export function parseCaliberOutput(stdout: string): CaliberCheck | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const results = (parsed as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length === 0) return undefined;

  const differences: CaliberDifference[] = [];
  let sawUnknown = false;
  let sawConflict = false;

  for (const raw of results) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const r = raw as Record<string, unknown>;
    const status = r.status;
    if (!isString(status) || !STATUSES.includes(status as CaliberStatus)) return undefined;
    if (!Array.isArray(r.differences)) return undefined;
    if (status === "conflict") sawConflict = true;
    if (status === "unknown") sawUnknown = true;

    const metric = (typeof r.metric === "object" && r.metric !== null ? r.metric : {}) as Record<string, unknown>;
    const metricCode = isString(metric.code) ? metric.code : undefined;
    const metricName = isString(metric.name) ? metric.name : undefined;

    for (const rawDiff of r.differences) {
      const diff = parseDifference(rawDiff, metricCode, metricName);
      if (!diff) return undefined;
      differences.push(diff);
    }
  }

  return {
    status: sawConflict ? "conflict" : sawUnknown ? "unknown" : "consistent",
    differences,
  };
}

/**
 * 跑一次口径冲突检测。永不 throw：任何失败返回 undefined（调用方省略键）。
 *
 * 失败重试一次（比对是只读纯 CLI 调用，幂等）：沉默降级会让节点静默缺失黄灯，
 * 而重试只在失败路径付出延迟。仍失败则告警留底（不再无声无息）。
 */
export async function runCaliberCheck(
  sql: string,
  metricRefs: string[],
  runCli: CaliberCliRunner = runGovioCliWithArgs,
): Promise<CaliberCheck | undefined> {
  if (!sql || metricRefs.length === 0) return undefined;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const stdout = await runCli(buildCaliberArgs(sql, metricRefs), CALIBER_CLI_TIMEOUT_MS);
      const parsed = parseCaliberOutput(stdout);
      if (parsed) return parsed;
      lastError = `输出不可解析（前 120 字）：${stdout.slice(0, 120)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  console.warn(`[caliber] 检测失败，省略 caliberCheck：metrics=${metricRefs.join(",")} err=${lastError}`);
  return undefined;
}
