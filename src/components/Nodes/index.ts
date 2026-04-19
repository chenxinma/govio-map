import type { NodeTypes } from '@xyflow/react';
import SourceTableNode from './SourceTableNode';
import SQLQueryNode from './SQLQueryNode';
import DataFrameNode from './DataFrameNode';
import ReportNode from './ReportNode';

export const nodeTypes: NodeTypes = {
  sourceTable: SourceTableNode,
  sqlQuery: SQLQueryNode,
  dataFrame: DataFrameNode,
  report: ReportNode,
};
