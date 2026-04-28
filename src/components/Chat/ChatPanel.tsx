import { useRef, useEffect, useCallback } from "react";
import { useChat } from "../../hooks/useChat";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";

interface ChatPanelProps {
  width: number;
}

export default function ChatPanel({ width }: ChatPanelProps) {
  const { messages, isConnected, isStreaming, send, abort } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    userScrolledRef.current = !atBottom;
  }, []);

  useEffect(() => {
    if (!userScrolledRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      className="flex flex-col h-full bg-bg-canvas border-l border-border-subtle"
      style={{ width, minWidth: 280, maxWidth: 600 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <span className="text-sm font-medium text-text-primary">对话</span>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isConnected ? "bg-brand" : "bg-red-400"}`} />
          <span className="text-xs text-text-muted">{isConnected ? "已连接" : "未连接"}</span>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4"
      >
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <p className="text-text-dim text-sm">输入消息开始对话</p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
      </div>

      {/* Input */}
      <ChatInput onSend={send} onAbort={abort} isStreaming={isStreaming} isConnected={isConnected} />
    </div>
  );
}
