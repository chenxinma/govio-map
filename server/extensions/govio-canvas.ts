import { pushGovioNode, type GovioNodeCreateEvent } from "../govio-node-queue.js";
import {
  isLoadFailure,
  observeColumnName,
  parseObserveLoadOutput,
  type ObserveColumn,
  type ObserveLoadOutput,
} from "../observe-load-schema.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { permissionManager } from "../permission-manager.js";
import { DATASOURCE_TYPES, type DatasourceType } from "../../src/types/index.js";
import {
  buildManifest,
  piSessionContext,
  toManifestModelFromMessage,
  type ManifestSessionContext,
} from "../analysis-manifest.js";

const OBSERVE_LOAD_RE = /\bgovio-cli\s+observe\s+load\b/;
const OUTPUT_FLAG_RE = /(?:^|\s|=)(?:-o|--output)(?=\s|=|$)/;

/**
 * Obviously destructive / exfiltration-prone shell commands. The agent runs
 * with the user's full shell privileges, so anything matching this list always
 * requires an explicit user approval, even in a fast-moving session.
 * Deliberately conservative: only high-risk, rarely-legitimate patterns.
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,            // rm -rf / rm -f ...
  /\b(?:sudo|doas|runas)\b/,                     // privilege escalation
  /\b(?:mkfs|format\s+[a-z]:|diskpart|fdisk)\b/i, // disk destruction
  /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  /\breg\s+delete\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sfq]/i,
  /\bgit\s+push\b/,                              // publishes local state to a remote
  /\b(?:curl|wget|Invoke-WebRequest)\b[^|;&]*\|\s*(?:ba)?sh\b/i, // download-and-execute
  /\b(?:nc|ncat|netcat)\b.*\s-e\b/i,             // reverse shells
];

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(cmd));
}

/** 枚举外的 datasourceType 取值（如 tds）不落盘：省略字段而非猜测/造値（T2.0） */
function normalizeDatasourceType(value: string | undefined): DatasourceType | undefined {
  if (!value) return undefined;
  return (DATASOURCE_TYPES as readonly string[]).includes(value) ? (value as DatasourceType) : undefined;
}

export function shouldAskPermission(cmd: string): boolean {
  if (isDangerousCommand(cmd)) return true;
  if (!OBSERVE_LOAD_RE.test(cmd)) return false;
  return OUTPUT_FLAG_RE.test(cmd);
}

// ── Helpers ────────────────────────────────────────────────────────

function extractBashCommand(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command : "";
}

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

function extractNamedArg(cmd: string, flag: string): string | null {
  // Match --flag <value> or -f <value> (single-letter short form)
  const re = new RegExp(`(?:--${flag}|(?<![\\w-])-${flag[0]}\\b)[=\\s]+(\\S+)`);
  const match = cmd.match(re);
  return match ? match[1] : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从 `observe load` 命令中取出 `--sql` 的完整值（Manifest 固化 SQL 全文用）。
 * 支持 `--sql "..."`、`--sql '...'`、`--sql=...` 与多行 SQL；引号内的转义引号
 * 会被还原。取不到时返回空串（不猜测、不回退到整条命令，避免把 shell 参数
 * 当成 SQL 固化进留痕）。
 */
export function extractSqlFromCommand(cmd: string): string {
  const flag = /--sql(?:=|\s+)/.exec(cmd);
  if (!flag) return "";
  const rest = cmd.slice(flag.index + flag[0].length);
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\") { i++; continue; }
      if (rest[i] === quote) {
        return rest.slice(1, i).replace(new RegExp(`\\\\([${quote}\\\\])`, "g"), "$1");
      }
    }
    // 引号未闭合（多行 SQL 被 shell 折行）：取余下全部内容。
    return rest.slice(1);
  }
  // 未加引号：取到下一个 flag 之前，避免把 `-o out.parquet` 之类尾巴算进 SQL。
  return rest.split(/\s+(?=-{1,2}[\w-])/)[0].trim();
}

function parseObserveSubcommand(cmd: string): string | null {
  const match = cmd.match(/govio-cli\s+observe\s+(\S+)/);
  return match ? match[1] : null;
}

function parseLoadArgs(cmd: string): { name: string; datasource: string | null; memory: boolean } | null {
  const name = extractNamedArg(cmd, "name");
  if (!name) return null;
  const datasource = extractNamedArg(cmd, "datasource");
  const memory = /(?:^|\s)--memory(?=\s|$)/.test(cmd);
  // --datasource and --memory are mutually exclusive; one must be present.
  // If both are provided, prefer --memory (the more specific intent).
  if (!datasource && !memory) return null;
  if (datasource && memory) {
    return { name, datasource: null, memory: true };
  }
  return { name, datasource, memory };
}

