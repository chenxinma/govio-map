import { create } from 'zustand';
import type { Node, Edge, Connection, OnNodesChange, OnEdgesChange } from '@xyflow/react';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { CanvasNodeData, DataFrameNodeData, ReferencedNode } from '../types';
import { MOCK_TABLES } from '../data/mock-tables';
import { nextId } from '../services/mock-ai';
import { getLayoutedElements } from '../utils/layout';
import { getCanvasService, type CanvasEvent } from '../services/canvas-service';

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
  previewPanels: PreviewPanel[];

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;

  addSourceTableToCanvas: (tableName: string) => void;
  autoLayout: () => void;
  createGovioNode: (event: CanvasEvent) => void;
  subscribeToCanvas: () => () => void;

  openPreviewPanel: (nodeId: string) => void;
  closePreviewPanel: (panelId: string) => void;
  movePreviewPanel: (panelId: string, x: number, y: number) => void;

  referencedNodes: ReferencedNode[];
  addReference: (nodeId: string) => void;
  removeReference: (nodeId: string) => void;
  clearReferences: () => void;

  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
  createManualSQLNode: () => void;
  restoreCanvas: (dataframes: Array<{ dfName: string; [key: string]: unknown }>) => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  nodes: [],
  edges: [],
  previewPanels: [],
  referencedNodes: [],

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({ edges: addEdge(connection, get().edges) });
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
    const unsubscribe = canvasService.subscribe((event) => {
      if (event.type === "govio_node_create") {
        try {
          get().createGovioNode(event);
        } catch (err) {
          console.error("[canvas] createGovioNode error:", err);
        }
      }
    });
    return unsubscribe;
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

  addReference: (nodeId) => {
    const { nodes, referencedNodes } = get();
    if (referencedNodes.some((r) => r.nodeId === nodeId)) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data as unknown as CanvasNodeData;
    let ref: string | null = null;
    switch(data.type) {
      case "sqlQuery":
        ref = data.sql;
        break;
      case "dataFrame":
        ref = data.dfName;
        break;
    }
    set({
      referencedNodes: [
        ...referencedNodes,
        { nodeId, label: data.title, type: data.type, data: ref },
      ],
    });
  },

  removeReference: (nodeId) => {
    set({ referencedNodes: get().referencedNodes.filter((r) => r.nodeId !== nodeId) });
  },

  clearReferences: () => {
    set({ referencedNodes: [] });
  },

  updateNodeData: (nodeId, data) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
      ),
    });
  },

  createManualSQLNode: () => {
    const { nodes, edges } = get();
    const nodeId = nextId('sql');
    const newNode: Node = {
      id: nodeId,
      type: 'sqlQuery',
      position: { x: 0, y: 0 },
      data: {
        type: 'sqlQuery',
        title: 'New Query',
        createdAt: new Date().toISOString(),
        sql: '',
        outputColumns: [],
      },
    };
    const allNodes = [...nodes, newNode];
    try {
      const { nodes: layoutedNodes } = getLayoutedElements(allNodes, edges);
      set({ nodes: layoutedNodes });
    } catch {
      newNode.position = { x: 100 + nodes.length * 60, y: 100 + nodes.length * 40 };
      set({ nodes: allNodes });
    }
  },

  restoreCanvas: (dataframes) => {
    const { nodes } = get();
    const existingDfNames = new Set(
      nodes
        .filter((n) => (n.data as unknown as CanvasNodeData).type === 'dataFrame')
        .map((n) => (n.data as unknown as { dfName: string }).dfName)
    );

    const missing = dataframes.filter((df) => {
      const name = (df.dfName || df.name) as string;
      return name && !existingDfNames.has(name);
    });
    if (missing.length === 0) return;

    for (const df of missing) {
      const dfName = (df.dfName || df.name) as string;
      const rawCols = df.column_info || df.columns;
      const cols: Array<{ name: string; nonNull?: number; dtype: string }> = Array.isArray(rawCols) ? rawCols : [];
      get().createGovioNode({
        type: 'govio_node_create',
        nodeType: 'dataFrame',
        title: `DF: ${dfName}`,
        dfName,
        sourceName: (df.sourceName as string) || '',
        totalRows: (df.totalRows || df.rows as number) || 0,
        totalColumns: (df.totalColumns as number) || (typeof df.columns === 'number' ? df.columns : cols.length),
        memoryUsage: (df.memoryUsage as string) || '0 B',
        columns: cols.map((c) => ({ name: c.name, nonNull: c.nonNull ?? 0, dtype: c.dtype })),
      });
    }
  },

}));
