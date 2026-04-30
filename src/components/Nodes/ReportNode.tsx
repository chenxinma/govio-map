import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Quote, GitCompare, TrendingUp } from 'lucide-react';
import type { ReportNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let tableRows: string[][] = [];
  let inTable = false;

  const flushTable = () => {
    if (tableRows.length > 0) {
      const header = tableRows[0];
      const body = tableRows.slice(2);
      elements.push(
        <div key={`table-${elements.length}`} className="overflow-x-auto my-2">
          <table className="w-full text-[11px] font-mono border-collapse">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th key={i} className="text-left px-2 py-1 text-text-muted font-normal border-b border-border-subtle">
                    {cell.trim()}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className="border-b border-border-subtle/50">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-2 py-1 text-text-secondary">
                      {cell.trim()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableRows = [];
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('|') && line.endsWith('|')) {
      inTable = true;
      tableRows.push(line.split('|').filter((c) => c !== ''));
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (line.startsWith('## ')) {
      elements.push(
        <div key={i} className="text-xs font-medium text-brand mt-3 mb-1.5">
          {line.slice(3)}
        </div>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <div key={i} className="text-[11px] font-medium text-text-primary mt-2 mb-1">
          {line.slice(4)}
        </div>
      );
    } else if (line.startsWith('- **')) {
      const match = line.match(/^- \*\*(.+?)\*\*:?\s*(.*)$/);
      if (match) {
        elements.push(
          <div key={i} className="text-[11px] text-text-secondary leading-relaxed pl-2 py-[1px]">
            <span className="text-text-primary">{match[1]}</span>
            {match[2] && <span>: {match[2]}</span>}
          </div>
        );
      }
    } else if (line.startsWith('- ')) {
      elements.push(
        <div key={i} className="text-[11px] text-text-secondary leading-relaxed pl-2 py-[1px]">
          {line.slice(2)}
        </div>
      );
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^\d+\.\s+(.*)$/);
      if (match) {
        elements.push(
          <div key={i} className="text-[11px] text-text-secondary leading-relaxed pl-2 py-[1px]">
            {match[1]}
          </div>
        );
      }
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-1" />);
    } else {
      elements.push(
        <div key={i} className="text-[11px] text-text-secondary leading-relaxed">
          {line}
        </div>
      );
    }
  }
  if (inTable) flushTable();

  return elements;
}

function ReportNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as ReportNodeData;
  const addReference = useCanvasStore((s) => s.addReference);

  const icon = nodeData.reportType === 'correlation'
    ? <TrendingUp size={14} className="text-violet-400" />
    : <GitCompare size={14} className="text-amber-400" />;

  const borderColor = nodeData.reportType === 'correlation'
    ? 'border-l-violet-400'
    : 'border-l-amber-400';
  console.log(nodeData);
  return (
    <div className="w-[380px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className={`border-l-[3px] ${borderColor} px-4 py-3`}>
        <div className="flex items-center gap-2 mb-1">
          {icon}
          <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {nodeData.sourceRefs.map((ref) => (
            <span key={ref.label} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted font-mono border border-border-subtle">
              {ref.label}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle px-4 py-3 max-h-[400px] overflow-y-auto">
        {parseMarkdown(nodeData.content)}
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

export default memo(ReportNode);
