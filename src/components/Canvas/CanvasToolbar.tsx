import { Code } from "lucide-react";
import { useCanvasStore } from "../../store/canvas-store";

export default function CanvasToolbar() {
  const createManualSQLNode = useCanvasStore((s) => s.createManualSQLNode);

  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1 p-1 rounded-lg bg-bg-surface border border-border-default">
      <button
        onClick={createManualSQLNode}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors"
        title="创建 SQL 查询"
      >
        <Code size={14} />
        <span>SQL</span>
      </button>
    </div>
  );
}
