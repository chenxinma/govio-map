import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Wrench, Check, X, Loader2, Database, Code, Table2, FileText } from "lucide-react";
import type { ChatMessage as ChatMessageType, ToolCall } from "../../hooks/useChat";
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

function ToolPill({ tool }: { tool: ToolCall }) {
  const isSuccess = tool.success === true;
  const isFail = tool.success === false;
  const isRunning = tool.success === undefined;

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[#242424] border border-border-subtle text-text-secondary">
      <Wrench size={10} />
      <span>{tool.toolName}</span>
      {isRunning && <Loader2 size={10} className="animate-spin" />}
      {isSuccess && <Check size={10} className="text-brand" />}
      {isFail && <X size={10} className="text-red-400" />}
    </span>
  );
}

function ToolPills({ tools }: { tools: ToolCall[] }) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {tools.map((tool, i) => (
        <ToolPill key={`${tool.toolName}-${i}`} tool={tool} />
      ))}
    </div>
  );
}

function ThinkingSection({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>Thinking</span>
      </button>
      {open && (
        <div className="mt-1 p-2 rounded bg-[#242424] text-xs text-text-muted whitespace-pre-wrap border border-border-subtle">
          {content}
        </div>
      )}
    </div>
  );
}

function ReferenceChips({ nodes }: { nodes: ReferencedNode[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {nodes.map((ref) => {
        const Icon = NODE_ICONS[ref.type] || Database;
        return (
          <span
            key={ref.nodeId}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[#242424] border border-border-subtle"
          >
            <Icon size={10} className={NODE_COLORS[ref.type] || "text-text-muted"} />
            <span className="text-text-secondary">{ref.label}</span>
          </span>
        );
      })}
    </div>
  );
}

export default function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-bg-primary border-l-2 border-brand text-text-primary"
            : "bg-bg-primary border border-border-default text-text-primary"
        }`}
      >
        {isUser ? (
          <>
            {message.referencedNodes && message.referencedNodes.length > 0 && (
              <ReferenceChips nodes={message.referencedNodes} />
            )}
            <p className="whitespace-pre-wrap">{message.content}</p>
          </>
        ) : (
          <>
            {message.thinking && <ThinkingSection content={message.thinking} />}
            {message.tools && message.tools.length > 0 && <ToolPills tools={message.tools} />}
            {message.content && (
              <div className="chat-markdown prose prose-invert prose-sm max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
              </div>
            )}
            {message.isStreaming && !message.content && !message.thinking && (
              <div className="flex items-center gap-2 text-text-muted text-xs">
                <Loader2 size={12} className="animate-spin" />
                <span>思考中...</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
