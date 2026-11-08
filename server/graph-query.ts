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

/**
 * 单条查询超时（毫秒）。注入在 prompt 组装路径上，宁可降级也不长时间阻塞会话。
 *
 * 12s 而非 6s（BUGFIX-injection-graph-key）：注入会同时拉起最多 4 个 govio-cli 进程，
 * 实测单条在轻载下已约 4.3s（DIMENSION_USED 类边查询），叠加 dev server 负载后
 * 4 条并发集体逼近 6s 阀值，曾令会话留痕间歇性 degraded（图谱实体注入失败 →
 * semanticRefs 空 → 口径冲突检测静默跳过）。
 */
export const GRAPH_QUERY_TIMEOUT_MS = 12000;

/**
 * 失败诊断：execFile 的 error 只给 `Command failed: <cmd>`（stderr 常为空），
 * 留痕里只剩这一句无法定位是超时/非 0 退出/被杀。这里把退出码、信号、超时标记
 * 与 stderr/stdout 尾部拼进 message（BUGFIX-graph-query-diag）。
 */
export function describeExecError(error: Error, stderr: string, stdout: string): string {
  const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
  const parts = [String(error.message).split("\n")[0]];
  if (e.killed) parts.push("killed=true");
  if (e.signal) parts.push(`signal=${e.signal}`);
  if (typeof e.code === "number") parts.push(`exit=${e.code}`);
  else if (e.code) parts.push(`code=${e.code}`);
  const err = stderr.trim();
  if (err) parts.push(`stderr=${err.slice(0, 300)}`);
  const out = stdout.trim();
  if (out) parts.push(`stdout=${out.slice(0, 200)}`);
  return parts.join(" | ");
}

/**
 * 执行一条 Cypher 查询并返回行数组；CLI 报错/输出不可解析时 reject（调用方降级）。
 * 空结果是合法语义（未命中）：即使旧版 govio-cli 对空结果以非 0 退出码退出，也按空行处理。
 *
 * 失败重试一次（只读查询幂等）：注入路径曾因机器负载/瞬时故障间歇降级，
 * 而降级的代价是整轮图谱实体缺失（semanticRefs 空 → 口径检测静默跳过）。
 * 只在失败时付出额外延迟，不改变成功路径耗时。
 */
/**
 * 查询结果缓存（BUGFIX-injection-graph-key 后续）：
 *
 * 注入路径每轮 prompt 固定跑 3~4 条图谱查询，而单条 govio-cli 冷启动实测 2.5~4.3s，
 * 并发四跑在负载下会集体撞 12s 超时阀值（留痕实证 killed=true | signal=SIGTERM），
 * 导致整轮图谱实体缺失 → semanticRefs 空 → 口径检测静默跳过。
 * 图谱元数据是低频变更数据，按 Cypher 文本缓存即可消掉绝大部分 sparkawn 开销。
 */
const GRAPH_CACHE_TTL_MS = 10 * 60_000;
interface CacheEntry {
  rows: GraphRow[];
  at: number;
}
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<GraphRow[]>>();

/** 清空缓存（测试/元数据导入后主动失效） */
export function clearGraphQueryCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * 预热缓存：服务启动时后台跑一遍常用查询（不阻塞启程、失败静默）。
 * 首次 prompt 因此不再承担冷启动成本。
 */
export function prewarmGraphCache(cyphers: string[], timeoutMs = 30000): void {
  for (const cypher of cyphers) {
    if (cache.has(cypher) || inflight.has(cypher)) continue;
    const p = runGraphQueryOnce(cypher, timeoutMs)
      .then((rows) => {
        cache.set(cypher, { rows, at: Date.now() });
      })
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(cypher);
      });
    inflight.set(cypher, p.then(() => cache.get(cypher)?.rows ?? []));
  }
}

/**
 * 执行一条 Cypher 查询（带缓存 + 单次重试）。
 *
 * - 命中新鲜缓存：直接返回（不 spawn CLI）
 * - 命中过期缓存：先返回旧值，后台刷新（stale-while-revalidate）——绝不因刷新阻塞 prompt
 * - 未命中：去重后执行（同 Cypher 并发只跑一次），失败重试一次（只读查询幂等）
 */
export const runGraphQuery: GraphQueryRunner = (cypher) => {
  const hit = cache.get(cypher);
  if (hit && Date.now() - hit.at < GRAPH_CACHE_TTL_MS) return Promise.resolve(hit.rows);
  if (hit) {
    void fetchAndCache(cypher).catch(() => undefined);
    return Promise.resolve(hit.rows);
  }
  return fetchAndCache(cypher);
};

function fetchAndCache(cypher: string): Promise<GraphRow[]> {
  const existing = inflight.get(cypher);
  if (existing) return existing;
  const p = runGraphQueryOnce(cypher)
    .catch(() => runGraphQueryOnce(cypher))
    .then((rows) => {
      cache.set(cypher, { rows, at: Date.now() });
      return rows;
    })
    .finally(() => {
      inflight.delete(cypher);
    });
  inflight.set(cypher, p);
  return p;
}

function runGraphQueryOnce(cypher: string, timeoutMs = GRAPH_QUERY_TIMEOUT_MS): Promise<GraphRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "govio-cli",
      ["query", "-c", cypher],
      { encoding: "utf-8", timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          if (stdout && isEmptyResultOutput(stdout)) {
            resolve([]);
          } else {
            reject(new Error(describeExecError(error, stderr ?? "", stdout ?? "")));
          }
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
}

/**
 * 空结果形态：govio-cli 对无行查询打印 `Data not found.`（实测无 `[]` 行；
 * 旧版曾以非 0 退出码退出）——空结果不得当失败降级（BUGFIX-injection-graph-key）。
 */
export function isEmptyResultOutput(stdout: string): boolean {
  return /data not found/i.test(stdout);
}

/**
 * 从 govio-cli query 的 stdout 解析结果行。
 * 取首个以 `[` 开头的行（状态行以 `Result output:` 开头，不会误中）；
 * 兼容 pretty-print 多行 JSON（解析失败时把该行到结尾整体再试一次）。
 * 空结果（`Data not found.`）返回空数组；其余找不到结果行的输出视为不可解析并抛错。
 */
export function parseQueryRows(stdout: string): GraphRow[] {
  const lines = stdout.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trimStart().startsWith("["));
  if (idx < 0) {
    if (isEmptyResultOutput(stdout)) return [];
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
