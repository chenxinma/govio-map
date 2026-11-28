import { execFile } from "node:child_process";
import { redactForLog, redactSecrets } from "./secret-guard.js";

/**
 * 以**数组参数**方式调用 govio-cli（`execFile`，不经 shell）。
 *
 * 与 `agent.ts` 的 `runGovioCli(cmd)`（按空格切分字符串）不同：SQL 全文里的空格、
 * 引号、换行都需要作为一个完整参数传给 `--sql`，只有数组参数才不会被拆坏。
 * 因此 SQL 编辑器执行（`POST /api/execute-sql`）与 DataFrame 复跑
 * （`POST /api/rerun-dataframe`，见 `dataframe-rerun.ts`）都走这里。
 *
 * @param args      CLI 参数数组，如 `["observe", "load", "--name", "df_a", "--sql", sql]`
 * @param timeoutMs 超时（毫秒）。默认 30s 沿用 SQL 编辑器；复跑重查询可传更大值。
 */
export function runGovioCliWithArgs(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("govio-cli", args, { encoding: "utf-8", timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        // 日志脱敏（X34）：args 可内嵌 `--sql` 全文（含连接串/密码），错误信息也可能回显它。
        console.error(`[govio-cli] args=${redactForLog(args)} failed:`, redactSecrets(stderr || error.message));
        reject(new Error(stderr?.trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}
