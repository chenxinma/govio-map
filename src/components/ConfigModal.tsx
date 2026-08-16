import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, KeyRound } from "lucide-react";

interface ConfigModalProps {
  onSave: (apiKey: string) => void;
  onCancel: () => void;
}

export default function ConfigModal({ onSave, onCancel }: ConfigModalProps) {
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (trimmed) {
      onSave(trimmed);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[460px] max-w-[90vw] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-brand" />
            <span className="text-sm font-medium text-text-primary">配置 DeepSeek API Key</span>
          </div>
          <button
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
          <p className="text-sm text-text-secondary">
            Govio Map 默认使用 DeepSeek 作为 LLM 服务提供商。请在下方输入您的 DeepSeek API Key 以继续。
          </p>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="api-key" className="text-xs font-medium text-text-secondary">
              DeepSeek API Key
            </label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              autoFocus
              className="w-full h-10 bg-bg-primary border border-border-default rounded-lg px-3 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!apiKey.trim()}
              className="px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              保存并启动
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
