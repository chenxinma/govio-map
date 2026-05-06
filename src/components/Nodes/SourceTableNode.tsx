import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database, Quote, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import type { SourceTableNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function SourceTableNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SourceTableNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const [expanded, setExpanded] = useState(false);
  const visibleFields = expanded ? nodeData.fields : nodeData.fields.slice(0, 6);
  const remaining = nodeData.fields.length - 6;

  return (
    <div className="w-[280px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-source px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Database size={14} className="text-node-source" />
          <span className="text-sm font-medium text-text-primary">{nodeData.tableName}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted font-mono uppercase tracking-[1.2px]">
          <span>{nodeData.database}</span>
          <span>{nodeData.rowCount?.toLocaleString()} rows</span>
        </div>
      </div>

      <div className="border-t border-border-subtle px-4 py-2">
        {visibleFields.map((field) => (
          <div key={field.name} className="flex items-center justify-between py-[3px] text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-text-primary font-mono">{field.name}</span>
              {field.isPrimaryKey && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-brand/10 text-brand font-mono">PK</span>
              )}
              {field.isForeignKey && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-node-source/10 text-node-source font-mono">FK</span>
              )}
            </div>
            <span className="text-text-dim font-mono text-[11px]">{field.type}</span>
          </div>
        ))}
        {remaining > 0 && !expanded && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
          >
            <ChevronDown size={12} />
            <span>+{remaining} more fields</span>
          </button>
        )}
        {expanded && remaining > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
          >
            <ChevronUp size={12} />
            <span>Collapse</span>
          </button>
        )}
      </div>

      <div className="border-t border-border-subtle px-4 py-2 flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); addReference(id); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Quote size={12} />
          <span>引用</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-red-400 transition-colors p-1 rounded-md hover:bg-red-400/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />
    </div>
  );
}

export default memo(SourceTableNode);
