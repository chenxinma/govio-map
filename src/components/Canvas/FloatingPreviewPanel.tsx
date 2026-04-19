import { useRef, useCallback, useState } from 'react';
import { Table2, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { PreviewPanel } from '../../store/canvas-store';
import { useCanvasStore } from '../../store/canvas-store';

const PAGE_SIZE = 10;

export default function FloatingPreviewPanel({ panel }: { panel: PreviewPanel }) {
  const close = useCanvasStore((s) => s.closePreviewPanel);
  const move = useCanvasStore((s) => s.movePreviewPanel);
  const [page, setPage] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data } = panel;
  const colNames = data.columns.map((c) => c.name);
  const totalPages = Math.ceil(data.previewData.length / PAGE_SIZE);
  const rows = data.previewData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button, table, .no-drag')) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startY: e.clientY, panelX: panel.x, panelY: panel.y };
      const onMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        move(panel.id, dragRef.current.panelX + dx, dragRef.current.panelY + dy);
      };
      const onMouseUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [panel.id, panel.x, panel.y, move]
  );

  return (
    <div
      ref={panelRef}
      className="absolute z-40 w-[620px] rounded-lg border border-border-default bg-bg-primary shadow-[0_8px_32px_rgba(0,0,0,0.4)] flex flex-col overflow-hidden select-none"
      style={{ left: panel.x, top: panel.y }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-2">
          <Table2 size={14} className="text-node-df" />
          <span className="text-sm font-medium text-text-primary">{data.dfName}</span>
          <span className="text-[11px] text-text-dim font-mono">{data.sourceName}</span>
        </div>
        <button
          onClick={() => close(panel.id)}
          className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface no-drag"
        >
          <X size={14} />
        </button>
      </div>

      <div className="overflow-auto max-h-[360px]">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-bg-surface z-10">
            <tr>
              <th className="text-left px-3 py-2 text-text-muted font-normal border-b border-border-subtle w-10">#</th>
              {colNames.map((col) => (
                <th key={col} className="text-left px-3 py-2 text-text-muted font-normal border-b border-border-subtle">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border-subtle/50 hover:bg-bg-surface/50">
                <td className="px-3 py-1.5 text-text-dim">{page * PAGE_SIZE + i}</td>
                {colNames.map((col) => (
                  <td key={col} className="px-3 py-1.5 text-text-secondary">
                    {String(row[col] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted no-drag">
        <span>
          {data.totalRows} rows · {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.previewData.length)}
        </span>
        <div className="flex items-center gap-1">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="p-1 rounded hover:bg-bg-surface disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="px-2 tabular-nums">{page + 1}/{totalPages}</span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
            className="p-1 rounded hover:bg-bg-surface disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
