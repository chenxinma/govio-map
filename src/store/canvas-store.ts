import { create } from 'zustand';
import type { Node, Edge, Connection, OnNodesChange, OnEdgesChange } from '@xyflow/react';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { CanvasNodeData, ChatMessage, DataFrameNodeData, ReferencedNode } from '../types';
import { MOCK_TABLES } from '../data/mock-tables';
import { nextId } from '../services/mock-ai';
import { getLayoutedElements } from '../utils/layout';
import { getAIService, type StreamEvent } from '../services/ai-service';
import { getCanvasService } from '../services/canvas-service';

export interface PreviewPanel {
  id: string;
  nodeId: string;
  data: DataFrameNodeData;
  x: number;
  y: number;
}

interface CanvasStore {
  nodes: Node[];
  edges: Edge[];
  messages: ChatMessage[];
  referencedNodes: ReferencedNode[];
  lastReferencedNodes: ReferencedNode[];
  previewPanels: PreviewPanel[];

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;

  isStreaming: boolean;
  streamingContent: string;
  streamingThinking: string;

  addReference: (nodeId: string) => void;
  removeReference: (nodeId: string) => void;
  clearReferences: () => void;

  sendMessage: (content: string) => void;
  addSourceTableToCanvas: (tableName: string) => void;
  autoLayout: () => void;
  createGovioNode: (event: StreamEvent) => void;
  subscribeToCanvas: () => void;

