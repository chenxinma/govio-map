import { pushGovioNode, type GovioNodeCreateEvent } from "../govio-node-queue.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { permissionManager } from "../permission-manager.js";

const OBSERVE_LOAD_RE = /\bgovio-cli\s+observe\s+load\b/;
const OUTPUT_FLAG_RE = /(?:^|\s|=)(?:-o|--output)(?=\s|=|$)/;

export function shouldAskPermission(cmd: string): boolean {
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


function mapColumnInfo(
  columns: Array<{ name?: string; column?: string; col?: string; dtype: string }>,
  totalRows: number,
): Array<{ name: string; dtype: string; nonNull: number }> {
  return columns.map((c) => ({
    name: c.name ?? c.column ?? c.col ?? "unknown",
    dtype: c.dtype,
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
  let totalRows = 0;
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
    throw new Error(`Failed to resolve tree from '${treeDf}': ${err instanceof Error ? err.message : String(err)}`);
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

function handleLoadResult(cmd: string, stdout: string): void {
  const args = parseLoadArgs(cmd);
  if (!args) return;
  // Validate dfName to prevent injection into downstream commands or display issues.
  if (!/^[A-Za-z0-9_]+$/.test(args.name)) return;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) return;
    const columns = mapColumnInfo(parsed.column_info || [], parsed.rows || 0);
    // --datasource loads come from a DB; --memory loads derive from upstream
    // DataFrames, whose names are reported back as `source_tables`.
    const sourceName = args.datasource ?? (args.memory ? "memory" : "");
    // --memory injects ALL loaded DataFrames into DuckDB, so `source_tables`
    // lists every loaded df - not just those this SQL actually references.
    // Filter to names that appear in the SQL so lineage edges stay precise.
    // Extract only the SQL portion from the command to avoid false matches
    // against --name or other flag values.
    const sqlMatch = cmd.match(/--sql\s+"([^"]*)"/);
    const sqlText = sqlMatch ? sqlMatch[1] : cmd;
    const sourceRefs =
      args.memory && Array.isArray(parsed.source_tables) && parsed.source_tables.length > 0
        ? parsed.source_tables
            .filter((t: string) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(sqlText))
            .map((t: string) => ({ label: t }))
        : undefined;
    pushGovioNode({
      nodeType: "dataFrame",
      title: `DF: ${args.name}`,
      dfName: args.name,
      sourceName,
      totalRows: parsed.rows || 0,
      totalColumns: parsed.columns || columns.length,
      memoryUsage: estimateMemoryUsage(parsed.rows || 0, parsed.columns || columns.length),
      columns,
      ...(sourceRefs ? { sourceRefs } : {}),
    });
  } catch {
    // stdout is not valid JSON
  }
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
  } catch {
    // stdout is not valid JSON
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
  } catch {
    // stdout is not valid JSON
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
    description: "Create a source table node on the canvas showing the column schema. Each field must carry all three parts from the govio physical-table column query result: column name (column_name), description name (name) and data type (data_type). Call this after querying a PhysicalTable's column structure via govio-cli query.",
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
    }),
    execute: async (_toolCallId, params) => {
      pushGovioNode({
        nodeType: "sourceTable",
        title: params.tableName,
        tableName: params.tableName,
        database: params.database || "",
        fields: params.fields,
      });
      return {
        content: [{ type: "text", text: `Created source table node: ${params.tableName} (${params.fields.length} fields)` }],
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
      let notes: string[] = [];
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
    execute: async (_toolCallId, params) => {
      // dfName is interpolated into a shell command — restrict to safe identifiers.
      if (!/^[A-Za-z0-9_]+$/.test(params.dfName)) {
        return {
          content: [{ type: "text", text: `Invalid dfName '${params.dfName}': only letters, digits and underscores are allowed.` }],
          details: {},
        };
      }
      let rows = 0;
      let cols = 0;
      let columns: Array<{ name: string; dtype: string; nonNull: number }> = [];
      try {
        const { runGovioCli } = await import("../agent.js");
        // --rows 0 avoids pulling sample data (schema only).
        const out = await runGovioCli(`observe info --name ${params.dfName} --rows 0`);
        const info = JSON.parse(out);
        if (!info || info.success === false) {
          return {
            content: [{ type: "text", text: `DataFrame '${params.dfName}' not found in ObserveStore (${info?.error ?? "unknown error"}). Load it first via 'govio-cli observe load'.` }],
            details: {},
          };
        }
        rows = info.rows || 0;
        cols = info.columns || 0;
        columns = mapColumnInfo(info.schema || [], rows);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to fetch schema for '${params.dfName}': ${err instanceof Error ? err.message : String(err)}` }],
          details: {},
        };
      }
      pushGovioNode({
        nodeType: "dataFrame",
        title: params.title || `DF: ${params.dfName}`,
        dfName: params.dfName,
        sourceName: params.sourceName || "",
        totalRows: rows,
        totalColumns: cols,
        memoryUsage: estimateMemoryUsage(rows, cols),
        columns,
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
    if (permissionManager.isAcceptAll()) return;

    const result = await permissionManager.requestPermission(cmd);
    if (result.decision === "allow") return;
    const reason = result.decision === "edit" && result.editedCommand
      ? `用户将该命令修改为：\n\`\`\`bash\n${result.editedCommand}\n\`\`\`\n请改用此命令执行。`
      : result.reason || "用户拒绝执行该命令";
    return { block: true, reason };
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || event.isError) return;

    const cmd = extractBashCommand(event.input);

    if (!Array.isArray(event.content)) return;
    const stdout = extractTextContent(event.content);

    if (!/govio-cli\s+observe/.test(cmd)) return;
    const subcommand = parseObserveSubcommand(cmd);
    console.log("[govio-canvas] tool_result subcommand:", subcommand, "cmd:", cmd.slice(0, 120));

    switch (subcommand) {
      case "load":
        handleLoadResult(cmd, stdout);
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

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    if (!event.message.content) return;

    const text = extractAssistantText(event.message);
    if (!text) return;

    const sqlBlocks = extractSqlCodeBlocks(text);

    for (const block of sqlBlocks) {
      const dfName = extractDfName(text) || nextDfName();
      // const sourceName = extractDataSource(block.sql);
      const tableName = extractTableName(block.sql);
      let columns = block.outputColumns.map((name) => ({
        name,
        nonNull: 0,
        dtype: "unknown",
      }));

      if (columns.length === 0) {
        columns = [{ name: tableName ? `${tableName}.*` : "result", nonNull: 0, dtype: "unknown" }];
      }

      pushGovioNode({
        nodeType: "sqlQuery",
        title: `Q: ${tableName || dfName}`,
        sql: block.sql,
        outputColumns: block.outputColumns
      });
    }
  });
}
