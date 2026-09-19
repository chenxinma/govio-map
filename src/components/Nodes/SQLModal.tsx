import { useEffect, useMemo, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Play, Loader2, Check, AlertCircle } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { useCanvasStore } from '../../store/canvas-store';
import { getCompletionSources, createSQLCompletion } from './sql-completions';

interface Props {
  sql: string;
  title: string;
  onSave: (sql: string) => void;
  onClose: () => void;
}

export default function SQLModal({ sql: initialSql, title, onSave, onClose }: Props) {
  const nodes = useCanvasStore((s) => s.nodes);
  const [value, setValue] = useState(initialSql);
  const [datasources, setDatasources] = useState<string[]>([]);
  const [selectedDatasource, setSelectedDatasource] = useState('');
  const [dfName, setDfName] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // 从画布节点提取补全源
  const completionSources = useMemo(() => getCompletionSources(nodes), [nodes]);
  const customCompletion = useMemo(() => createSQLCompletion(completionSources), [completionSources]);

  // 加载数据源列表
  useEffect(() => {
    fetch('/api/datasources')
      .then((res) => res.json())
      .then((data) => {
        if (data.datasources) {
          setDatasources(data.datasources);
          if (data.datasources.length > 0) {
            setSelectedDatasource(data.datasources[0]);
          }
        }
      })
      .catch((err) => console.error('Failed to load datasources:', err));
  }, []);

  // 执行SQL
  const handleExecute = useCallback(async () => {
    if (!selectedDatasource || !value.trim()) return;
    const name = dfName.trim() || `df_${Date.now()}`;
    setIsExecuting(true);
    setExecuteResult(null);

    try {
      const res = await fetch('/api/execute-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasource: selectedDatasource,
          name,
          sql: value.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '执行失败');

      setExecuteResult({ type: 'success', message: `DataFrame "${name}" 加载成功，节点已创建` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExecuteResult({ type: 'error', message });
    } finally {
      setIsExecuting(false);
    }
  }, [selectedDatasource, value, dfName]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onSave(value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSave, value]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[900px] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
          >
            <X size={16} />
          </button>
        </div>

        {/* 编辑器 */}
        <div className="flex-1 min-h-0 p-4">
          <CodeMirror
            value={value}
            height="60vh"
            extensions={[
              sql(),
              customCompletion,
            ]}
            theme={oneDark}
            onChange={(val) => setValue(val)}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
            }}
          />
        </div>

        {/* 数据源选择和执行 */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-border-subtle">
          <select
            value={selectedDatasource}
            onChange={(e) => setSelectedDatasource(e.target.value)}
            className="px-2 py-1 text-xs bg-bg-primary border border-border-default rounded focus:outline-none focus:border-brand"
          >
            <option value="">选择数据源</option>
            {datasources.map((ds) => (
              <option key={ds} value={ds}>{ds}</option>
            ))}
          </select>
          <input
            type="text"
            value={dfName}
            onChange={(e) => setDfName(e.target.value)}
            placeholder="DataFrame名称（可选）"
            className="px-2 py-1 text-xs bg-bg-primary border border-border-default rounded focus:outline-none focus:border-brand flex-1"
          />
          <button
            onClick={handleExecute}
            disabled={!selectedDatasource || !value.trim() || isExecuting}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isExecuting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            <span>执行</span>
          </button>
        </div>

        {/* 执行结果提示 */}
        {executeResult && (
          <div className={`flex items-center gap-2 px-4 py-2 text-xs ${
            executeResult.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-error/10 text-error'
          }`}>
            {executeResult.type === 'success' ? <Check size={12} /> : <AlertCircle size={12} />}
            <span>{executeResult.message}</span>
          </div>
        )}

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-xs text-text-dim font-mono">Ctrl+Enter 保存 · ESC 取消</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-primary transition-colors rounded hover:bg-bg-surface"
            >
              取消
            </button>
            <button
              onClick={() => onSave(value)}
              className="px-3 py-1.5 text-xs bg-brand text-white rounded hover:bg-brand/90 transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}