import { Database } from 'lucide-react';
import { MOCK_TABLES } from '../../data/mock-tables';

export default function Sidebar() {
  const onDragStart = (event: React.DragEvent, tableName: string) => {
    event.dataTransfer.setData('application/reactflow', tableName);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-[280px] h-full bg-bg-primary border-r border-border-default flex flex-col">
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 mb-1">
          <Database size={14} className="text-brand" />
          <span className="text-xs font-mono uppercase tracking-[1.2px] text-text-muted">
            数据表
          </span>
        </div>
        <p className="text-[11px] text-text-dim">
          拖拽表到画布上创建节点
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {MOCK_TABLES.map((table) => (
          <div
            key={table.tableName}
            draggable
            onDragStart={(e) => onDragStart(e, table.tableName)}
            className="px-4 py-3 border-b border-border-subtle cursor-grab active:cursor-grabbing hover:bg-bg-surface transition-colors group"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-text-primary group-hover:text-brand transition-colors">
                {table.tableName}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-text-dim font-mono">
              <span>{table.fields.length} 字段</span>
              <span>{table.rowCount.toLocaleString()} 行</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
