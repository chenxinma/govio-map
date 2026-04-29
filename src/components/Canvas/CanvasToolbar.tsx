import { useState, useCallback } from "react";
import { Code, RefreshCw, Loader2 } from "lucide-react";
import { useCanvasStore } from "../../store/canvas-store";
import { useChatContext } from "../../hooks/useChatContext";

export default function CanvasToolbar() {
  const createManualSQLNode = useCanvasStore((s) => s.createManualSQLNode);
  const restoreCanvas = useCanvasStore((s) => s.restoreCanvas);
  const { observeList } = useChatContext();
  const [isRestoring, setIsRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    if (isRestoring) return;
    setIsRestoring(true);
    try {
      const dataframes = await observeList();
      restoreCanvas(dataframes as Array<{ dfName: string; [key: string]: unknown }>);
    } catch (err) {
      console.error("[toolbar] observeList failed:", err);
    } finally {
      setIsRestoring(false);
    }
  }, [isRestoring, observeList, restoreCanvas]);

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
      <button
        onClick={handleRestore}
        disabled={isRestoring}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors disabled:opacity-50"
        title="恢复画布"
      >
        {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        <span>恢复</span>
      </button>
    </div>
  );
}
