import { useEffect, useRef } from "react";
import { Terminal, Sparkles } from "lucide-react";
import type { SlashCommand } from "./types";

interface CommandSuggestionProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

export default function CommandSuggestion({
  commands,
  selectedIndex,
  onSelect,
  onHover,
}: CommandSuggestionProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border-default bg-bg-canvas shadow-lg z-50"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          ref={i === selectedIndex ? selectedRef : null}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(i)}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
            i === selectedIndex
              ? "bg-brand/10 text-text-primary"
              : "text-text-secondary hover:bg-bg-surface"
          }`}
        >
          {cmd.category === "builtin" ? (
            <Terminal size={14} className="text-brand flex-shrink-0" />
          ) : (
            <Sparkles size={14} className="text-amber-400 flex-shrink-0" />
          )}
          <span className="font-medium">/{cmd.name}</span>
          <span className="text-text-muted text-xs truncate">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
