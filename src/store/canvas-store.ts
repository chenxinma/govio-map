import { create } from 'zustand';
import type { Node, Edge, Connection, OnNodesChange, OnEdgesChange } from '@xyflow/react';
import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { CanvasNodeData, ChatMessage, ReferencedNode, DataFrameNodeData, NodeType } from '../types';
import { matchQuery, generateDataFrame, generateReport, nextId } from '../services/mock-ai';
import { MOCK_TABLES } from '../data/mock-tables';
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
  previewPanels: PreviewPanel[];

  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;

  isStreaming: boolean;
  streamingContent: string;

  addReference: (nodeId: string) => void;
  removeReference: (nodeId: string) => void;
  clearReferences: () => void;

  sendMessage: (content: string) => void;
  addSourceTableToCanvas: (tableName: string) => void;
  autoLayout: () => void;

  openPreviewPanel: (nodeId: string) => void;
  closePreviewPanel: (panelId: string) => void;
  movePreviewPanel: (panelId: string, x: number, y: number) => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  nodes: [],
  edges: [],
  messages: [],
  referencedNodes: [],
  previewPanels: [],
  isStreaming: false,
  streamingContent: "",

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
    const { messages, referencedNodes, nodes, edges } = get();
    const hasSQLRef = referencedNodes.some((r) => r.type === 'sqlQuery');
    const dfRefs = referencedNodes.filter((r) => r.type === 'dataFrame');
    const hasMultiDF = dfRefs.length >= 2;

    const userMsg: ChatMessage = {
      id: nextId('msg'),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      nodePreviews: referencedNodes.length > 0
        ? referencedNodes.map((r) => ({ id: r.nodeId, type: r.type, label: r.label }))
        : undefined,
    };

    set({ messages: [...messages, userMsg], referencedNodes: [] });

    const aiService = getAIService();

    // If WebSocket connected, use pi-coding-agent for general chat
    // For node-specific operations (SQL/DF references), still use mock
    if (aiService.isConnected() && !hasSQLRef && !hasMultiDF) {
      set({ isStreaming: true, streamingContent: "" });
      let fullContent = "";

      const unsubscribe = aiService.subscribe((event: StreamEvent) => {
        switch (event.type) {
          case "text_delta":
            fullContent += event.content || "";
            set({ streamingContent: fullContent });
            break;
          case "message_end": {
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
            });
            unsubscribe();
            break;
          }
          case "error":
            set({ isStreaming: false, streamingContent: "" });
            unsubscribe();
            break;
        }
      });

      await aiService.sendMessage(content, referencedNodes);
      return;
    }

    // Fallback to existing mock logic for node operations
    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];
    let aiContent = '';
    let aiPreviews: { id: string; type: NodeType; label: string }[] = [];

    if (hasMultiDF) {
      const reportResult = generateReport(
        dfRefs.map((r) => ({ label: r.label })),
        content
      );
      const reportId = nextId('rpt');

      newNodes.push({
        id: reportId,
        type: 'report',
        position: { x: 0, y: 0 },
        data: {
          type: 'report',
          title: reportResult.title,
          reportType: reportResult.reportType,
          sourceRefs: dfRefs.map((r) => ({ label: r.label })),
          content: reportResult.content,
          createdAt: new Date().toISOString(),
        },
      });

      dfRefs.forEach((ref) => {
        newEdges.push({
          id: `e-${ref.nodeId}-${reportId}`,
          source: ref.nodeId,
          target: reportId,
          animated: true,
          style: { stroke: '#3ecf8e', strokeWidth: 2 },
        });
      });

      aiContent = `已对 ${dfRefs.map((r) => r.label).join(' 与 ')} 生成${reportResult.reportType === 'correlation' ? '相关性分析' : '差异比较'}报告。`;
      aiPreviews = [{ id: reportId, type: 'report', label: reportResult.title }];
    } else if (hasSQLRef) {
      const sqlRef = referencedNodes.find((r) => r.type === 'sqlQuery')!;
      const dfResult = generateDataFrame(sqlRef.nodeId);
      const dfId = nextId('df');

      newNodes.push({
        id: dfId,
        type: 'dataFrame',
        position: { x: 0, y: 0 },
        data: {
          type: 'dataFrame',
          title: dfResult.dfName,
          dfName: dfResult.dfName,
          sourceName: dfResult.sourceName,
          totalRows: dfResult.totalRows,
          totalColumns: dfResult.totalColumns,
          memoryUsage: dfResult.memoryUsage,
          columns: dfResult.columns,
          previewData: dfResult.previewData,
          createdAt: new Date().toISOString(),
        },
      });

      newEdges.push({
        id: `e-${sqlRef.nodeId}-${dfId}`,
        source: sqlRef.nodeId,
        target: dfId,
        animated: true,
        style: { stroke: '#3ecf8e', strokeWidth: 2 },
      });

      aiContent = '已根据 SQL 查询生成 DataFrame，使用 pandas 进行数据透视处理。已在画布上创建 DataFrame 节点并连接。';
      aiPreviews = [{ id: dfId, type: 'dataFrame', label: `DF#${dfId.split('-')[1]}` }];
    } else {
      // Also fallback to mock for regular queries when WS not connected
      const response = matchQuery(content);
      const usedTables = response.tables;

      usedTables.forEach((tableName) => {
        const tableDef = MOCK_TABLES.find((t) => t.tableName === tableName);
        if (!tableDef) return;
        const tableId = nextId('src');
        newNodes.push({
          id: tableId,
          type: 'sourceTable',
          position: { x: 0, y: 0 },
          data: {
            type: 'sourceTable',
            title: tableDef.tableName,
            tableName: tableDef.tableName,
            database: tableDef.database,
            schema: tableDef.fields,
            rowCount: tableDef.rowCount,
            createdAt: new Date().toISOString(),
          },
        });
        aiPreviews.push({ id: tableId, type: 'sourceTable', label: tableDef.tableName });
      });

      const sqlId = nextId('sql');
      newNodes.push({
        id: sqlId,
        type: 'sqlQuery',
        position: { x: 0, y: 0 },
        data: {
          type: 'sqlQuery',
          title: `SQL #${sqlId.split('-')[1]}`,
          sql: response.sql,
          outputColumns: response.outputColumns,
          createdAt: new Date().toISOString(),
        },
      });
      aiPreviews.push({ id: sqlId, type: 'sqlQuery', label: `SQL#${sqlId.split('-')[1]}` });

      usedTables.forEach((tableName) => {
        const srcNode = newNodes.find((n) => {
          const d = n.data as unknown as CanvasNodeData;
          return d.type === 'sourceTable' && d.tableName === tableName;
        });
        if (srcNode) {
          newEdges.push({
            id: `e-${srcNode.id}-${sqlId}`,
            source: srcNode.id,
            target: sqlId,
            animated: true,
            style: { stroke: '#3ecf8e', strokeWidth: 2 },
          });
        }
      });

      aiContent = response.explanation;
    }

    const allNodes = [...nodes, ...newNodes];
    const allEdges = [...edges, ...newEdges];
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(allNodes, allEdges);

    const aiMsg: ChatMessage = {
      id: nextId('msg'),
      role: 'assistant',
      content: aiContent,
      timestamp: new Date().toISOString(),
      nodePreviews: aiPreviews,
    };

    set({
      nodes: layoutedNodes,
      edges: layoutedEdges,
      messages: [...get().messages, aiMsg],
      referencedNodes: [],
    });
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
