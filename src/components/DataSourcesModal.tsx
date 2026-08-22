import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Database, RefreshCw, Table2 } from "lucide-react";
import { useChatContext } from "../hooks/useChatContext";
import type { ObserveInfo } from "../hooks/useChat";

interface DataSourcesModalProps {
  onClose: () => void;
}

export default function DataSourcesModal({ onClose }: DataSourcesModalProps) {
  const { observeInfo } = useChatContext();
  const [info, setInfo] = useState<ObserveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchInfo = useCallback(() => {
    return observeInfo()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [observeInfo]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    fetchInfo();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const datasources = info?.datasources ?? [];
  const dataframes = info?.dataframes?.dataframes ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[560px] max-w-[92vw] max-h-[90vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Database size={16} className="text-brand" />
            <span className="text-sm font-medium text-text-primary">数据源</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface disabled:opacity-40"
              title="刷新"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {error && (
            <div className="text-sm text-error border border-error/40 bg-error/10 rounded-md px-3 py-2">
              加载失败: {error}
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs text-text-muted">已配置数据源（{datasources.length}）</span>
            {loading && !info ? (
              <div className="text-sm text-text-dim">加载中...</div>
            ) : datasources.length === 0 ? (
              <div className="text-sm text-text-dim">暂无已配置数据源</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {datasources.map((ds) => (
                  <span
                    key={ds}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm bg-bg-surface border border-border-default text-text-primary"
                  >
                    <Database size={12} className="text-brand" />
                    {ds}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <span className="text-xs text-text-muted">已加载 DataFrame（{dataframes.length}）</span>
            {dataframes.length === 0 ? (
              <div className="text-sm text-text-dim">暂无已加载的 DataFrame</div>
            ) : (
              <div className="border border-border-subtle rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-bg-surface text-text-muted text-xs">
                      <th className="text-left px-3 py-2 font-medium">名称</th>
                      <th className="text-right px-3 py-2 font-medium">行数</th>
                      <th className="text-right px-3 py-2 font-medium">列数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataframes.map((df) => (
                      <tr key={df.name} className="border-t border-border-subtle">
                        <td className="px-3 py-2 text-text-primary">
                          <span className="inline-flex items-center gap-1.5">
                            <Table2 size={12} className="text-node-df" />
                            {df.name}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-text-secondary font-mono">
                          {df.rows.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right text-text-secondary font-mono">{df.columns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
