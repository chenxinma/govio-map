import type { ChatMessage } from "../hooks/useChat";
import type { Node, Edge } from "@xyflow/react";

export function exportSession(messages: ChatMessage[], nodes: Node[], edges: Edge[]) {
  const data = {
    exportedAt: new Date().toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      referencedNodes: m.referencedNodes,
    })),
    canvas: {
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `govio-session-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
