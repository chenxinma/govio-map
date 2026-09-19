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
  nodeId: string;
  onSave: (sql: string) => void;
  onClose: () => void;
  onExecuteSuccess?: (dfName: string) => void;
}

interface InitData {
  datasources: string[];
  dataframes: string[];
}

// 自动生成DataFrame名称：基于SQL的hash
function generateDfName(sql: string): string {
  let hash = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // 转换为32位整数
  }
  return `df_${Math.abs(hash).toString(36)}`;
}

export default function SQLModal({ sql: initialSql, title, nodeId, onSave, onClose, onExecuteSuccess }: Props) {
  const nodes = useCanvasStore((s) => s.nodes);
  const [value, setValue] = useState(initialSql);
  const [datasources, setDatasources] = useState<string[]>(['memory']);
  const [dataframes, setDataframes] = useState<string[]>([]);
  const [selectedDatasource, setSelectedDatasource] = useState('memory');
  const [isExecuting, setIsExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // 从画布节点提取补全源
  const completionSources = useMemo(() => getCompletionSources(nodes), [nodes]);
  // 合并API返回的dataframes（无列信息）
  const allSources = useMemo(() => {
    const merged = new Map(completionSources);
    dataframes.forEach((df) => {
      if (!merged.has(df)) {
        merged.set(df, []); // 只有表名，无列信息
      }
    });
    return merged;
  }, [completionSources, dataframes]);
  const customCompletion = useMemo(() => createSQLCompletion(allSources), [allSources]);

  // 初始化：加载数据源和DataFrame列表
  useEffect(() => {
    console.log('[SQLModal] useEffect running...');
    const controller = new AbortController();
    
    fetch('/api/sql-editor-init', { signal: controller.signal })
      .then((res) => {
        console.log('[SQLModal] Response received, status:', res.status);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: InitData) => {
        console.log('[SQLModal] Data parsed:', data);
        console.log('[SQLModal] Setting datasources to:', ['memory', ...data.datasources]);
        // 数据源列表：memory + 外部数据源
        setDatasources(['memory', ...data.datasources]);
        setDataframes(data.dataframes);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.error('[SQLModal] Failed to load init data:', err);
        }
      });
    
    return () => {
      console.log('[SQLModal] Cleanup, aborting fetch');
      controller.abort();
    };
  }, []);

  // 执行SQL
  const handleExecute = useCallback(async () => {
    if (!selectedDatasource || !value.trim()) return;
    const name = generateDfName(value.trim());
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
      
      // 通知父节点执行成功
      if (onExecuteSuccess) {
        onExecuteSuccess(name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setExecuteResult({ type: 'error', message });
    } finally {
      setIsExecuting(false);
    }
  }, [selectedDatasource, value]);

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
            className="px-2 py-1 text-xs text-text-primary bg-bg-primary border border-border-default rounded focus:outline-none focus:border-brand min-w-[120px] appearance-auto"
          >
            {datasources.length === 0 ? (
              <option value="">加载中...</option>
            ) : (
              datasources.map((ds) => (
                <option key={ds} value={ds}>{ds}</option>
              ))
            )}
          </select>
          <span className="text-[10px] text-text-dim">
            {selectedDatasource === 'memory' ? '使用已加载的DataFrame' : '从数据库抽取'}
          </span>
          <div className="flex-1" />
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
