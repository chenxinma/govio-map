import { useState, useRef, useEffect } from 'react';
import { Send, X, ChevronDown, ChevronUp, MessageCircle, ChevronRight, Loader } from 'lucide-react';
import { Zap, Database, FileCode } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useCanvasStore } from '../../store/canvas-store';
import type { ChatMessage, NodePreview } from '../../types';

function NodePreviewBadge({ preview, onRemove }: { preview: NodePreview; onRemove?: () => void }) {
  const icon = preview.type === 'sqlQuery'
    ? <Zap size={12} className="text-node-sql" />
    : preview.type === 'dataFrame'
    ? <FileCode size={12} className="text-node-df" />
    : <Database size={12} className="text-node-source" />;

  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-brand/10 border border-brand-border text-xs text-brand font-mono">
      {icon}
      <span>{preview.label}</span>
      {onRemove && (
        <button onClick={onRemove} className="ml-0.5 text-text-muted hover:text-text-primary">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div className={`max-w-[85%] ${isUser ? '' : ''}`}>
        {!isUser && (
          <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-brand mb-1">
            AI Assistant
          </div>
        )}
        <div
          className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
            isUser
              ? 'bg-brand/10 text-text-primary border border-brand-border'
              : 'bg-bg-surface text-text-secondary border border-border-subtle'
          }`}
        >
          {isUser ? (
            message.content
          ) : (
            <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
          )}
        </div>
        {message.nodePreviews && message.nodePreviews.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.nodePreviews.map((preview) => (
              <NodePreviewBadge key={preview.id} preview={preview} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel() {
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const messages = useCanvasStore((s) => s.messages);
  const referencedNodes = useCanvasStore((s) => s.referencedNodes);
  const sendMessage = useCanvasStore((s) => s.sendMessage);
  const removeReference = useCanvasStore((s) => s.removeReference);
  const isStreaming = useCanvasStore((s) => s.isStreaming);
  const streamingContent = useCanvasStore((s) => s.streamingContent);
  const streamingThinking = useCanvasStore((s) => s.streamingThinking);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShowThinking(true);
  }, [isStreaming]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!input.trim() && referencedNodes.length === 0) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (collapsed) {
    return (
      <div className="h-12 bg-bg-primary border-t border-border-default flex items-center px-4">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors"
        >
          <MessageCircle size={16} />
          <span>AI Assistant</span>
          <ChevronUp size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="h-[320px] bg-bg-primary border-t border-border-default flex flex-col">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageCircle size={14} className="text-brand" />
          <span className="text-xs font-mono uppercase tracking-[1.2px] text-text-muted">
            AI Assistant
          </span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-text-dim">
              输入自然语言指令开始探索数据...
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}
        {isStreaming && (
          <div className="flex justify-start mb-3">
            <div className="max-w-[85%]">
              <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-brand mb-1">
                AI Assistant
              </div>
              {streamingThinking && showThinking && !streamingContent && (
                <div className="mb-2">
                  <button
                    onClick={() => setShowThinking(false)}
                    className="flex items-center gap-1 text-xs text-text-dim hover:text-text-muted mb-1"
                  >
                    <ChevronRight size={12} className={showThinking ? "rotate-90" : ""} />
                    <Loader size={10} className="animate-spin" />
                    Thinking
                  </button>
                  <div className="rounded-lg px-3 py-2 text-xs leading-relaxed bg-bg-surface/50 text-text-dim border border-border-subtle font-mono">
                    {streamingThinking}
                  </div>
                </div>
              )}
              <div className="rounded-lg px-3 py-2 text-sm leading-relaxed bg-bg-surface text-text-secondary border border-border-subtle">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {streamingContent || "思考中..."}
                </Markdown>
                {streamingContent && <span className="inline-block w-1.5 h-4 ml-0.5 bg-brand/60 animate-pulse" />}
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="px-4 py-3 border-t border-border-subtle">
        {referencedNodes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {referencedNodes.map((ref) => (
              <NodePreviewBadge
                key={ref.nodeId}
                preview={{ id: ref.nodeId, type: ref.type, label: ref.label }}
                onRemove={() => removeReference(ref.nodeId)}
              />
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入指令，如：统计客户账单金额..."
            className="flex-1 bg-bg-input border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand-border transition-colors"
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && referencedNodes.length === 0) || isStreaming}
            className="px-3 py-2 rounded-lg bg-brand/10 border border-brand-border text-brand hover:bg-brand/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
