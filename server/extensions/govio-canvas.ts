import { pushGovioNode } from "../govio-node-queue.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function parseObserveSubcommand(cmd: string): string | null {
  const match = cmd.match(/govio-cli\s+observe\s+(\S+)/);
  return match ? match[1] : null;
}

function parseLoadArgs(cmd: string): { name: string; datasource: string } | null {
  const match = cmd.match(/govio-cli\s+observe\s+load\s+(\S+)\s+(\S+)/);
  return match ? { name: match[1], datasource: match[2] } : null;
}

function parseCompareArgs(cmd: string): { source: string; target: string } | null {
  const match = cmd.match(/govio-cli\s+observe\s+compare\s+(\S+)\s+(\S+)/);
  return match ? { source: match[1], target: match[2] } : null;
}

function estimateMemoryUsage(rows: number, cols: number): string {
  const bytes = rows * cols * 8;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractAssistantText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
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
    if (sql) {
      blocks.push({ sql, outputColumns: extractSelectColumns(sql) });
    }
  }
  return blocks;
}

function extractDataSource(sql: string): string {
  const match = sql.match(/FROM\s+([\w.]+)/i);
  if (!match) return "unknown";
  const parts = match[1].split(".");
  return parts.length > 1 ? parts[0] : match[1];
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

function formatExploreResult(relations: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  lines.push(`## Discovered Relations`);
  for (const rel of relations) {
    if (rel.type === "column_similarity") {
      lines.push(
        `- [Similarity ${(Number(rel.similarity) * 100).toFixed(0)}%] ${rel.table1}.${rel.column1} ~ ${rel.table2}.${rel.column2}`,
      );
    } else {
      lines.push(
        `- [Confidence ${(Number(rel.confidence) * 100).toFixed(0)}%] ${rel.source_table}.${rel.source_column} → ${rel.target_table}.${rel.target_column}`,
      );
    }
  }
  return lines.join("\n");
}

function extractExploreSources(relations: Array<Record<string, unknown>>): Array<{ label: string }> {
  const seen = new Set<string>();
  const refs: Array<{ label: string }> = [];
  for (const rel of relations) {
    const t1 = (rel.table1 ?? rel.source_table) as string;
    const t2 = (rel.table2 ?? rel.target_table) as string;
    for (const t of [t1, t2]) {
      if (t && !seen.has(t)) {
        seen.add(t);
        refs.push({ label: t });
      }
    }
  }
  return refs;
}

// ── Event Handlers ─────────────────────────────────────────────────

function handleLoadResult(cmd: string, stdout: string): void {
  const args = parseLoadArgs(cmd);
  if (!args) return;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) return;
    const columns = (parsed.column_info || []).map((c: { name: string; dtype: string }) => ({
      name: c.name,
      nonNull: parsed.rows || 0,
      dtype: c.dtype,
    }));
    pushGovioNode({
      nodeType: "dataFrame",
      title: `DF: ${args.name}`,
      dfName: args.name,
      sourceName: args.datasource,
      totalRows: parsed.rows || 0,
      totalColumns: parsed.columns || columns.length,
      memoryUsage: estimateMemoryUsage(parsed.rows || 0, parsed.columns || columns.length),
      columns,
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

function handleExploreResult(stdout: string): void {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed.success === false) return;
    const relations: Array<Record<string, unknown>> = parsed.relations || [];
    if (relations.length === 0) return;
    const content = formatExploreResult(relations);
    const sourceRefs = extractExploreSources(relations);
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

// ── Extension Entry ────────────────────────────────────────────────

export default function govioCanvasExtension(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || event.isError) return;

    const cmd = extractBashCommand(event.input);
    if (!/govio-cli\s+observe/.test(cmd)) return;

    if (!Array.isArray(event.content)) return;
    const stdout = extractTextContent(event.content);
    const subcommand = parseObserveSubcommand(cmd);

    switch (subcommand) {
      case "load":
        handleLoadResult(cmd, stdout);
        break;
      case "compare":
        handleCompareResult(cmd, stdout);
        break;
      case "explore":
        handleExploreResult(stdout);
        break;
      // list, show-datasource, release — ignored
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
      const sourceName = extractDataSource(block.sql);
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
        nodeType: "dataFrame",
        title: `DF: ${dfName}`,
        dfName,
        sourceName,
        totalRows: 0,
        totalColumns: columns.length,
        memoryUsage: "0 B",
        columns,
      });
    }
  });
}
