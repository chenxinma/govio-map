import { useCallback, useEffect, useRef, useState } from "react";
import { Code, FileDown, Loader2 } from "lucide-react";
import { useCanvasStore } from "../../store/canvas-store";

interface ExportNote {
  kind: "ok" | "error";
  text: string;
}

/** 导出结果提示的停留时间：够读完文件名与体积，又不长期占着画布右上角 */
const NOTE_TTL_MS = 8000;

export default function CanvasToolbar() {
  const createManualSQLNode = useCanvasStore((s) => s.createManualSQLNode);
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<ExportNote | null>(null);
  const noteTimer = useRef<number | null>(null);

  const showNote = useCallback((next: ExportNote) => {
    setNote(next);
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), NOTE_TTL_MS);
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );

  /**
   * 导出交付报告：单个自包含 HTML（内联 CSS/SVG，无外部依赖，双击离线可打开）。
   *
   * 实现放在独立模块 `src/utils/export-report.ts` 并用动态 import 加载：HTML 模板、
   * 内联样式表、Plotly 静态渲染都不进主 bundle，只有用户真的点导出才付出这份代价。
   * 导出只消费画布 store 已有的节点数据 + 一个只读审计通道，不做其他数据采集。
   */
  const handleExportReport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { nodes, edges } = useCanvasStore.getState();
      const { exportCanvasDeliveryReport } = await import("../../utils/export-report");
      const result = await exportCanvasDeliveryReport({ nodes, edges, appVersion: __APP_VERSION__ });
      const kb = Math.max(1, Math.round(result.bytes / 1024));
      showNote({
        kind: "ok",
        text: `已导出 ${result.fileName}（${kb} KB · ${result.nodeCount} 个节点 · 图表静态渲染 ${result.chartImageCount} 个）`,
      });
    } catch (err) {
      showNote({ kind: "error", text: `导出失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setExporting(false);
    }
  }, [exporting, showNote]);

  return (
    <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1 p-1 rounded-lg bg-bg-surface border border-border-default">
        <button
          onClick={createManualSQLNode}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors"
          title="创建 SQL 查询"
        >
          <Code size={14} />
          <span>SQL</span>
        </button>
        <button
          onClick={() => void handleExportReport()}
          disabled={exporting || nodeCount === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:border-transparent disabled:cursor-default"
          title={
            nodeCount === 0
              ? "画布为空，没有可导出的内容"
              : "导出交付报告：单个自包含 HTML（节点快照 + 血缘图 + Manifest 附录 + 权限确认记录），离线可打开"
          }
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
          <span>{exporting ? "导出中" : "导出交付报告"}</span>
        </button>
      </div>

      {note && (
        <div
          className={`max-w-[380px] px-2.5 py-1.5 rounded-md text-[11px] font-mono leading-relaxed break-all border bg-bg-card ${
            note.kind === "error" ? "border-error/40 text-error" : "border-border-default text-text-muted"
          }`}
        >
          {note.text}
        </div>
      )}
    </div>
  );
}
