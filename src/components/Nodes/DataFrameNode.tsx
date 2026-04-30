import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Table2, Quote, Eye, Trash2 } from 'lucide-react';
import type { DataFrameNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function DataFrameNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as DataFrameNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const openPreviewPanel = useCanvasStore((s) => s.openPreviewPanel);

  return (
    <div className="w-[320px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-df px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Table2 size={14} className="text-node-df" />
          <span className="text-sm font-medium text-text-primary">{nodeData.dfName}</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          {nodeData.sourceName}
        </div>
      </div>

      <div className="border-t border-border-subtle px-4 py-2">
        <div className="flex items-center gap-4 text-[11px] text-text-dim font-mono mb-2">
          <span>{nodeData.totalRows} entries</span>
          <span>{nodeData.totalColumns} columns</span>
          <span>{nodeData.memoryUsage}</span>
        </div>
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-text-muted border-b border-border-subtle">
              <th className="text-left py-1 pr-2 font-normal">#</th>
              <th className="text-left py-1 pr-2 font-normal">Column</th>
              <th className="text-right py-1 pr-2 font-normal">Non-Null</th>
              <th className="text-right py-1 font-normal">Dtype</th>
            </tr>
          </thead>
          <tbody>
            {nodeData.columns.map((col, i) => (
              <tr key={col.name} className="border-b border-border-subtle/50">
                <td className="py-[3px] pr-2 text-text-dim">{i}</td>
                <td className="py-[3px] pr-2 text-text-primary">{col.name}</td>
                <td className="py-[3px] pr-2 text-right text-text-muted">{col.nonNull}</td>
                <td className="py-[3px] text-right text-node-df">{col.dtype}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          onClick={(e) => { e.stopPropagation(); openPreviewPanel(id); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Eye size={12} />
          <span>预览</span>
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

export default memo(DataFrameNode);
