import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Table2, Quote, Eye, Trash2, ChevronDown, ChevronUp, ScrollText, RotateCw, AlertTriangle } from 'lucide-react';
import type { DataFrameNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import { canRerun, hasDrift, latestRerun } from '../../utils/rerun';
import ManifestDetails from './ManifestDetails';
import RerunStatus from './RerunStatus';

function DataFrameNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as DataFrameNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const openPreviewPanel = useCanvasStore((s) => s.openPreviewPanel);
  const rerunDataFrame = useCanvasStore((s) => s.rerunDataFrame);
  const rerunning = useCanvasStore((s) => s.rerunningNodeIds.includes(id));
  const rerunError = useCanvasStore((s) => s.rerunErrors[id]);
  const [expanded, setExpanded] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const visibleColumns = expanded ? nodeData.columns : nodeData.columns.slice(0, 10);
  const remaining = nodeData.columns.length - 10;
  // 漂移警告以最近一次复跑结论为准：原 Manifest 不被覆盖，旧值/新值在复跑记录里
  const drifted = hasDrift(nodeData);

  return (
    <div className={`w-[320px] rounded-lg border bg-bg-card overflow-hidden ${drifted ? 'border-warning/60' : 'border-border-default'}`}>
      <div className="border-l-[3px] border-l-node-df px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Table2 size={14} className="text-node-df" />
          <span className="text-sm font-medium text-text-primary">{nodeData.dfName}</span>
          {drifted && (
            <span
              className="flex items-center gap-1 rounded bg-warning/10 px-1.5 py-[1px] text-[10px] font-mono text-warning"
              title={`复跑检测到漂移：${latestRerun(nodeData)?.diff?.summary ?? '结果与原留痕不一致'}`}
            >
              <AlertTriangle size={10} />
              <span>漂移</span>
            </span>
          )}
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
            {visibleColumns.map((col, i) => (
              <tr key={col.name} className="border-b border-border-subtle/50">
                <td className="py-[3px] pr-2 text-text-dim">{i}</td>
                <td className="py-[3px] pr-2 text-text-primary">{col.name}</td>
                <td className="py-[3px] pr-2 text-right text-text-muted">{col.nonNull}</td>
                <td className="py-[3px] text-right text-node-df">{col.dtype}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {remaining > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{expanded ? 'Collapse' : `+${remaining} more fields`}</span>
          </button>
        )}
      </div>

      <RerunStatus data={nodeData} running={rerunning} requestError={rerunError} />

      {showManifest && nodeData.manifest && (
        <div className="border-t border-border-subtle px-4 py-2">
          <ManifestDetails manifest={nodeData.manifest} />
        </div>
      )}

      {/* 5 个按钮在 320px 卡片里偏宽，flex-wrap 保证不溢出 */}
      <div className="border-t border-border-subtle px-4 py-2 flex flex-wrap gap-2">
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
        {nodeData.manifest && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowManifest(!showManifest); }}
            title="查看分析留痕（Manifest）"
            className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
          >
            <ScrollText size={12} />
            <span>详情</span>
          </button>
        )}
        {canRerun(nodeData) && (
          <button
            onClick={(e) => { e.stopPropagation(); void rerunDataFrame(id); }}
            disabled={rerunning}
            title="按留痕固化的 SQL 与数据源复跑，对比行数/校验和；漂移时保留原结果并告警"
            className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5 disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-default"
          >
            <RotateCw size={12} className={rerunning ? 'animate-spin' : ''} />
            <span>{rerunning ? '复跑中' : '复跑'}</span>
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-error transition-colors p-1 rounded-md hover:bg-error/10"
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
