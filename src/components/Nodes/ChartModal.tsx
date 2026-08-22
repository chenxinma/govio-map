import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import Plotly from 'plotly.js-dist-min';
import type { ChartConfig } from '../../types';

interface Props {
  config: ChartConfig;
  title: string;
  onClose: () => void;
}

export default function ChartModal({ config, title, onClose }: Props) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    setHasError(false);
    Plotly.react(el, config.data, { ...config.layout, autosize: true }, { responsive: true, displayModeBar: 'hover' })
      .catch((err: unknown) => {
        console.error('[ChartModal] chart render failed:', err);
        setHasError(true);
      });
    return () => {
      Plotly.purge(el);
    };
  }, [config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[1200px] max-w-[95vw] max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 flex-1 min-h-0 relative">
          <div ref={plotRef} className={`w-full h-[75vh] ${hasError ? 'hidden' : ''}`} />
          {hasError && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-text-muted">
              图表配置错误
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