function parseCompareArgs(cmd: string): { source: string; target: string; joinColumns: string[] } | null {
  const source = extractNamedArg(cmd, "source");
  const target = extractNamedArg(cmd, "target");
  if (!source || !target) return null;
  const joinColumnsRaw = extractNamedArg(cmd, "join-columns");
  const joinColumns = joinColumnsRaw ? joinColumnsRaw.split(",") : [];
  return { source, target, joinColumns };
}

// function parseReleaseArgs(cmd: string): { name: string } | null {
//   const name = extractNamedArg(cmd, "name");
//   return name ? { name } : null;
// }

function parseExploreArgs(cmd: string): { dataframes: string[] } | null {
  const match = cmd.match(/--dataframes\s+((?:\S+\s*)+)/);
  if (!match) return null;
  return { dataframes: match[1].trim().split(/\s+/) };
}


/**
 * 判断一段已解析的 `observe load` 输出是否是「可信的成功载荷」。
 *
 * 为什么需要：agent 常给 CLI 加摘要管道（如 `2>&1 | jq '{name, rows, columns, schema}'`）。
 * 当底层 SQL 执行失败时，CLI 输出 `{"success": false, "error": "..."}`（退出码仍可能为 0），
 * 经 jq 投影后变成 `{"name": null, "rows": null, "columns": null, "schema": null}`——
 * 合法 JSON，但既没有 `success === false` 可供拦截，也没有任何行/列信息。
 * 若把它当作成功载荷，就会为一次失败的加载建出 0 行节点、固化错误 SQL，
 * 之后真正成功的加载又因 dfName 去重（manifest 已存在不回填）而被丢弃。
 *
 * 规则：只有出现真实的成功信号——数值型 `rows`、或 `column_info`/`schema` 数组、
 * 或显式 `success === true`——才可信；否则视为失败/摘要噪声，交由 ObserveStore 复核。
 *
 * 与 `observe-load-schema.ts` 的分工（X5）：schema 校验（parseObserveLoadOutput）
 * 拦「形状不合法」（非法 JSON、字段类型漂移），本谓词拦「形状合法但语义不可信」
 * （jq 全 null 投影没有 success:false 可拦截，也没有任何成功信号）。两层缺一不可。
 */
export function isTrustworthyLoadOutput(load: ObserveLoadOutput | null): boolean {
  if (!load || load.success === false) return false;
  if (load.success === true) return true;
  return typeof load.rows === "number" || Array.isArray(load.column_info) || Array.isArray(load.schema);
}
/**
 * jq 摘要管道（如 `| jq '{success,error,name,rows,columns}'`）会保留成功信号与行列数，
 * 但丢掉 `column_info`（列结构）。若直接采用，节点列结构表为空、Manifest 也因无列信息
 * 而不产出校验和（漂移检测退化为行/列数对比）。此函数用 ObserveStore 的 `observe info`
 * 结果补列信息；行/列数仍以 load 输出为准。纯函数便于单测；info 为 null 时原样返回。
 */
export function enrichLoadOutput(load: ObserveLoadOutput, info: ObserveLoadOutput | null): ObserveLoadOutput {
  if (Array.isArray(load.column_info) || Array.isArray(load.schema) || !info) return load;
  const column_info = info.column_info ?? info.schema ?? [];
  return { ...load, column_info, ...(info.schema ? { schema: info.schema } : {}) };
}

/**
 * Read DataFrame stats from the ObserveStore. Agent-added shell pipelines
 * (`| tail -20`, `2>&1 | head`) truncate or prefix the CLI's JSON, so the bash
 * stdout of `observe load` cannot be trusted for node creation.
 * Returns null for an invalid name, a missing DataFrame, or a CLI failure.
 */
async function readObserveInfo(dfName: string): Promise<ObserveLoadOutput | null> {
  // dfName is interpolated into a shell command - restrict to safe identifiers.
  if (!/^[A-Za-z0-9_]+$/.test(dfName)) return null;
  try {
    const { runGovioCli } = await import("../agent.js");
    // --rows 0 avoids pulling sample data (schema only).
    const info = parseObserveLoadOutput(await runGovioCli(`observe info --name ${dfName} --rows 0`));
    return info && info.success !== false ? info : null;
  } catch {
    return null;
  }
}

function mapColumnInfo(
  columns: ObserveColumn[],
  totalRows: number,
): Array<{ name: string; dtype: string; nonNull: number }> {
  return columns.map((c) => ({
    name: observeColumnName(c),
    dtype: c.dtype ?? "",
    nonNull: totalRows,
  }));
}

function estimateMemoryUsage(rows: number, cols: number): string {
  const bytes = rows * cols * 8;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractAssistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return extractTextContent(message.content);
}

function extractSelectColumns(sql: string): string[] {
  const match = sql.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((col) => col.trim())
    .map((col) => {
      const aliasMatch = col.match(/\s+AS\s+(\S+)$/i);
      if (aliasMatch) return aliasMatch[1];
      const dotMatch = col.match(/\.(\S+)$/);
      if (dotMatch) return dotMatch[1];
      return col;
    })
    .filter((col) => col !== "*" && !col.includes("("));
}

