import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps, type Edge } from '@xyflow/react';
import { AlertTriangle, ChevronDown, ChevronUp, Maximize2, Quote, Trash2, ScrollText, Tag } from 'lucide-react';
import type { SQLQueryNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import { caliberNodeAppearance, CALIBER_ASPECT_LABELS } from '../../utils/caliber';
import { MAX_VISIBLE_SEMANTIC_REFS, semanticRefBadges } from '../../utils/semantic-refs-ui';
import { SEMANTIC_SOURCE_HANDLE, SEMANTIC_TARGET_HANDLE } from '../../utils/lineage';
import SQLModal from './SQLModal';
import ManifestDetails from './ManifestDetails';
import { SQL_TOKEN_CLASS, tokenizeSQL } from '../../utils/sql-highlight';

/**
 * SQL 关键字高亮（X21）：分类与配色与 SQL 编辑弹窗同源——
 * tokenizeSQL 出 token，SQL_TOKEN_CLASS 给 class，index.css 给颜色。
 * data-sqltok 供测试与样式定位用，不参与渲染。
 */
function highlightSQL(sql: string): React.ReactNode[] {
  return tokenizeSQL(sql).map((token, i) =>
    token.kind === 'plain'
      ? token.text
      : (
        <span key={i} data-sqltok={token.kind} className={SQL_TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ),
  );
}

function SQLNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SQLQueryNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [isEditing, setIsEditing] = useState(nodeData.sql === '');
  const [editValue, setEditValue] = useState(nodeData.sql);
  const [showModal, setShowModal] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  const [showCaliber, setShowCaliber] = useState(false);
  const [refsExpanded, setRefsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // T2.3 口径冲突检测：仅 conflict 亮黄色警示（consistent/unknown 不打扰）
  const caliber = caliberNodeAppearance(nodeData.caliberCheck);
  const caliberDifferences = nodeData.caliberCheck?.differences ?? [];

  // X18 口径徽标（PD-1 方案 1）：过滤 / 去重 / Metric 优先排序全部取 semanticRefBadges，
  // 组件内不重复实现；结果为空（旧节点、手动建的 SQL 节点、图谱降级、refs 只有 Col）时
  // 整节不渲染，画布上不留空壳行。折叠基准与字段区 / 关系小节同款：按上限固定计算剩余
  // 条数，展开后仍能收起。
  const semanticBadges = semanticRefBadges(nodeData.semanticRefs);
  const visibleSemanticBadges = refsExpanded
    ? semanticBadges
    : semanticBadges.slice(0, MAX_VISIBLE_SEMANTIC_REFS);
  const remainingSemanticBadges = semanticBadges.length - MAX_VISIBLE_SEMANTIC_REFS;

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

  // X21：SQL 改完「输出列」要跟着变。抽取器与服务端建节点用的是同一个模块
  // （src/utils/sql-columns），前端按需懒加载，不进首屏 chunk。
  // 抽不出列名（`SELECT *`、无别名表达式、解析全失败）时保留原值：
  // 节点上的既有值可能是服务端给的 `tableName.*` 兜底，清空是退步。
  const commitSQL = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      const patch: { sql: string; outputColumns?: string[] } = { sql: trimmed };
      try {
        const { extractSelectColumns } = await import('../../utils/sql-columns');
        const columns = extractSelectColumns(trimmed);
        if (columns.length > 0) patch.outputColumns = columns;
      } catch {
        // 抽取模块不可用：只改 SQL，保留既有输出列
      }
      updateNodeData(id, patch);
    },
    [id, updateNodeData],
  );

  const handleSave = useCallback(() => {
    void commitSQL(editValue);
    setIsEditing(false);
  }, [commitSQL, editValue]);

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
    <div
      className="w-[300px] rounded-lg border border-border-default bg-bg-card overflow-hidden"
      style={caliber.showWarning ? { borderColor: caliber.warningColor } : undefined}
    >
      <div className="border-l-[3px] border-l-node-sql px-4 py-3 flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary truncate">{nodeData.title}</span>
        {caliber.showWarning && caliber.badgeLabel && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowCaliber((v) => !v); }}
            title="口径与图谱指标定义存在冲突，点击查看差异说明"
            className="ml-auto flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0"
            style={{ color: caliber.warningColor, borderColor: caliber.warningColor, backgroundColor: `${caliber.warningColor}1a` }}
          >
            <AlertTriangle size={11} />
            <span>{caliber.badgeLabel}</span>
            <ChevronDown size={11} className={showCaliber ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
        )}
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

      {/* 口径徽标（X18，PD-1 方案 1）：本次 SQL 引用的图谱指标 / 维度在画布上直接可见。
          取值与排序唯一来源 semanticRefBadges；配色走 green-deck token（紫 = 语义层，与语义
          血缘边同色系），组件内不写死色值。与 T2.3 警示的分工：警示永远在标题行、黄色只由
          caliberNodeAppearance 给出，本节独立成行，冲突态下互不遮挡、不借用警示色。
          完整信息（类型 / 编码 / 名称 / 图谱 ID）按 X15.1 取舍放 hover title。 */}
      {semanticBadges.length > 0 && (
        <div className="border-t border-border-subtle px-4 py-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Tag size={11} className="text-node-source flex-shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted">口径</span>
            <span className="ml-auto text-[10px] font-mono text-text-dim">{semanticBadges.length}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {visibleSemanticBadges.map((badge) => (
              <span
                key={badge.key}
                title={badge.title}
                className="max-w-full truncate text-[11px] px-1.5 py-0.5 rounded bg-node-source/10 text-node-source font-mono"
              >
                {badge.text}
              </span>
            ))}
          </div>
          {remainingSemanticBadges > 0 && !refsExpanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setRefsExpanded(true); }}
              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
            >
              <ChevronDown size={12} />
              <span>+{remainingSemanticBadges} more refs</span>
            </button>
          )}
          {refsExpanded && remainingSemanticBadges > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setRefsExpanded(false); }}
              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
            >
              <ChevronUp size={12} />
              <span>Collapse</span>
            </button>
          )}
        </div>
      )}

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

      {showManifest && nodeData.manifest && (
        <div className="border-t border-border-subtle px-4 py-2">
          <ManifestDetails manifest={nodeData.manifest} />
        </div>
      )}

      {showCaliber && caliberDifferences.length > 0 && (
        <div className="border-t border-border-subtle px-4 py-2">
          <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted mb-1.5">口径差异</div>
          {caliberDifferences.map((d, i) => (
            <div key={`${d.metricCode ?? ''}-${d.aspect}-${i}`} className="mb-2 last:mb-0">
              <div className="text-[11px] font-medium" style={{ color: caliber.warningColor }}>
                {d.metricCode ? `${d.metricCode} · ` : ''}
                {CALIBER_ASPECT_LABELS[d.aspect] ?? d.aspect}
              </div>
              <div className="text-[10px] text-text-secondary leading-relaxed">
                <span className="text-text-muted">期望：</span>{d.expected}
              </div>
              <div className="text-[10px] text-text-secondary leading-relaxed">
                <span className="text-text-muted">实际：</span>{d.found}
              </div>
              {d.detail && <div className="text-[10px] text-text-dim leading-relaxed">{d.detail}</div>}
            </div>
          ))}
        </div>
      )}

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
        <button
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-error transition-colors p-1 rounded-md hover:bg-error/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />
      {/* 语义血缘边专用（lineage.ts SEMANTIC_*_HANDLE）：下出上入（与 SourceTable 统一，
          配合方案B同列纵向堆叠，线走在两节点间不穿节点） */}
      <Handle id={SEMANTIC_SOURCE_HANDLE} type="source" position={Position.Bottom} className="!bg-brand" />
      <Handle id={SEMANTIC_TARGET_HANDLE} type="target" position={Position.Top} className="!bg-brand" />

      {showModal && (
        <SQLModal
          sql={nodeData.sql}
          title={nodeData.title}
          onSave={(newSql) => {
            void commitSQL(newSql);
            setShowModal(false);
          }}
          onClose={() => setShowModal(false)}
          onExecuteSuccess={(dfName) => {
            // 查找新创建的DataFrame节点并添加边
            const nodes = useCanvasStore.getState().nodes;
            const dfNode = nodes.find((n) => {
              const d = n.data as unknown as { dfName?: string };
              return d.dfName === dfName;
            });
            if (dfNode) {
              const newEdge: Edge = {
                id: `edge-${id}-${dfNode.id}`,
                source: id,
                target: dfNode.id,
                type: 'default',
              };
              useCanvasStore.setState((state) => ({
                edges: [...state.edges, newEdge],
              }));
            }
          }}
        />
      )}
    </div>
  );
}

export default memo(SQLNode);
