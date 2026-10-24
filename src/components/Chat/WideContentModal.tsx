import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type WideContentKind = "table" | "code";

interface Props {
  kind: WideContentKind;
  /** table: markdown source; code: raw code text */
  content: string;
  /** code language label (e.g. "sql") */
  language?: string;
  onClose: () => void;
}

const TITLES: Record<WideContentKind, string> = {
  table: "表格全屏查看",
  code: "代码全屏查看",
};

/**
 * 宽内容（markdown 表格 / 代码块）全屏查看器。
 * 全屏舒展渲染：表格不压缩折行，超宽时容器内横向滚动；支持一键复制。
 */
export default function WideContentModal({ kind, content, language, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); ignore.
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[min(90vw,1200px)] max-w-[95vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{TITLES[kind]}</span>
            {kind === "code" && language && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-bg-surface text-text-dim border border-border-subtle">
                {language}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary hover:bg-bg-surface rounded transition-colors"
              title="复制内容"
            >
              {copied ? <Check size={12} className="text-brand" /> : <Copy size={12} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
              title="关闭 (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-auto p-4">
          {kind === "table" ? (
            <div className="chat-markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // 全屏下表格舒展：不压缩、不折行，超宽横向滚动
                  table: (props) => (
                    <table
                      {...props}
                      style={{ width: "max-content", minWidth: "100%" }}
                    />
                  ),
                }}
              >
                {content}
              </Markdown>
            </div>
          ) : (
            <pre className="whitespace-pre text-sm font-mono text-text-primary">
              <code>{content}</code>
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