function extractSqlCodeBlocks(text: string): Array<{ sql: string; outputColumns: string[] }> {
  const blocks: Array<{ sql: string; outputColumns: string[] }> = [];
  const regex = /```sql\s*\n([\s\S]*?)```/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const sql = match[1].trim();
    if (sql.startsWith("MATCH")) continue; // skip Cypher statements
    if (sql) {
      blocks.push({ sql, outputColumns: extractSelectColumns(sql) });
    }
  }
  return blocks;
}

function extractTableName(sql: string): string {
  const match = sql.match(/FROM\s+([\w.]+)/i);
  if (!match) return "";
  const parts = match[1].split(".");
  return parts.length > 1 ? parts[1] : parts[0];
}

function extractDfName(text: string): string | null {
  const nameMatch = text.match(/(?:定名|命名|命名为|name(?:d)?\s+(?:as)?|dfName\s*[:=])\s*(df_\w+)/i)
    || text.match(/(df_\w+)/i);
  return nameMatch ? nameMatch[1] : null;
}

let dfCounter = 0;
function nextDfName(): string {
  dfCounter++;
  return `df_query_${dfCounter}`;
}

// ── Chart trace resolution (Plotly) ───────────────────────────────

// ponytail: hard cap protects the chart node event size; >200 leaves should be
// truncated agent-side in SQL (see treemap design doc) anyway.
const TREEMAP_ROW_CAP = 2000;

interface ChartTrace {
  type?: string;
  [key: string]: unknown;
}

/**
 * Aggregate flat leaf rows into the flat ids/labels/parents/values hierarchy
 * Plotly's treemap trace needs (branchvalues:"total"). Exported for the
 * self-check below.
 */
export function buildTreemapHierarchy(
  rows: Array<Record<string, unknown>>,
  key: string,
  groups: string[],
): { ids: string[]; labels: string[]; parents: string[]; values: number[] } {
  // Aggregate rows bottom-up along the group path. branchvalues:"total"
  // requires every parent's value to equal the sum of its descendants, which
  // the path-prefix aggregation guarantees. Null group keys would render as
  // literal "null" blocks in the treemap.
  const nodeValue = new Map<string, number>();
  for (const row of rows) {
    const segs: string[] = [];
    for (const g of groups) {
      segs.push(String(row[g] ?? "未指定"));
      const path = segs.join("/");
      nodeValue.set(path, (nodeValue.get(path) ?? 0) + Number(row[key] ?? 0));
    }
  }
  const ids: string[] = [];
  const labels: string[] = [];
  const parents: string[] = [];
  const values: number[] = [];
  for (const [path, value] of nodeValue) {
    const segs = path.split("/");
    ids.push(path);
    labels.push(segs[segs.length - 1]);
    parents.push(segs.length > 1 ? segs.slice(0, -1).join("/") : "");
    values.push(value);
  }
  return { ids, labels, parents, values };
}

/**
 * Treemap traces reference an ObserveStore DataFrame via `treeDf` instead of
 * inline rows. Fetch rows server-side and build the flat ids/labels/parents/
 * values hierarchy Plotly needs, so the agent never reads data content
 * (observe info --rows / load -o) to build the chart config.
 */
