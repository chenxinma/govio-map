import type { AnalysisManifest } from './manifest';
import type { RerunRecord } from './rerun';

// 分析留痕类型（前后端共享定义见 ./manifest.ts）
export type {
  AnalysisManifest,
  ManifestChecksum,
  ManifestChecksumAlgorithm,
  ManifestModel,
  ManifestOrigin,
} from './manifest';

// 复跑记录类型（前后端共享定义见 ./rerun.ts）
export type {
  RerunDiff,
  RerunOutcome,
  RerunRecord,
  RerunSnapshot,
} from './rerun';

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

/**
 * sourceTable 节点允许的数据源类型（T2.0）。
 * 前六个对应 CLI 元数据层 DatasourceDef.source_type 枚举（govio/metadata/datasource.py）；
 * `sqlalchemy-generic` 表示 observe 侧走 SQLAlchemy 连接但类型无法进一步判定；
 * `unknown` 表示确认存在数据源但类型未知。枚举外的 source_type 取值（如 tds）不落盘（省略字段）。
 */
export const DATASOURCE_TYPES = [
  'duckdb',
  'postgres',
  'mysql',
  'oracle',
  'hive',
  'trino',
  'sqlalchemy-generic',
  'unknown',
] as const;

export type DatasourceType = (typeof DATASOURCE_TYPES)[number];

export interface SourceTableNodeData {
  type: 'sourceTable';
  title: string;
  description?: string;
  createdAt: string;
  tableName: string;
  database: string;
  fields: TableField[];
  rowCount?: number;
  /**
   * 数据源名（T2.0，可选）：observe `config.yaml` datasources 键，即 `observe load --datasource`
   * 的取值（如 "chocolate"）。来源：图谱 Datasource 节点 datasource_name、数据源声明文件或
   * 用户指令。拿不到就省略（禁止猜测）；旧节点无此字段（undefined），UI 回退旧显示。
   */
  datasource?: string;
  /**
   * 数据源类型（T2.0，可选），决定 SQL 表引用段式，规则见 docs/specs/11-datasource-schema-conventions.md。
   * 来源（按序）：图谱 Datasource 节点 source_type（若已导入）、数据源声明文件 source_type、
   * observe config.yaml 该数据源 url scheme（duckdb:// → 'duckdb'）。拿不到就省略——禁止猜测；
   * 旧节点为 undefined，UI 不渲染类型徽标。
   */
  datasourceType?: DatasourceType;
  /**
   * 所属 schema（T2.0，可选）：取图谱 PhysicalTable 查询结果的 `schema` 属性。
   * 拿不到就省略；旧节点为 undefined。
   */
  schema?: string;
  /**
   * SQL 中应使用的全限定表名（T2.0，可选）：duckdb 三段式 catalog.schema.table
   * （如 "chocolate.chocolate.dim_product"）、postgres 两段式 schema.table、mysql 裸表名或
   * db.table。agent 写 SQL 时表引用必须取此字段（提示词规则落地属 X5）。
   * 构造规则见 docs/specs/11-datasource-schema-conventions.md；构造不出就省略——禁止猜测；
   * 旧节点为 undefined，UI 不渲染全限定名行。
   */
  qualifiedName?: string;
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
  /**
   * 复跑记录（Phase 1 KR2）：每次一键复跑追加一条，最新在前。
   * 漂移时原 `manifest` 保留不覆盖，旧值/新值/时间都在记录里；随 canvas sidecar 持久化。
   */
  rerunHistory?: RerunRecord[];
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
