import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BarChart3, LineChart, Quote, Trash2 } from 'lucide-react';
import type { ChartNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function ChartNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as ChartNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);

  const icon = nodeData.chartType === 'line'
    ? <LineChart size={14} className="text-sky-400" />
    : <BarChart3 size={14} className="text-sky-400" />;

  return (
    <div className="w-[420px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-chart px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted font-mono border border-border-subtle">
            {nodeData.sourceDf}
          </span>
          <span className="text-[10px] text-text-dim">
            {nodeData.xColumn} / {nodeData.yColumn}
          </span>
        </div>
      </div>

      <div className="border-t border-border-subtle p-2">
        <img
          src={`data:image/png;base64,${nodeData.imageBase64}`}
          alt={nodeData.title}
          className="w-full rounded"
          draggable={false}
        />
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

export default memo(ChartNode);