async function resolveTreemapTrace(trace: ChartTrace): Promise<string[]> {
  const notes: string[] = [];
  const treeDf = typeof trace.treeDf === "string" ? trace.treeDf : "";
  if (!treeDf) {
    throw new Error("treemap trace requires treeDf (ObserveStore DataFrame name).");
  }
  // dfName is interpolated into a shell command - restrict to safe identifiers.
  if (!/^[A-Za-z0-9_]+$/.test(treeDf)) {
    throw new Error(`Invalid treeDf '${treeDf}': only letters, digits and underscores are allowed.`);
  }
  const key = typeof trace.key === "string" ? trace.key : "";
  const groups = Array.isArray(trace.groups) ? (trace.groups as string[]) : [];
  if (!key || groups.length === 0) {
    throw new Error("treemap trace requires key (numeric weight column) and groups (hierarchy path columns).");
  }
  let sample: Array<Record<string, unknown>>;
  let totalRows: number;
  try {
    const { runGovioCli } = await import("../agent.js");
    const out = await runGovioCli(`observe info --name ${treeDf} --rows ${TREEMAP_ROW_CAP}`);
    const info = JSON.parse(out);
    if (!info || info.success === false) {
      throw new Error(
        `DataFrame '${treeDf}' not found in ObserveStore (${info?.error ?? "unknown error"}). Load it first via 'govio-cli observe load'.`,
      );
    }
    sample = Array.isArray(info.sample) ? info.sample : [];
    totalRows = info.rows || 0;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("DataFrame '")) throw err;
    throw new Error(`Failed to resolve tree from '${treeDf}': ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const { ids, labels, parents, values } = buildTreemapHierarchy(sample, key, groups);
  delete trace.treeDf;
  delete trace.key;
  delete trace.groups;
  Object.assign(trace, { ids, labels, parents, values, branchvalues: "total" });
  notes.push(`treemap: resolved ${sample.length} rows from ObserveStore DataFrame '${treeDf}' into ${ids.length} nodes`);
  if (totalRows > TREEMAP_ROW_CAP) {
    notes.push(`warning: '${treeDf}' has ${totalRows} rows, only first ${TREEMAP_ROW_CAP} used. Re-aggregate in SQL (e.g. drop a group level or bucket small values into 'Other') for a readable treemap.`);
  }
  return notes;
}

/**
 * Normalize the agent-friendly trace vocabulary into native Plotly traces
 * (line -> scatter+lines, doughnut -> pie+hole) and resolve treemap treeDf
 * references. Sets config.type to the chart type label for the node header.
 */
async function resolveChartConfig(config: { data?: ChartTrace[]; [key: string]: unknown }): Promise<string[]> {
  const notes: string[] = [];
  const traces = Array.isArray(config.data) ? config.data : [];
  if (!config.type && typeof traces[0]?.type === "string") {
    config.type = traces[0].type;
  }
  // Plotly default margins (l/r 80, t 100, b 80) waste half of a 420px node.
  // Fill compact defaults; explicit layout.margin keys still win.
  const layout = (config.layout ?? {}) as Record<string, unknown>;
  layout.margin = {
    l: 45, r: 15, t: 25, b: 35, pad: 0,
    ...(typeof layout.margin === "object" && layout.margin !== null ? layout.margin : {}),
  };
  config.layout = layout;
  for (const trace of traces) {
    switch (trace.type) {
      case "line":
        trace.type = "scatter";
        if (trace.mode === undefined) trace.mode = "lines+markers";
        break;
      case "scatter":
        if (trace.mode === undefined) trace.mode = "markers";
        break;
      case "doughnut":
        trace.type = "pie";
        if (trace.hole === undefined) trace.hole = 0.6;
        break;
      case "treemap":
        notes.push(...(await resolveTreemapTrace(trace)));
        break;
    }
  }
  return notes;
}

function formatCompareResult(parsed: {
  schema?: {
    match?: boolean;
    source_only?: string[];
    target_only?: string[];
    common_columns?: string[];
  };
  data?: { report?: string };
}): string {
  const lines: string[] = [];
  if (parsed.schema) {
    const s = parsed.schema;
    lines.push(`## Schema Comparison`);
    lines.push(`- Match: ${s.match ? "Yes" : "No"}`);
    if (s.common_columns?.length) lines.push(`- Common columns: ${s.common_columns.join(", ")}`);
    if (s.source_only?.length) lines.push(`- Source only: ${s.source_only.join(", ")}`);
    if (s.target_only?.length) lines.push(`- Target only: ${s.target_only.join(", ")}`);
  }
  if (parsed.data?.report) {
    lines.push("");
    lines.push(`## Data Comparison`);
    lines.push(parsed.data.report);
  }
  return lines.join("\n");
}

function formatExploreResult(parsed: {
  foreign_keys?: Array<{ source_table: string; source_column: string; target_table: string; target_column: string; confidence: number }>;
  column_similarities?: Array<{ table1: string; column1: string; table2: string; column2: string; similarity: number }>;
}): string {
  const lines: string[] = [];
  if (parsed.foreign_keys?.length) {
    lines.push(`## Foreign Keys`);
    lines.push(`| Source | Target | Confidence |`);
    lines.push(`|--------|--------|------------|`);
    for (const fk of parsed.foreign_keys) {
      lines.push(
        `| ${fk.source_table}.${fk.source_column} | ${fk.target_table}.${fk.target_column} | ${(fk.confidence * 100).toFixed(0)}% |`,
      );
    }
  }
  if (parsed.column_similarities?.length) {
    lines.push(``);
    lines.push(`## Column Similarities`);
    lines.push(`| Column A | Column B | Similarity |`);
    lines.push(`|----------|----------|------------|`);
    for (const sim of parsed.column_similarities) {
      lines.push(
        `| ${sim.table1}.${sim.column1} | ${sim.table2}.${sim.column2} | ${(sim.similarity * 100).toFixed(0)}% |`,
      );
    }
  }
  return lines.join("\n");
}

function extractExploreSources(parsed: {
  foreign_keys?: Array<{ source_table: string; target_table: string }>;
  column_similarities?: Array<{ table1: string; table2: string }>;
}): Array<{ label: string }> {
  const seen = new Set<string>();
  const refs: Array<{ label: string }> = [];
  const tables: string[] = [];
  for (const fk of parsed.foreign_keys ?? []) {
    tables.push(fk.source_table, fk.target_table);
  }
  for (const sim of parsed.column_similarities ?? []) {
    tables.push(sim.table1, sim.table2);
  }
  for (const t of tables) {
    if (t && !seen.has(t)) {
      seen.add(t);
      refs.push({ label: t });
    }
  }
  return refs;
}

