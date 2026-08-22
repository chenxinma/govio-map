import { EventEmitter } from "events";

export type GovioNodeType = "sqlQuery" | "dataFrame" | "report" | "sourceTable" | "chart";

export interface GovioNodeCreateEvent {
  nodeType: GovioNodeType;
  title: string;
  // sqlQuery
  sql?: string;
  outputColumns?: string[];
  // dataFrame
  dfName?: string;
  sourceName?: string;
  totalRows?: number;
  totalColumns?: number;
  memoryUsage?: string;
  columns?: Array<{ name: string; nonNull: number; dtype: string }>;
  // report
  reportType?: "diff" | "correlation";
  content?: string;
  sourceRefs?: Array<{ label: string }>;
  // sourceTable
  tableName?: string;
  database?: string;
  fields?: Array<{ name: string; type: string; description?: string; references?: { table: string; field: string } }>;
  // chart (Plotly figure: data = traces, layout optional; type = chart type
  // label for the node header, set by resolveChartConfig)
  config?: {
    type?: string;
    data: Array<Record<string, unknown>>;
    layout?: Record<string, unknown>;
  };
  sourceDf?: string;
  // edge sources — referencedNodes from the user's prompt
  referencedNodes?: Array<{ nodeId: string; label: string }>;
}

const queue: GovioNodeCreateEvent[] = [];
const emitter = new EventEmitter();

let currentReferencedNodes: Array<{ nodeId: string; label: string }> | undefined;

export function setCurrentReferencedNodes(refs: Array<{ nodeId: string; label: string }> | undefined): void {
  currentReferencedNodes = refs;
}

export function clearCurrentReferencedNodes(): void {
  currentReferencedNodes = undefined;
}

export function pushGovioNode(event: GovioNodeCreateEvent): void {
  if (currentReferencedNodes && currentReferencedNodes.length > 0) {
    event.referencedNodes = currentReferencedNodes;
  }
  queue.push(event);
}

export function flushGovioNodes(): GovioNodeCreateEvent[] {
  const result = [...queue];
  queue.length = 0;
  return result;
}

export function emitFlushed(events: GovioNodeCreateEvent[]): void {
  if (events.length > 0) {
    emitter.emit("flushed", events);
  }
}

export function onGovioNodesFlushed(
  callback: (events: GovioNodeCreateEvent[]) => void
): () => void {
  emitter.on("flushed", callback);
  return () => {
    emitter.off("flushed", callback);
  };
}