  openPreviewPanel: (nodeId: string) => void;
  closePreviewPanel: (panelId: string) => void;
  movePreviewPanel: (panelId: string, x: number, y: number) => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  nodes: [],
  edges: [],
  messages: [],
  referencedNodes: [],
  lastReferencedNodes: [],
  previewPanels: [],
  isStreaming: false,
  streamingContent: "",
  streamingThinking: "",

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({ edges: addEdge(connection, get().edges) });
  },

  addReference: (nodeId) => {
    const { nodes, referencedNodes } = get();
    if (referencedNodes.find((r) => r.nodeId === nodeId)) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data as unknown as CanvasNodeData;
    const label = data.type === 'sqlQuery' ? `SQL#${nodeId.split('-')[1]}`
      : data.type === 'dataFrame' ? `DF#${nodeId.split('-')[1]}`
      : data.type === 'report' ? data.title
      : data.title;
    set({
      referencedNodes: [...referencedNodes, { nodeId, label, type: data.type }],
    });
  },

  removeReference: (nodeId) => {
    set({ referencedNodes: get().referencedNodes.filter((r) => r.nodeId !== nodeId) });
  },

  clearReferences: () => {
    set({ referencedNodes: [] });
  },

  sendMessage: async (content) => {
    const { messages, referencedNodes } = get();

    const userMsg: ChatMessage = {
      id: nextId('msg'),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      nodePreviews: referencedNodes.length > 0
        ? referencedNodes.map((r) => ({ id: r.nodeId, type: r.type, label: r.label }))
        : undefined,
    };

    set({ messages: [...messages, userMsg], referencedNodes: [], lastReferencedNodes: [...referencedNodes] });

    const aiService = getAIService();

    set({ isStreaming: true, streamingContent: "", streamingThinking: "" });
    let fullContent = "";
    let thinkingContent = "";
    let streamingRAF: number | null = null;

    const unsubscribe = aiService.subscribe((event: StreamEvent) => {
      switch (event.type) {
        case "text_delta":
          fullContent += event.content || "";
          streamingRAF ??= requestAnimationFrame(() => {
            streamingRAF = null;
            set({ streamingContent: fullContent });
          });
          break;
        case "thinking_delta":
          thinkingContent += event.content || "";
          set({ streamingThinking: thinkingContent });
          break;
        case "message_end": {
          if (streamingRAF != null) { cancelAnimationFrame(streamingRAF); streamingRAF = null; }
          if (fullContent.trim()) {
            const aiMsg: ChatMessage = {
              id: nextId('msg'),
              role: 'assistant',
              content: fullContent,
              timestamp: new Date().toISOString(),
            };
            set({
              messages: [...get().messages, aiMsg],
              isStreaming: false,
              streamingContent: "",
              streamingThinking: "",
            });
            unsubscribe();
          }
          break;
        }
        case "error":
          if (streamingRAF != null) { cancelAnimationFrame(streamingRAF); streamingRAF = null; }
          set({ isStreaming: false, streamingContent: "", streamingThinking: "" });
          unsubscribe();
          break;
      }
    });

    try {
      await aiService.sendMessage(content, referencedNodes);
    } catch (err) {
      if (streamingRAF != null) { cancelAnimationFrame(streamingRAF); streamingRAF = null; }
      const errMsg: ChatMessage = {
        id: nextId('msg'),
        role: 'assistant',
        content: `**Error:** ${err instanceof Error ? err.message : 'AI service failed'}`,
        timestamp: new Date().toISOString(),
      };
      set({
        messages: [...get().messages, errMsg],
        isStreaming: false,
        streamingContent: "",
        streamingThinking: "",
      });
      unsubscribe();
    }
    return;
  },

  addSourceTableToCanvas: (tableName) => {
    const { nodes, edges } = get();
    const tableDef = MOCK_TABLES.find((t) => t.tableName === tableName);
    if (!tableDef) return;
    if (nodes.some((n) => {
      const d = n.data as unknown as CanvasNodeData;
      return d.type === 'sourceTable' && d.tableName === tableName;
    })) return;

    const tableId = nextId('src');
    const newNode: Node = {
      id: tableId,
      type: 'sourceTable',
      position: { x: Math.random() * 400 + 100, y: Math.random() * 400 + 100 },
      data: {
        type: 'sourceTable',
        title: tableDef.tableName,
        tableName: tableDef.tableName,
        database: tableDef.database,
        schema: tableDef.fields,
        rowCount: tableDef.rowCount,
        createdAt: new Date().toISOString(),
      },
    };

    const allNodes = [...nodes, newNode];
    const { nodes: layoutedNodes } = getLayoutedElements(allNodes, edges);
    set({ nodes: layoutedNodes });
  },

  autoLayout: () => {
    const { nodes, edges } = get();
    const { nodes: layoutedNodes } = getLayoutedElements(nodes, edges);
    set({ nodes: layoutedNodes });
  },

  createGovioNode: (event) => {
    const { nodes, edges } = get();
    const nodeId = nextId("gov");
    const now = new Date().toISOString();
    let newNode: Node;

    switch (event.nodeType) {
      case "sqlQuery":
        newNode = {
          id: nodeId,
          type: "sqlQuery",
          position: { x: 0, y: 0 },
          data: {
            type: "sqlQuery",
            title: event.title || "SQL Query",
            createdAt: now,
            sql: event.sql || "",
            outputColumns: event.outputColumns || [],
          },
        };
        break;
      case "dataFrame":
        newNode = {
          id: nodeId,
          type: "dataFrame",
          position: { x: 0, y: 0 },
          data: {
            type: "dataFrame",
            title: event.title || `DF: ${event.dfName}`,
            createdAt: now,
            dfName: event.dfName || "",
            sourceName: event.sourceName || "",
            totalRows: event.totalRows || 0,
            totalColumns: event.totalColumns || 0,
            memoryUsage: event.memoryUsage || "0 B",
            columns: event.columns || [],
            previewData: [],
          },
        };
        break;
      case "report":
        newNode = {
          id: nodeId,
          type: "report",
          position: { x: 0, y: 0 },
          data: {
            type: "report",
            title: event.title || "Report",
            createdAt: now,
            reportType: event.reportType || "diff",
            content: event.reportContent || "",
            sourceRefs: event.sourceRefs || [],
          },
        };
        break;
      default:
        return;
    }

    const allNodes = [...nodes, newNode];
    try {
      const { nodes: layoutedNodes } = getLayoutedElements(allNodes, edges);
      set({ nodes: layoutedNodes });
    } catch (err) {
      console.error("[canvas] autoLayout failed, falling back to sequential placement:", err);
      newNode.position = {
        x: 100 + nodes.length * 60,
        y: 100 + nodes.length * 40,
      };
      set({ nodes: allNodes });
    }
  },

  subscribeToCanvas: () => {
    const canvasService = getCanvasService();
    canvasService.subscribe((event) => {
      if (event.type === "govio_node_create") {
        try {
          get().createGovioNode(event);
        } catch (err) {
          console.error("[canvas] createGovioNode error:", err);
        }
      }
    });
  },

  openPreviewPanel: (nodeId) => {
    const { previewPanels, nodes } = get();
    if (previewPanels.some((p) => p.nodeId === nodeId)) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data as unknown as DataFrameNodeData;
    const panelCount = previewPanels.length;
    set({
      previewPanels: [
        ...previewPanels,
        {
          id: `preview-${nodeId}`,
          nodeId,
          data,
          x: 340 + panelCount * 30,
          y: 80 + panelCount * 30,
        },
      ],
    });
  },

  closePreviewPanel: (panelId) => {
    set({ previewPanels: get().previewPanels.filter((p) => p.id !== panelId) });
  },

  movePreviewPanel: (panelId, x, y) => {
    set({
      previewPanels: get().previewPanels.map((p) =>
        p.id === panelId ? { ...p, x, y } : p
      ),
    });
  },
}));
