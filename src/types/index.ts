export interface TableField {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: { table: string; field: string };
}

export type NodeType = 'sourceTable' | 'sqlQuery' | 'dataFrame' | 'report' | 'chart';

export interface SourceTableNodeData {
  type: 'sourceTable';
  title: string;
  description?: string;
  createdAt: string;
  tableName: string;
  database: string;
  fields: TableField[];
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

export interface ChartTrace {
  type: string;
  name?: string;
  x?: unknown[];
  y?: unknown[];
  labels?: string[];
  values?: number[];
  mode?: string;
  hole?: number;
  // treemap contract (resolved server-side into ids/labels/parents/values)
  treeDf?: string;
  key?: string;
  groups?: string[];
  ids?: string[];
  parents?: string[];
  branchvalues?: string;
  [key: string]: unknown;
}

export interface ChartConfig {
  /** chart type label shown in the node header (set server-side) */
  type: string;
  /** Plotly traces */
  data: ChartTrace[];
  layout?: Record<string, unknown>;
}

export interface ChartNodeData {
  type: 'chart';
  title: string;
  createdAt: string;
  sourceDf?: string;
  config: ChartConfig;
  [key: string]: unknown;
}

export type CanvasNodeData = SourceTableNodeData | SQLQueryNodeData | DataFrameNodeData | ReportNodeData | ChartNodeData;

export interface ReferencedNode {
  nodeId: string;
  label: string;
  type: NodeType;
  data?: string | null;
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
