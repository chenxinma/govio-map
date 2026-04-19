export interface TableField {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: { table: string; field: string };
}

export type NodeType = 'sourceTable' | 'sqlQuery' | 'dataFrame' | 'report';

export interface SourceTableNodeData {
  type: 'sourceTable';
  title: string;
  description?: string;
  createdAt: string;
  tableName: string;
  database: string;
  schema: TableField[];
  rowCount?: number;
  [key: string]: unknown;
}

export interface SQLQueryNodeData {
  type: 'sqlQuery';
  title: string;
  createdAt: string;
  sql: string;
  outputColumns: string[];
  [key: string]: unknown;
}

export interface DataFrameColumn {
  name: string;
  nonNull: number;
  dtype: string;
}

export interface DataFrameNodeData {
  type: 'dataFrame';
  title: string;
  createdAt: string;
  dfName: string;
  sourceName: string;
  totalRows: number;
  totalColumns: number;
  memoryUsage: string;
  columns: DataFrameColumn[];
  previewData: Record<string, unknown>[];
  [key: string]: unknown;
}

export type ReportType = 'diff' | 'correlation';

export interface ReportNodeData {
  type: 'report';
  title: string;
  createdAt: string;
  reportType: ReportType;
  sourceRefs: { label: string }[];
  content: string;
  [key: string]: unknown;
}

export type CanvasNodeData = SourceTableNodeData | SQLQueryNodeData | DataFrameNodeData | ReportNodeData;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  nodePreviews?: NodePreview[];
}

export interface NodePreview {
  id: string;
  type: NodeType;
  label: string;
}

export interface ReferencedNode {
  nodeId: string;
  label: string;
  type: NodeType;
}

export interface MockTable {
  tableName: string;
  database: string;
  rowCount: number;
  fields: TableField[];
}

export interface MockResponse {
  tables: string[];
  sql: string;
  explanation: string;
  outputColumns: string[];
}

export interface MockDataFrameResponse {
  dfName: string;
  sourceName: string;
  totalRows: number;
  totalColumns: number;
  memoryUsage: string;
  columns: DataFrameColumn[];
  previewData: Record<string, unknown>[];
}

export interface MockReportResponse {
  reportType: ReportType;
  title: string;
  content: string;
}
