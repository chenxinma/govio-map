import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Wrench, Check, X, Loader2, Database, Code, Table2, FileText, BarChart3, CornerDownLeft } from "lucide-react";
import type { ChatMessage as ChatMessageType, ToolCall } from "../../hooks/useChat";
import type { ReferencedNode, NodeType } from "../../types";
import { MarkdownTable, MarkdownCode } from "./WideContent";

const NODE_ICONS: Record<NodeType, typeof Database> = {
  sourceTable: Database,
  sqlQuery: Code,
  dataFrame: Table2,
  report: FileText,
  chart: BarChart3,
};

const NODE_COLORS: Record<NodeType, string> = {
  sourceTable: "text-node-source",
  sqlQuery: "text-node-sql",
  dataFrame: "text-node-df",
  report: "text-node-report",
  chart: "text-node-chart",
};

function formatArgs(tool: ToolCall): string | null {
  const { args } = tool;
  if (args === undefined || args === null) return null;
  if (typeof args === "string") return args;
  // bash 展开可见具体命令；其它工具展示 args 的 JSON。
  if (tool.toolName === "bash" && typeof args.command === "string") return args.command;
  return JSON.stringify(args, null, 2);
}

function ToolRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const isSuccess = tool.success === true;
  const isFail = tool.success === false;
  const isRunning = tool.success === undefined;
  const full = formatArgs(tool);
  const lines = full ? full.split("\n") : [];
  // 非 bash 工具的 args JSON 截断 ≤20 行，避免展开区过高。
  const truncated = tool.toolName !== "bash" && lines.length > 20;
  const display = full === null ? null : truncated ? lines.slice(0, 20).join("\n") + "\n…" : full;

  return (
    <div className="rounded border border-border-subtle bg-[#f0f0f0]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={10} />
        <span className="font-mono">{tool.toolName}</span>
        {isRunning && <Loader2 size={10} className="animate-spin" />}
        {isSuccess && <Check size={10} className="text-brand" />}
        {isFail && <X size={10} className="text-error" />}
      </button>
      {open && (
        <div className="px-2 pb-2">
          {display !== null ? (
            <pre className="p-2 rounded bg-bg-primary text-xs font-mono text-text-secondary whitespace-pre-wrap break-words border border-border-subtle">
              {display}
            </pre>
          ) : (
            <span className="text-xs text-text-muted">无参数信息</span>
          )}
        </div>
      )}
    </div>
  );
}

function ToolRows({ tools }: { tools: ToolCall[] }) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 mb-2">
      {tools.map((tool, i) => (
        <ToolRow key={tool.toolCallId ?? `${tool.toolName}-${i}`} tool={tool} />
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
        <div className="mt-1 p-2 rounded bg-[#f0f0f0] text-xs text-text-muted whitespace-pre-wrap border border-border-subtle">
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
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-[#f0f0f0] border border-border-subtle"
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
        className={
          isUser
            ? "max-w-[90%] rounded-lg px-3 py-2 text-sm bg-bg-primary border-l-2 border-brand text-text-primary"
            : "w-full text-sm text-text-primary"
        }
      >
        {isUser ? (
          <>
            {message.referencedNodes && message.referencedNodes.length > 0 && (
              <ReferenceChips nodes={message.referencedNodes} />
            )}
            {message.isSteering && (
              <span className="inline-flex items-center gap-1 mb-1 px-1.5 py-0.5 rounded text-[10px] bg-brand/10 border border-brand/30 text-brand">
                <CornerDownLeft size={9} />
                <span>{message.isQueued ? "插队 · 等待送达" : "插队"}</span>
              </span>
            )}
            <p className="whitespace-pre-wrap">{message.content}</p>
          </>
        ) : (
          <>
            {message.thinking && <ThinkingSection content={message.thinking} />}
            {message.tools && message.tools.length > 0 && <ToolRows tools={message.tools} />}
            {message.content ? (
              <div className="chat-markdown prose prose-invert prose-sm max-w-none">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{ table: MarkdownTable, code: MarkdownCode }}
                >
                  {message.content}
                </Markdown>
              </div>
            ) : message.isStreaming && !message.thinking ? (
              <div className="flex items-center gap-2 text-text-muted text-xs">
                <Loader2 size={12} className="animate-spin" />
                <span>思考中...</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
