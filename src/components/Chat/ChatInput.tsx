import { useState, useCallback, useRef, useEffect } from "react";
import { Send, Square, Database, Code, Table2, FileText, X } from "lucide-react";
import type { ReferencedNode, NodeType } from "../../types";

const NODE_ICONS: Record<NodeType, typeof Database> = {
  sourceTable: Database,
  sqlQuery: Code,
  dataFrame: Table2,
  report: FileText,
};

const NODE_COLORS: Record<NodeType, string> = {
  sourceTable: "text-node-source",
  sqlQuery: "text-node-sql",
  dataFrame: "text-node-df",
  report: "text-node-report",
};

interface ChatInputProps {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  isConnected: boolean;
  referencedNodes?: ReferencedNode[];
  onRemoveReference?: (nodeId: string) => void;
}

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  isConnected,
  referencedNodes = [],
  onRemoveReference,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || !isConnected) return;
    onSend(trimmed);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, isConnected, onSend]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [value]);

  return (
    <div className="flex flex-col gap-2 p-3 border-t border-border-subtle">
      {/* Reference chips */}
      {referencedNodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {referencedNodes.map((ref) => {
            const Icon = NODE_ICONS[ref.type] || Database;
            return (
              <span
                key={ref.nodeId}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-bg-surface border border-border-default"
              >
                <Icon size={12} className={NODE_COLORS[ref.type] || "text-text-muted"} />
                <span className="text-text-primary">{ref.label}</span>
                {onRemoveReference && (
                  <button
                    onClick={() => onRemoveReference(ref.nodeId)}
                    className="ml-0.5 text-text-dim hover:text-text-primary transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isConnected ? "输入消息... (Enter 发送, Shift+Enter 换行)" : "未连接到服务器..."}
          disabled={!isConnected}
          rows={1}
          className="flex-1 resize-none bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50 disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={onAbort}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition-colors"
            title="停止"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || !isConnected}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-brand/20 border border-brand/40 text-brand hover:bg-brand/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="发送"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
