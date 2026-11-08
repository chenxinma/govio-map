/**
 * T2.1 图谱查询执行器：`govio-cli query -c <cypher>` 的最小封装。
 *
 * 独立成小模块的原因：
 * - 图谱注入（`prompt-injection.ts`）需要**按参数数组**调用 govio-cli（Cypher 含空格，
 *   `agent.ts` 的 `runGovioCli` 按空格 split 会拆碎 `-c` 参数，不能复用）；
 * - 集成测试用 `vi.mock` 整体替换本模块，避免测试 spawn 真实 govio-cli；
 * - 验证脚本可直接向 `buildInjectionContext` 传 fake runner。
 *
 * 输出解析：govio-cli query 的 stdout 形如
 *   `Result output: .govio\output-<ts>.json rows: N columns: [...]`
 *   `[{"m.id": "...", ...}]`
 * 即状态行 + 一行紧凑 JSON 数组（`assets/schema.md` 同款形态，2026-11-05 实测 ladybug 后端）。
 */
import { execFile } from "node:child_process";

export type GraphRow = Record<string, unknown>;
export type GraphQueryRunner = (cypher: string) => Promise<GraphRow[]>;

/** 单条查询超时（毫秒）。注入在 prompt 组装路径上，宁可降级也不长时间阻塞会话。 */
export const GRAPH_QUERY_TIMEOUT_MS = 6000;

/** 执行一条 Cypher 查询并返回行数组；CLI 报错/输出不可解析时 reject（调用方降级）。 */
export const runGraphQuery: GraphQueryRunner = (cypher) =>
  new Promise((resolve, reject) => {
    execFile(
      "govio-cli",
      ["query", "-c", cypher],
      { encoding: "utf-8", timeout: GRAPH_QUERY_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseQueryRows(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });

/**
 * 从 govio-cli query 的 stdout 解析结果行。
 * 取首个以 `[` 开头的行（状态行以 `Result output:` 开头，不会误中）；
 * 兼容 pretty-print 多行 JSON（解析失败时把该行到结尾整体再试一次）。
 * 找不到结果行视为输出不可解析并抛错——空结果会打印 `[]`，不会走到这里。
 */
export function parseQueryRows(stdout: string): GraphRow[] {
  const lines = stdout.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trimStart().startsWith("["));
  if (idx < 0) {
    throw new Error(`govio-cli query 输出无结果行: ${stdout.slice(0, 200)}`);
  }
  const first = lines.slice(idx).join("\n");
  try {
    return JSON.parse(first) as GraphRow[];
  } catch {
    // 单行解析失败再尝试"该行即完整数组"的紧凑形态
    const one = lines[idx].trim();
    return JSON.parse(one) as GraphRow[];
  }
}
