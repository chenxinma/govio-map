import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Node } from '@xyflow/react';
import type { CanvasNodeData } from '../../types';

/**
 * 从画布节点提取表名和字段名作为补全源
 */
export function getCompletionSources(nodes: Node[]): Map<string, string[]> {
  const sources = new Map<string, string[]>();

  nodes.forEach((node) => {
    const data = node.data as unknown as CanvasNodeData;
    if (data.type === 'sourceTable') {
      sources.set(data.tableName, data.fields.map((f) => f.name));
    } else if (data.type === 'dataFrame') {
      sources.set(data.dfName, data.columns.map((c) => c.name));
    }
  });

  return sources;
}

/**
 * 创建自定义SQL补全扩展
 */
export function createSQLCompletion(sources: Map<string, string[]>) {
  return (context: CompletionContext): CompletionResult | null => {
    // 匹配当前输入的单词
    const word = context.matchBefore(/[\w.]+/);
    if (!word) return null;

    const text = word.text;
    const dotIndex = text.lastIndexOf('.');

    // 如果输入了 "表名." 或 "表名.字段前缀"
    if (dotIndex > 0) {
      const tableName = text.substring(0, dotIndex);
      const columns = sources.get(tableName);

      if (columns) {
        return {
          from: word.from + dotIndex + 1,
          options: columns.map((col) => ({
            label: col,
            type: 'property',
            boost: 1,
          })),
        };
      }
    }

    // 否则补全表名
    const tableOptions: Completion[] = [];
    sources.forEach((columns, tableName) => {
      if (tableName.toLowerCase().startsWith(text.toLowerCase())) {
        tableOptions.push({
          label: tableName,
          type: 'table',
          boost: 2,
          detail: `${columns.length} 列`,
        });
      }
    });

    if (tableOptions.length > 0) {
      return {
        from: word.from,
        options: tableOptions,
      };
    }

    return null;
  };
}