// ── Event Handlers ─────────────────────────────────────────────────

async function handleLoadResult(
  cmd: string,
  stdout: string,
  context: ManifestSessionContext,
  permissionDecisionId: string | null,
): Promise<void> {
  const args = parseLoadArgs(cmd);
  if (!args) return;
  // Validate dfName to prevent injection into downstream commands or display issues.
  if (!/^[A-Za-z0-9_]+$/.test(args.name)) return;
  // stdout is not valid JSON (typically `| head` truncation) or drifts from the
  // shared ObserveLoadOutput contract — fall back to the ObserveStore below.
  const load = parseObserveLoadOutput(stdout);
  if (!load) {
    console.warn(`[govio-canvas] handleLoadResult output rejected for '${args.name}': invalid JSON or schema drift (stdout length: ${stdout.length}, first 120 chars: ${JSON.stringify(stdout.slice(0, 120))})`);
  }
  if (isLoadFailure(load)) return;
  // stdout 可能被摘要管道（jq/head）改写成合法但不可信的 JSON（失败加载投影成
  // 全 null 字段）。只有可信的成功载荷才直接采用；否则回退到 ObserveStore 复核，
  // 复核不到（说明确实没加载成功）就不建节点，避免为失败加载固化错误 Manifest。
  const trusted = isTrustworthyLoadOutput(load);
  let parsed: ObserveLoadOutput | null = trusted ? load : (await readObserveInfo(args.name));
  if (!parsed) return;
  // 摘要管道丢列结构时，用 ObserveStore 补列信息（节点列结构与 Manifest 校验和依赖它）
  if (trusted && !Array.isArray(parsed.column_info) && !Array.isArray(parsed.schema)) {
    parsed = enrichLoadOutput(parsed, await readObserveInfo(args.name));
  }
  const columns = mapColumnInfo(parsed.column_info || parsed.schema || [], parsed.rows || 0);
  // --datasource loads come from a DB; --memory loads derive from upstream
  // DataFrames, whose names are reported back as `source_tables`.
  const sourceName = args.datasource ?? (args.memory ? "memory" : "");
  // --memory injects ALL loaded DataFrames into DuckDB, so `source_tables`
  // lists every loaded df - not just those this SQL actually references.
  // Filter to names that appear in the SQL so lineage edges stay precise.
  // Extract only the SQL portion from the command to avoid false matches
  // against --name or other flag values.
  const sqlText = extractSqlFromCommand(cmd);
  // source_tables only exists on the load output (not on observe info), so a
  // mangled --memory stdout simply loses the lineage edges.
  // 取不到 --sql 时退回整条命令做血缘匹配（保持原行为），但 Manifest 仍只固化 SQL 本身。
  const lineageText = sqlText || cmd;
  const sourceDataFrames =
    args.memory && Array.isArray(parsed.source_tables)
      ? parsed.source_tables.filter((t: string) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(lineageText))
      : undefined;
  const sourceRefs = sourceDataFrames && sourceDataFrames.length > 0
    ? sourceDataFrames.map((t: string) => ({ label: t }))
    : undefined;
  const rowCount = parsed.rows || 0;
  const columnCount = parsed.columns || columns.length;
  pushGovioNode({
    nodeType: "dataFrame",
    title: `DF: ${args.name}`,
    dfName: args.name,
    sourceName,
    totalRows: rowCount,
    totalColumns: columnCount,
    memoryUsage: estimateMemoryUsage(rowCount, columnCount),
    columns,
    ...(sourceRefs ? { sourceRefs } : {}),
    manifest: buildManifest({
      origin: "observe-load",
      sql: sqlText,
      datasource: sourceName,
      dfName: args.name,
      columns: columns.map((c) => ({ name: c.name, dtype: c.dtype })),
      rowCount,
      columnCount,
      context,
      // 本次加载过确认门时回填决策 ID（审计日志 `<session>.jsonl.audit.jsonl` 可回查）；
      // 没带 `-o` 的加载不经确认门，为 null。
      permissionDecisionId,
      ...(sourceDataFrames && sourceDataFrames.length > 0 ? { sourceDataFrames } : {}),
    }),
  });
}

function handleCompareResult(cmd: string, stdout: string): void {
  const args = parseCompareArgs(cmd);
  if (!args) return;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) return;
    const content = formatCompareResult(parsed);
    pushGovioNode({
      nodeType: "report",
      title: `Diff: ${args.source} vs ${args.target}`,
      reportType: "diff",
      content,
      sourceRefs: [{ label: args.source }, { label: args.target }],
    });
  } catch (err) {
    console.warn(`[govio-canvas] handleCompareResult JSON parse failed: ${err instanceof Error ? err.message : String(err)} (stdout length: ${stdout.length})`);
  }
}

