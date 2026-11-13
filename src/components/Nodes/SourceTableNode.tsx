import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database, Quote, Trash2, ChevronDown, ChevronUp, Copy, Check, Link2, AlertTriangle } from 'lucide-react';
import type { SourceTableNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import { SEMANTIC_SOURCE_HANDLE, SEMANTIC_TARGET_HANDLE } from '../../utils/lineage';
import { nodeTableRelations } from '../../utils/table-relations';
import {
  MAX_VISIBLE_TABLE_RELATIONS,
  relationColumnView,
  relationTargetLabel,
  tableRelationsHint,
} from '../../utils/table-relations-ui';

function SourceTableNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SourceTableNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [relationsExpanded, setRelationsExpanded] = useState(false);
  const visibleFields = expanded ? nodeData.fields : nodeData.fields.slice(0, 6);
  const remaining = nodeData.fields.length - 6;
  // 表间关系（X13）：形状清洗复用 nodeTableRelations（脏元素过滤，不猜测补全）
  const relations = nodeTableRelations({ id, data: nodeData });
  const visibleRelations = relationsExpanded
    ? relations
    : relations.slice(0, MAX_VISIBLE_TABLE_RELATIONS);
  // 折叠基准与字段区同款：按上限固定计算剩余条数（展开后仍能收起）
  const remainingRelations = relations.length - MAX_VISIBLE_TABLE_RELATIONS;
  // 降级留痕提示：判定与配色唯一来源（正常态 graph / 无关系态 showHint=false，不打扰）
  const hint = tableRelationsHint({
    tableRelationsSource: nodeData.tableRelationsSource,
    tableRelationsError: nodeData.tableRelationsError,
    tableRelations: relations,
  });

  return (
    <div className="w-[280px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-source px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <Database size={14} className="text-node-source" />
          <span className="text-sm font-medium text-text-primary">{nodeData.tableName}</span>
          {/* 数据源类型徽标（T2.0）：旧节点无 datasourceType 时不渲染，回退旧显示 */}
          {nodeData.datasourceType && (
            <span
              className="ml-auto flex-shrink-0 text-[10px] px-1 py-0.5 rounded bg-node-source/10 text-node-source font-mono uppercase"
              title={nodeData.datasource ? `数据源：${nodeData.datasource}` : '数据源类型'}
            >
              {nodeData.datasourceType}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted font-mono uppercase tracking-[1.2px]">
          <span>{nodeData.database}</span>
          <span>{nodeData.rowCount?.toLocaleString()} rows</span>
        </div>
      </div>

      {/* SQL 全限定表名（T2.0）：一键复制，缺失时不渲染，不出现 undefined 文案 */}
      {nodeData.qualifiedName && (
        <div className="border-t border-border-subtle px-4 py-1.5 flex items-center gap-1.5">
          <span
            className="flex-1 min-w-0 truncate text-[11px] font-mono text-text-muted"
            title={`SQL 表引用：${nodeData.qualifiedName}`}
          >
            {nodeData.qualifiedName}
          </span>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await navigator.clipboard.writeText(nodeData.qualifiedName!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // Clipboard unavailable (e.g. insecure context); ignore.
              }
            }}
            className="flex-shrink-0 flex items-center p-0.5 rounded text-text-dim hover:text-brand hover:bg-brand/5 transition-colors"
            title="复制完整表名"
          >
            {copied ? <Check size={11} className="text-brand" /> : <Copy size={11} />}
          </button>
        </div>
      )}

      <div className="border-t border-border-subtle px-4 py-2">
        {visibleFields.map((field) => (
          <div key={field.name} className="py-[3px] text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-text-primary font-mono truncate" title={field.name}>{field.name}</span>
                {field.isPrimaryKey && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-brand/10 text-brand font-mono flex-shrink-0">PK</span>
                )}
                {field.isForeignKey && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-node-source/10 text-node-source font-mono flex-shrink-0">FK</span>
                )}
              </div>
              <span className="text-text-dim font-mono text-[11px] flex-shrink-0">{field.type}</span>
            </div>
            {field.description && (
              <div className="text-text-muted text-[11px] truncate mt-0.5" title={field.description}>
                {field.description}
              </div>
            )}
          </div>
        ))}
        {remaining > 0 && !expanded && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
          >
            <ChevronDown size={12} />
            <span>+{remaining} more fields</span>
          </button>
        )}
        {expanded && remaining > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
          >
            <ChevronUp size={12} />
            <span>Collapse</span>
          </button>
        )}
      </div>

      {/* 表间关系（X13）：X10 落到 node.data 的关系数据在节点内的出口——目标表 + 关系类型
          + 列映射 + 图谱说明。缺失的键一律不渲染（不出现空行/undefined）；没有关系时整节不渲染，
          旧节点形状不变。折叠范式与上方字段区一致（默认前 3 条 + 「+N more relations」）。 */}
      {relations.length > 0 && (
        <div className="border-t border-border-subtle px-4 py-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Link2 size={11} className="text-node-source flex-shrink-0" />
            <span className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted">表间关系</span>
            <span className="ml-auto text-[10px] font-mono text-text-dim">{relations.length}</span>
          </div>
          {visibleRelations.map((rel, index) => {
            const columns = relationColumnView(rel);
            return (
              <div key={`${rel.targetTable}-${index}`} className="py-[3px] text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="text-text-primary font-mono truncate"
                    title={`关系目标表：${rel.targetTable}`}
                  >
                    {relationTargetLabel(rel.targetTable)}
                  </span>
                  {rel.relationshipType && (
                    <span
                      className="text-[10px] px-1 py-0.5 rounded bg-node-source/10 text-node-source font-mono flex-shrink-0"
                      title="关系类型（图谱原值；字段级降级路径为 foreign_key）"
                    >
                      {rel.relationshipType}
                    </span>
                  )}
                </div>
                {columns.text && (
                  <div className="text-text-muted text-[11px] font-mono truncate mt-0.5" title={columns.text}>
                    {columns.text}
                  </div>
                )}
                {rel.description && (
                  <div className="text-text-muted text-[11px] truncate mt-0.5" title={rel.description}>
                    {rel.description}
                  </div>
                )}
              </div>
            );
          })}
          {remainingRelations > 0 && !relationsExpanded && (
            <button
              onClick={(e) => { e.stopPropagation(); setRelationsExpanded(true); }}
              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
            >
              <ChevronDown size={12} />
              <span>+{remainingRelations} more relations</span>
            </button>
          )}
          {relationsExpanded && remainingRelations > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setRelationsExpanded(false); }}
              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1"
            >
              <ChevronUp size={12} />
              <span>Collapse</span>
            </button>
          )}
        </div>
      )}

      {/* 降级留痕（X13）：来源=字段级或图谱查询失败时给一行轻提示（原因过长截断，全文放 title）；
          是否提示 / 文案 / 色值全部取 tableRelationsHint，组件内不散落判断、不写死色值 */}
      {hint.showHint && hint.badgeLabel && (
        <div className="border-t border-border-subtle px-4 py-1.5 flex items-center gap-1.5">
          <AlertTriangle size={11} className="flex-shrink-0" style={{ color: hint.hintColor }} />
          <span
            className="flex-shrink-0 text-[10px] px-1 py-0.5 rounded border font-mono"
            style={{ color: hint.hintColor, borderColor: hint.hintColor, backgroundColor: `${hint.hintColor}1a` }}
          >
            {hint.badgeLabel}
          </span>
          <span className="flex-1 min-w-0 truncate text-[11px] text-text-muted" title={hint.detailFull ?? ''}>
            {hint.detail}
          </span>
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
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-error transition-colors p-1 rounded-md hover:bg-error/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />
      {/* 语义血缘边专用（lineage.ts SEMANTIC_*_HANDLE）：表关系 RELATES_TO 边反向下出上入，
          与 sqlQuery 口径沿袭边（上出下入）区分；sourceTable 只会出现在表关系语义边两端 */}
      <Handle id={SEMANTIC_SOURCE_HANDLE} type="source" position={Position.Bottom} className="!bg-brand" />
      <Handle id={SEMANTIC_TARGET_HANDLE} type="target" position={Position.Top} className="!bg-brand" />
    </div>
  );
}

export default memo(SourceTableNode);
