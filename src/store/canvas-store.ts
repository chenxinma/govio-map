import { create } from 'zustand';
import type { Node, Edge, Connection, OnNodesChange, OnEdgesChange } from '@xyflow/react';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { CanvasNodeData, ChatMessage, ReferencedNode } from '../types';
import { nextId } from '../services/mock-ai';
import { getLayoutedElements } from '../utils/layout';
import { getAIService, type StreamEvent } from '../services/ai-service';

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

    const unsubscribe = aiService.subscribe((event: StreamEvent) => {
      switch (event.type) {
        case "text_delta":
          fullContent += event.content || "";
          set({ streamingContent: fullContent });
          break;
        case "thinking_delta":
          thinkingContent += event.content || "";
          set({ streamingThinking: thinkingContent });
          break;
        case "message_end": {
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
          set({ isStreaming: false, streamingContent: "", streamingThinking: "" });
          unsubscribe();
          break;
        case "govio_node_create":
          get().createGovioNode(event);
          break;
      }
    });

    try {
      await aiService.sendMessage(content, referencedNodes);
    } catch (err) {
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
    const { nodes, edges, lastReferencedNodes } = get();
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

    const newEdges: Edge[] = [];
    const seen = new Set<string>();
    for (const ref of lastReferencedNodes) {
      const key = `${ref.nodeId}->${nodeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        newEdges.push({
          id: `e-${ref.nodeId}-${nodeId}`,
          source: ref.nodeId,
          target: nodeId,
          style: { stroke: "#3ecf8e", strokeWidth: 2 },
          animated: true,
        });
      }
    }

    const allNodes = [...nodes, newNode];
    const allEdges = [...edges, ...newEdges];
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(allNodes, allEdges);
    set({ nodes: layoutedNodes, edges: layoutedEdges });
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
