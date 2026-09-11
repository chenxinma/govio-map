import { useRef, useEffect, useCallback, useState } from "react";
import { History, Trash2, Loader2 } from "lucide-react";
import { useChatContext } from "../../hooks/useChatContext";
import { useCanvasStore } from "../../store/canvas-store";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import PermissionCard from "./PermissionCard";

interface ChatPanelProps {
  width: number;
}

export default function ChatPanel({ width }: ChatPanelProps) {
  const { messages, isConnected, isStreaming, send, abort, clearMessages, clearSession, pendingPermission, respondPermission, acceptAllPermission, needsConfig, modelOptions, selectedModel, selectModel, hasMoreHistory, historyLoading, loadMoreHistory, sessions, fetchSessions, openSession, deleteSession } = useChatContext();
  const referencedNodes = useCanvasStore((s) => s.referencedNodes);
  const removeReference = useCanvasStore((s) => s.removeReference);
  const clearReferences = useCanvasStore((s) => s.clearReferences);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [showSessions, setShowSessions] = useState(false);

  const toggleSessions = useCallback(() => {
    setShowSessions((prev) => {
      if (!prev) fetchSessions();
      return !prev;
    });
  }, [fetchSessions]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledRef.current = !atBottom;
  }, []);

  const handleSend = useCallback(
    (content: string) => {
      send(content, referencedNodes.length > 0 ? referencedNodes : undefined);
      clearReferences();
    },
    [send, referencedNodes, clearReferences]
  );

  useEffect(() => {
    if (!userScrolledRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingPermission]);

  return (
    <div
      className="flex flex-col h-full bg-bg-canvas border-l border-border-subtle"
      style={{ width, minWidth: 280, maxWidth: 600 }}
    >
      {/* Header */}
      <div className="relative flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-sm font-medium text-text-primary">对话</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleSessions}
            className={`p-1 rounded hover:bg-bg-primary ${showSessions ? "text-brand" : "text-text-muted"}`}
            title="历史会话"
          >
            <History size={14} />
          </button>
          <div className={`w-2 h-2 rounded-full ${isConnected ? "bg-brand" : "bg-error"}`} />
          <span className="text-xs text-text-muted">{isConnected ? "已连接" : "未连接"}</span>
        </div>

        {/* Session history dropdown */}
        {showSessions && (
          <div className="absolute top-full right-2 mt-1 w-80 max-h-96 overflow-y-auto bg-bg-surface border border-border-default rounded-lg shadow-lg z-50">
            {sessions.length === 0 && (
              <p className="p-3 text-xs text-text-dim">暂无历史会话</p>
            )}
            {sessions.map((s) => (
              <div
                key={s.path}
                className="group flex items-start gap-2 px-3 py-2 border-b border-border-subtle last:border-b-0 hover:bg-bg-primary cursor-pointer"
                onClick={() => {
                  openSession(s.path);
                  setShowSessions(false);
                }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-text-primary truncate">
                    {s.name || s.preview || "(空会话)"}
                  </p>
                  <p className="text-[10px] text-text-dim mt-0.5">
                    {new Date(s.modified).toLocaleString()} · {s.messageCount} 条消息
                  </p>
                </div>
                <button
                  className="p-1 text-text-dim hover:text-error opacity-0 group-hover:opacity-100"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(s.path);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4"
      >
        {hasMoreHistory && (
          <div className="flex justify-center mb-3">
            <button
              onClick={loadMoreHistory}
              disabled={historyLoading}
              className="flex items-center gap-1 px-3 py-1 text-xs text-text-muted bg-bg-surface border border-border-default rounded-full hover:text-text-primary disabled:opacity-50"
            >
              {historyLoading && <Loader2 size={10} className="animate-spin" />}
              加载更早消息
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <p className="text-text-dim text-sm">输入消息开始对话</p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        {pendingPermission && (
          <PermissionCard
            pending={pendingPermission}
            onRespond={respondPermission}
            onAcceptAll={acceptAllPermission}
          />
        )}
      </div>

      {/* Model selector */}
      {modelOptions.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border-subtle flex-shrink-0">
          <span className="text-xs text-text-muted flex-shrink-0">模型</span>
          <select
            value={selectedModel?.key ?? ""}
            onChange={(e) => {
              const opt = modelOptions.find((o) => o.key === e.target.value);
              if (opt) selectModel(opt);
            }}
            className="flex-1 min-w-0 h-7 bg-bg-surface border border-border-default rounded-md px-1.5 text-xs text-text-secondary focus:outline-none focus:border-brand/50 truncate"
            title={selectedModel?.label}
          >
            {modelOptions.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        onAbort={abort}
        isStreaming={isStreaming}
        isConnected={isConnected}
        needsConfig={needsConfig}
        referencedNodes={referencedNodes}
        onRemoveReference={removeReference}
        clearMessages={clearMessages}
        clearSession={clearSession}
        clearCanvas={useCanvasStore.getState().clearCanvas}
        messages={messages}
        nodes={useCanvasStore.getState().nodes}
        edges={useCanvasStore.getState().edges}
      />
    </div>
  );
}
