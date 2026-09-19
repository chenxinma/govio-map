import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Maximize2, Quote, Trash2 } from 'lucide-react';
import type { SQLQueryNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import SQLModal from './SQLModal';

// SQL关键字高亮
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON', 'AS', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'BY', 'ORDER',
  'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'INSERT', 'INTO',
  'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP',
  'INDEX', 'VIEW', 'IF', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'CASE',
  'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'COALESCE', 'CAST', 'OVER', 'PARTITION', 'WITH', 'RECURSIVE',
];

function highlightSQL(sql: string): React.ReactNode[] {
  if (!sql) return [];
  const regex = new RegExp(`(${SQL_KEYWORDS.join('|')})`, 'gi');
  const parts = sql.split(regex);
  return parts.map((part, i) => {
    if (SQL_KEYWORDS.includes(part.toUpperCase())) {
      return <span key={i} className="text-violet-400 font-semibold">{part}</span>;
    }
    // 字符串高亮
    if (/^['"].*['"]$/.test(part)) {
      return <span key={i} className="text-amber-400">{part}</span>;
    }
    // 数字高亮
    if (/^\d+$/.test(part)) {
      return <span key={i} className="text-emerald-400">{part}</span>;
    }
    return part;
  });
}

function SQLNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SQLQueryNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [isEditing, setIsEditing] = useState(nodeData.sql === '');
  const [editValue, setEditValue] = useState(nodeData.sql);
  const [showModal, setShowModal] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [isEditing, editValue]);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim();
    updateNodeData(id, { sql: trimmed });
    setIsEditing(false);
  }, [id, editValue, updateNodeData]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        setEditValue(nodeData.sql);
        setIsEditing(false);
      }
    },
    [handleSave, nodeData.sql]
  );

  const handleDoubleClick = useCallback(() => {
    setEditValue(nodeData.sql);
    setIsEditing(true);
  }, [nodeData.sql]);

  const sqlLines = nodeData.sql.split('\n').slice(0, 8);
  const hasMore = nodeData.sql.split('\n').length > 8;

  return (
    <div className="w-[300px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-sql px-4 py-3">
        <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
      </div>

      <div className="border-t border-border-subtle px-4 py-3">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            placeholder="输入 SQL... (Ctrl+Enter 保存)"
            className="w-full text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap bg-bg-primary border border-brand/30 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-brand/50"
            rows={3}
          />
        ) : (
          <pre
            onDoubleClick={handleDoubleClick}
            className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all cursor-text bg-bg-primary/50 rounded px-2 py-1.5"
            title="双击编辑 SQL"
          >
            {nodeData.sql ? (
              <>
                {highlightSQL(sqlLines.join('\n'))}
                {hasMore && <span className="text-text-dim">\n...</span>}
              </>
            ) : (
              <span className="text-text-dim italic">双击编辑 SQL</span>
            )}
          </pre>
        )}
      </div>

      <div className="border-t border-border-subtle px-4 py-2">
        <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted mb-1.5">输出列</div>
        <div className="flex flex-wrap gap-1">
          {nodeData.outputColumns.map((col) => (
            <span key={col} className="text-[11px] px-1.5 py-0.5 rounded bg-node-sql/10 text-node-sql font-mono">
              {col}
            </span>
          ))}
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
          <span>编辑</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-error transition-colors p-1 rounded-md hover:bg-error/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />

      {showModal && (
        <SQLModal
          sql={nodeData.sql}
          title={nodeData.title}
          onSave={(newSql) => {
            updateNodeData(id, { sql: newSql });
            setShowModal(false);
          }}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

export default memo(SQLNode);
