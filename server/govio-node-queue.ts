import { EventEmitter } from "events";

export type GovioNodeType = "sqlQuery" | "dataFrame" | "report";

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
