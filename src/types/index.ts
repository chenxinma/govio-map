import type { AnalysisManifest } from './manifest';

// 分析留痕类型（前后端共享定义见 ./manifest.ts）
export type {
  AnalysisManifest,
  ManifestChecksum,
  ManifestChecksumAlgorithm,
  ManifestModel,
  ManifestOrigin,
} from './manifest';

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
  /** 分析留痕：SQL 全文 + 来源模型/会话（服务端事件流填充，可为空表示旧节点） */
  manifest?: AnalysisManifest;
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
  /** 分析留痕：SQL 全文、数据源、执行时间、行列数与校验和（服务端事件流填充） */
  manifest?: AnalysisManifest;
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