function handleExploreResult(cmd: string, stdout: string): void {
  const args = parseExploreArgs(cmd);
  if (!args) return;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) return;
    const foreignKeys = parsed.foreign_keys || [];
    const columnSimilarities = parsed.column_similarities || [];
    if (foreignKeys.length === 0 && columnSimilarities.length === 0) return;
    const content = formatExploreResult(parsed);
    const sourceRefs = args
      ? args.dataframes.map((df) => ({ label: df }))
      : extractExploreSources(parsed);
    pushGovioNode({
      nodeType: "report",
      title: `Correlation: ${sourceRefs.map((r) => r.label).join(" & ")}`,
      reportType: "correlation",
      content,
      sourceRefs,
    });
  } catch (err) {
    console.warn(`[govio-canvas] handleExploreResult JSON parse failed: ${err instanceof Error ? err.message : String(err)} (stdout length: ${stdout.length})`);
  }
}


// function handleReleaseResult(cmd: string): void {
//   const args = parseReleaseArgs(cmd);
//   if (!args) return;
//   pushGovioNode({
//     nodeType: "report",
//     title: `Released: ${args.name}`,
//     reportType: "diff",
//     content: `DataFrame \`${args.name}\` has been released from memory.`,
//     sourceRefs: [{ label: args.name }],
//   });
// }

// ── Extension Entry ────────────────────────────────────────────────

