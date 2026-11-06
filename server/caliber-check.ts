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

/** 短超时：口径比对是事后校验，绝不拖住 message_end 处理链 */
export const CALIBER_CLI_TIMEOUT_MS = 6000;

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
 */
export async function runCaliberCheck(
  sql: string,
  metricRefs: string[],
  runCli: CaliberCliRunner = runGovioCliWithArgs,
): Promise<CaliberCheck | undefined> {
  if (!sql || metricRefs.length === 0) return undefined;
  try {
    const stdout = await runCli(buildCaliberArgs(sql, metricRefs), CALIBER_CLI_TIMEOUT_MS);
    return parseCaliberOutput(stdout);
  } catch {
    return undefined;
  }
}
