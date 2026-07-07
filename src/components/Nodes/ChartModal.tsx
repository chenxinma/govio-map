import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { ChartConfig } from '../../types';

Chart.register(...registerables);

interface Props {
  config: ChartConfig;
  title: string;
  onClose: () => void;
}

export default function ChartModal({ config, title, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [hasError, setHasError] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- effect synchronizes chart.js lifecycle; hasError reflects constructor failures */
  useEffect(() => {
    if (!canvasRef.current) return;
    setHasError(false);
    const modalConfig: ChartConfig = {
      ...config,
      options: {
        ...(config.options ?? {}),
        responsive: true,
        maintainAspectRatio: false,
      },
    };
    try {
      chartRef.current = new Chart(canvasRef.current, modalConfig as Parameters<typeof Chart>[1]);
    } catch (err) {
      console.error('[ChartModal] chart render failed:', err);
      setHasError(true);
    }
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [config]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
        className="bg-bg-card border border-border-default rounded-lg w-[860px] max-w-[90vw] max-h-[90vh] flex flex-col"
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
          <canvas ref={canvasRef} className={`w-full h-[520px] ${hasError ? 'hidden' : ''}`} />
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
