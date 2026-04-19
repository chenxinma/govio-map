import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Quote } from 'lucide-react';
import type { SQLQueryNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function SQLNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SQLQueryNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const sqlLines = nodeData.sql.split('\n').slice(0, 8);
  const hasMore = nodeData.sql.split('\n').length > 8;

  return (
    <div className="w-[300px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-sql px-4 py-3">
        <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
      </div>

      <div className="border-t border-border-subtle px-4 py-3">
        <pre className="text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-all">
          {sqlLines.join('\n')}
          {hasMore && '\n...'}
        </pre>
      </div>

      <div className="border-t border-border-subtle px-4 py-2">
        <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted mb-1.5">输出列</div>
        <div className="flex flex-wrap gap-1">
          {nodeData.outputColumns.map((col) => (
            <span key={col} className="text-[11px] px-1.5 py-0.5 rounded bg-node-sql/10 text-node-sql font-mono">
              {col}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle px-4 py-2 flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); addReference(id); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Quote size={12} />
          <span>引用</span>
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />
    </div>
  );
}

export default memo(SQLNode);