export default function govioCanvasExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "govio_create_source_table",
    label: "Govio Source Table",
    description:
      "Create a source table node on the canvas showing the column schema. Each field must carry all three parts from the govio physical-table column query result: column name (column_name), description name (name) and data type (data_type). Call this after querying a PhysicalTable's column structure via govio-cli query. " +
      "Datasource annotation (datasource/datasourceType/schema/qualifiedName) must come from authoritative sources, NEVER guessed: the graph query result (PhysicalTable `schema`/`full_table_name`; Datasource node `datasource_name`/`source_type` when present) or the datasource declaration (meta datasource file `source_type`; observe config.yaml datasources url scheme, e.g. duckdb:// means duckdb). " +
      "qualifiedName is the table reference to use inside SQL: duckdb needs three-part catalog.schema.table (e.g. chocolate.chocolate.dim_product - a bare table name fails with 'does not exist' and two parts with 'Ambiguous reference'), postgres uses schema.table, mysql uses the bare table name or db.table. " +
      "If a value cannot be obtained from those sources, OMIT the parameter instead of inventing one.",
    parameters: Type.Object({
      tableName: Type.String({ description: "Physical table name `full_table_name`" }),
      database: Type.Optional(Type.String({ description: "Database name" })),
      fields: Type.Array(
        Type.Object({
          name: Type.String({ description: "物理列名，取查询结果的 `column_name`" }),
          type: Type.String({ description: "数据类型，取查询结果的 `data_type`" }),
          description: Type.Optional(Type.String({ description: "列的描述名称（业务/中文名），取查询结果的 `name` 字段；查询结果中存在时必须传入，节点上与 column_name、data_type 一起展示" })),
          references: Type.Optional(
            Type.Object({
              table: Type.String({ description: "Referenced table name" }),
              field: Type.String({ description: "Referenced column name" }),
            })
          ),
        }),
        { description: "Column definitions of the table" }
      ),
      datasource: Type.Optional(Type.String({ description: "数据源名（observe config.yaml 的 datasources 键，即 `observe load --datasource` 的取值，如 'chocolate'）。来源：图谱 Datasource 节点 datasource_name、数据源声明文件或用户指令；拿不到就省略，不得猜测" })),
      datasourceType: Type.Optional(Type.String({ description: "数据源类型：'duckdb' | 'postgres' | 'mysql' | 'oracle' | 'hive' | 'trino' | 'sqlalchemy-generic' | 'unknown'。来源（不得猜测，拿不到就省略）：图谱 Datasource 节点 source_type、数据源声明文件 source_type、或 observe config.yaml 该数据源 url scheme（duckdb:// → 'duckdb'；其他 SQLAlchemy URL 能判定则填对应类型，判不了填 'sqlalchemy-generic'）" })),
      schema: Type.Optional(Type.String({ description: "所属 schema，取图谱 PhysicalTable 查询结果的 `schema` 属性（如 'chocolate'）；拿不到就省略，不得猜测" })),
      qualifiedName: Type.Optional(Type.String({ description: "SQL 中应使用的全限定表名，按 datasourceType 构造：duckdb 三段式 catalog.schema.table（文件库 catalog=库文件名，如 'chocolate.chocolate.dim_product'；裸表名报 does not exist、两段式报 Ambiguous reference）；postgres 两段式 schema.table；mysql 裸表名或 db.table。来源：图谱 PhysicalTable.full_table_name（schema.table）+ 数据源类型按上述规则构造，或查询结果直接给出；构造不出就省略，不得猜测" })),
    }),
    execute: async (_toolCallId, params) => {
      const datasourceType = normalizeDatasourceType(params.datasourceType);
      pushGovioNode({
        nodeType: "sourceTable",
        title: params.tableName,
        tableName: params.tableName,
        database: params.database || "",
        fields: params.fields,
        // 数据源标注（T2.0）：仅在 agent 提供了可信取值时透传，缺失不写键
        ...(params.datasource ? { datasource: params.datasource } : {}),
        ...(datasourceType ? { datasourceType } : {}),
        ...(params.schema ? { schema: params.schema } : {}),
        ...(params.qualifiedName ? { qualifiedName: params.qualifiedName } : {}),
      });
      const qualified = params.qualifiedName ? `, qualified: ${params.qualifiedName}` : "";
      return {
        content: [{ type: "text", text: `Created source table node: ${params.tableName} (${params.fields.length} fields${qualified})` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "govio_show_chart",
    label: "Govio Chart",
    description:
      "Show a Plotly chart node on the canvas. Pass a Plotly figure: config.data = traces[], config.layout = optional Plotly layout. " +
      'Trace shapes: bar {"type":"bar","x":[...],"y":[...]}; line {"type":"line","x":[...],"y":[...]}; ' +
      'scatter {"type":"scatter","x":[...],"y":[...]}; pie/doughnut {"type":"pie","labels":[...],"values":[...]}; ' +
      'treemap {"type":"treemap","treeDf":"<ObserveStore DataFrame>","key":"<numeric weight column>","groups":["<hierarchy columns in nesting order>"]}. ' +
      "For treemap the server fetches the rows itself - do NOT read or export the data content to build it inline. " +
      "For bar/line/scatter/pie fetch values via govio-cli first and pass them inline. " +
      "Extra Plotly trace attributes (name, mode, marker, textinfo, ...) and layout keys (title, xaxis.title, yaxis.title, legend, ...) pass through to Plotly.",
    parameters: Type.Object({
      title: Type.String({ description: "Chart node title, e.g. \"Chart: df_sales (bar)\"" }),
      sourceDf: Type.Optional(Type.String({ description: "Source DataFrame name, shown in node header" })),
      config: Type.Object({
        data: Type.Array(
          Type.Object({
            type: Type.String({ description: 'Chart type: "bar" | "line" | "scatter" | "pie" | "doughnut" | "treemap"' }),
            name: Type.Optional(Type.String({ description: "Series label shown in legend" })),
            x: Type.Optional(Type.Array(Type.Unknown(), { description: "bar/line/scatter: x values (category labels or numbers)" })),
            y: Type.Optional(Type.Array(Type.Unknown(), { description: "bar/line/scatter: y values (numbers)" })),
            labels: Type.Optional(Type.Array(Type.String(), { description: "pie/doughnut: category labels" })),
            values: Type.Optional(Type.Array(Type.Number(), { description: "pie/doughnut: sector values" })),
            treeDf: Type.Optional(Type.String({ description: "treemap only: ObserveStore DataFrame name whose rows are the flat leaves. Server fetches rows itself - do NOT read/export the data content" })),
            key: Type.Optional(Type.String({ description: "treemap only: numeric column used as area weight, e.g. 'cnt'" })),
            groups: Type.Optional(Type.Array(Type.String(), { description: "treemap only: hierarchy path columns nested in order, e.g. ['catalog1','catalog2','catalog3']" })),
          }),
          { description: "Plotly traces; extra Plotly attributes (mode, marker, textinfo, ...) pass through" }
        ),
        layout: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Plotly layout: title, xaxis.title, yaxis.title, legend, colors, etc." })),
      }),
    }),
    execute: async (_toolCallId, params) => {
      let notes: string[];
      try {
        notes = await resolveChartConfig(params.config);
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          details: {},
        };
      }
      pushGovioNode({
        nodeType: "chart",
        title: params.title,
        sourceDf: params.sourceDf,
        config: params.config as GovioNodeCreateEvent["config"],
      });
      // resolveChartConfig sets fig.type (chart type label) on the config object.
      const chartType = String((params.config as { type?: unknown }).type ?? "chart");
      return {
        content: [{ type: "text", text: `Created chart node: ${params.title} (${chartType})${notes.length ? "\n" + notes.join("\n") : ""}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "govio_show_dataframe",
    label: "Govio DataFrame",
    description:
      "Show an already-loaded ObserveStore DataFrame as a previewable DataFrame node on the canvas. Use this when the user asks to display/show/加载 a DataFrame onto the canvas, or to surface a DataFrame that was loaded without a canvas node. Fetches the schema from the store via `govio-cli observe info --name` (no data rows). Do NOT use govio_create_source_table for DataFrames — that creates a non-previewable source-table node.",
    parameters: Type.Object({
      dfName: Type.String({ description: "DataFrame name (the `--name` used with `observe load`)" }),
      title: Type.Optional(Type.String({ description: "Node title, e.g. 'DF: channel_country_cartesian'" })),
      sourceName: Type.Optional(Type.String({ description: "Source label: datasource name for --datasource loads, or 'memory' for --memory loads" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      // dfName is interpolated into a shell command — readObserveInfo validates it.
      const info = await readObserveInfo(params.dfName);
      if (!info) {
        return {
          content: [{ type: "text", text: `DataFrame '${params.dfName}' not found in ObserveStore. Load it first via 'govio-cli observe load'.` }],
          details: {},
        };
      }
      const rows = info.rows || 0;
      const cols = info.columns || 0;
      const columns = mapColumnInfo(info.column_info || info.schema || [], rows);
      pushGovioNode({
        nodeType: "dataFrame",
        title: params.title || `DF: ${params.dfName}`,
        dfName: params.dfName,
        sourceName: params.sourceName || "",
        totalRows: rows,
        totalColumns: cols,
        memoryUsage: estimateMemoryUsage(rows, cols),
        columns,
        // 展示已加载的 DataFrame：本次事件流里没有它的加载命令，故 SQL 为空串
        // （节点不可一键复跑），但会话/模型/规模/校验和仍然固化。
        manifest: buildManifest({
          origin: "show-dataframe",
          sql: "",
          datasource: params.sourceName || "",
          dfName: params.dfName,
          columns: columns.map((c) => ({ name: c.name, dtype: c.dtype })),
          rowCount: rows,
          columnCount: cols,
          context: piSessionContext(ctx),
        }),
      });
      return {
        content: [{ type: "text", text: `Created DataFrame node: ${params.dfName} (${rows} rows × ${cols} cols)` }],
        details: {},
      };
    },
  });

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const cmd = event.input.command;
    if (!shouldAskPermission(cmd)) return;

    // 全局放行也走 requestPermission（manager 内部会直接允许）：审计日志需要留下
    // 「这条命令在放行模式下被执行过」的记录，否则放行期间的取数无任何留痕。
    // toolCallId 一并传入：同一次调用的 tool_result 能精确对回本次决策。
    const result = await permissionManager.requestPermission(cmd, event.toolCallId);
    if (result.decision === "allow") return;
    const reason = result.decision === "edit" && result.editedCommand
      ? `用户将该命令修改为：\n\`\`\`bash\n${result.editedCommand}\n\`\`\`\n请改用此命令执行。`
      : result.reason || "用户拒绝执行该命令";
    return { block: true, reason };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const cmd = extractBashCommand(event.input);

    if (!Array.isArray(event.content)) return;
    const stdout = extractTextContent(event.content);

    if (!/govio-cli\s+observe/.test(cmd)) return;
    const subcommand = parseObserveSubcommand(cmd);
    console.log("[govio-canvas] tool_result subcommand:", subcommand, "cmd:", cmd.slice(0, 120));

    switch (subcommand) {
      case "load":
        // toolCallId（同一次工具调用）优先，命令文本兜底（edit 后重发的命令）：
        // 用它把确认门的决策 ID 写进节点 Manifest（未过确认门的加载返回 null）。
        await handleLoadResult(
          cmd,
          stdout,
          piSessionContext(ctx),
          permissionManager.decisionIdForExecution(cmd, event.toolCallId),
        );
        break;
      case "compare":
        handleCompareResult(cmd, stdout);
        break;
      case "explore":
        handleExploreResult(cmd, stdout);
        break;
      case "release":
        // handleReleaseResult(cmd);
        break;
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.message.content) return;

    const text = extractAssistantText(event.message);
    if (!text) return;

    const sqlBlocks = extractSqlCodeBlocks(text);
    if (sqlBlocks.length === 0) return;

    // 会话 ID 取自 pi 上下文；生成模型优先取助手消息自带的 provider/model
    // （比 ctx.model 准确：本轮中途切模型时记录的是真实来源）。
    const sessionContext = piSessionContext(ctx);
    const model = toManifestModelFromMessage(event.message) ?? sessionContext.model;
    const executedAt =
      typeof event.message.timestamp === "number"
        ? new Date(event.message.timestamp).toISOString()
        : undefined;

    for (const block of sqlBlocks) {
      const dfName = extractDfName(text) || nextDfName();
      // const sourceName = extractDataSource(block.sql);
      const tableName = extractTableName(block.sql);
      pushGovioNode({
        nodeType: "sqlQuery",
        title: `Q: ${tableName || dfName}`,
        sql: block.sql,
        // extractSelectColumns 解析不出列（如 SELECT *）时回退到 tableName.*
        outputColumns:
          block.outputColumns.length > 0 ? block.outputColumns : [tableName ? `${tableName}.*` : "result"],
        // SQL 代码块不带数据源信息，故 datasource 为空串；执行后的数据源与
        // 结果校验和由对应的 dataFrame 节点 Manifest 固化。
        manifest: buildManifest({
          origin: "assistant-sql",
          sql: block.sql,
          datasource: "",
          context: { ...sessionContext, model },
          ...(executedAt ? { executedAt } : {}),
        }),
      });
    }
  });
}
