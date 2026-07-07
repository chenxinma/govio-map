import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BarChart3, Maximize2, Quote, Trash2 } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { ChartNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import ChartModal from './ChartModal';

Chart.register(...registerables);

function ChartNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as ChartNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [hasError, setHasError] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- effect synchronizes chart.js lifecycle; hasError reflects constructor failures */
  useEffect(() => {
    if (!canvasRef.current) return;
    setHasError(false);
    try {
      chartRef.current = new Chart(canvasRef.current, nodeData.config as ConstructorParameters<typeof Chart>[1]) as Chart;
    } catch (err) {
      console.error('[ChartNode] chart render failed:', err);
      setHasError(true);
    }
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [nodeData.config]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="w-[420px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-chart px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <BarChart3 size={14} className="text-sky-400" />
          <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
        </div>
        {nodeData.sourceDf && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted font-mono border border-border-subtle">
              {nodeData.sourceDf}
            </span>
            <span className="text-[10px] text-text-dim font-mono uppercase">
              {nodeData.config.type}
            </span>
          </div>
        )}
      </div>

      <div
        className="border-t border-border-subtle p-2 cursor-zoom-in"
        onClick={() => setShowModal(true)}
      >
        <div className="relative">
          <canvas ref={canvasRef} className={`w-full h-[260px] ${hasError ? 'hidden' : ''}`} />
          {hasError && (
            <div className="flex items-center justify-center h-[260px] text-xs text-text-muted">
              图表配置错误
            </div>
          )}
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
        <button
          onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Maximize2 size={12} />
          <span>放大</span>
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

      {showModal && (
        <ChartModal
          config={nodeData.config}
          title={nodeData.title}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

export default memo(ChartNode);
