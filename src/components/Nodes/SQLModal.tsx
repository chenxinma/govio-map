import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
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

  // 从画布节点提取补全源
  const completionSources = useMemo(() => getCompletionSources(nodes), [nodes]);
  const customCompletion = useMemo(() => createSQLCompletion(completionSources), [completionSources]);

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