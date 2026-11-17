import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ModelOption } from "../../hooks/useChat";

/**
 * 可搜索的模型下拉（模型多时原生 select 难用）：弹层内过滤输入 + 按 provider 分组，
 * 点选即关闭。弹层向上弹出（位于面板底部输入框上方）。
 */
export default function ModelSelect({
  options,
  value,
  onChange,
}: {
  options: ModelOption[];
  value: ModelOption | null;
  onChange: (opt: ModelOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const groups = new Map<string, ModelOption[]>();
  for (const o of filtered) {
    const list = groups.get(o.provider);
    if (list) list.push(o);
    else groups.set(o.provider, [o]);
  }

  return (
    <div ref={rootRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-7 flex items-center gap-1 bg-bg-surface border border-border-default rounded-md px-1.5 text-xs text-text-secondary hover:border-border-prominent focus:outline-none focus:border-brand/50"
        title={value?.label}
      >
        <span className="flex-1 min-w-0 truncate text-left">{value?.label ?? "选择模型"}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-text-muted" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-30 bg-bg-primary border border-border-default rounded-md shadow-lg overflow-hidden">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border-subtle">
            <Search size={12} className="flex-shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型"
              className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-dim focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && <div className="px-2 py-1.5 text-xs text-text-muted">无匹配模型</div>}
            {[...groups.entries()].map(([provider, items]) => (
              <div key={provider}>
                <div className="px-2 py-1 text-[10px] uppercase text-text-dim">{provider}</div>
                {items.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => {
                      onChange(o);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`w-full text-left px-2 py-1.5 text-xs truncate ${
                      o.key === value?.key
                        ? "bg-brand/10 text-brand"
                        : "text-text-secondary hover:bg-bg-surface"
                    }`}
                    title={o.label}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
