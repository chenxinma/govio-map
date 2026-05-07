# Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/command` suggestion system to the chat input with built-in commands (clear, clear-canvas, export) and custom commands loaded from a JSON config file.

**Architecture:** A `src/commands/` module contains the command registry, built-in handlers, a `useCommands` hook, and a `CommandSuggestion` dropdown component. ChatInput integrates the hook and renders the dropdown when the user types `/`. Built-in commands execute locally; custom commands fill the textarea with a prompt for the user to edit and send.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind CSS, lucide-react

---

### Task 1: Create command types

**Files:**
- Create: `src/commands/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
export interface SlashCommand {
  name: string;
  description: string;
  category: "builtin" | "custom";
  handler?: (ctx: CommandContext) => void;
  prompt?: string;
}

export interface CommandContext {
  clearMessages: () => void;
  clearCanvas: () => void;
  exportSession: () => void;
  addSystemMessage: (content: string) => void;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 2: Create custom commands JSON config

**Files:**
- Create: `src/data/commands.json`

- [ ] **Step 1: Create the config file**

```json
[
  { "name": "sql", "description": "生成SELECT SQL语句", "prompt": "请生成一个SELECT SQL语句" },
  { "name": "analyze", "description": "分析数据质量", "prompt": "请分析当前数据的质量" }
]
```

---

### Task 3: Add clearMessages to useChat hook

**Files:**
- Modify: `src/hooks/useChat.ts`

- [ ] **Step 1: Add clearMessages to the return value**

In `src/hooks/useChat.ts`, add a `clearMessages` function after the `abort` function (around line 281):

```typescript
const clearMessages = useCallback(() => {
  setMessages([]);
  msgIdCounter = 0;
}, []);
```

Then update the return statement (line 306) to include it:

```typescript
return { messages, isConnected, isStreaming, send, abort, observeList, isObserving, clearMessages };
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 4: Add clearCanvas to canvas store

**Files:**
- Modify: `src/store/canvas-store.ts`

- [ ] **Step 1: Add clearCanvas method to the store interface**

In `src/store/canvas-store.ts`, add to the `CanvasStore` interface (after `deleteNodes` around line 44):

```typescript
clearCanvas: () => void;
```

- [ ] **Step 2: Implement clearCanvas**

Add the implementation after `deleteNodes` (around line 346):

```typescript
clearCanvas: () => {
  set({
    nodes: [],
    edges: [],
    previewPanels: [],
    referencedNodes: [],
  });
},
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

---

### Task 5: Create built-in command handlers

**Files:**
- Create: `src/commands/built-in.ts`

- [ ] **Step 1: Create the built-in commands file**

```typescript
import type { SlashCommand, CommandContext } from "./types";

function handleClear(ctx: CommandContext) {
  ctx.clearMessages();
  ctx.addSystemMessage("已清理会话上下文");
}

function handleClearCanvas(ctx: CommandContext) {
  ctx.clearCanvas();
  ctx.clearMessages();
  ctx.addSystemMessage("已清理画布并释放所有数据");
}

function handleExport(ctx: CommandContext) {
  ctx.exportSession();
}

export function getBuiltInCommands(): SlashCommand[] {
  return [
    {
      name: "clear",
      description: "清理当前会话上下文",
      category: "builtin",
      handler: handleClear,
    },
    {
      name: "clear-canvas",
      description: "清理画布并释放所有dataframe",
      category: "builtin",
      handler: handleClearCanvas,
    },
    {
      name: "export",
      description: "导出会话保存成json",
      category: "builtin",
      handler: handleExport,
    },
  ];
}
```

---

### Task 6: Create command registry

**Files:**
- Create: `src/commands/registry.ts`

- [ ] **Step 1: Create the registry**

```typescript
import type { SlashCommand } from "./types";
import { getBuiltInCommands } from "./built-in";
import customCommandsData from "../data/commands.json";

interface CustomCommandInput {
  name: string;
  description: string;
  prompt: string;
}

export function loadCommands(): SlashCommand[] {
  const builtIn = getBuiltInCommands();
  const custom: SlashCommand[] = (customCommandsData as CustomCommandInput[]).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    category: "custom" as const,
    prompt: cmd.prompt,
  }));
  return [...builtIn, ...custom];
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase().replace(/^\//, "");
  if (!q) return commands;
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q)
  );
}
```

---

### Task 7: Create useCommands hook

**Files:**
- Create: `src/commands/useCommands.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useMemo, useCallback } from "react";
import { loadCommands } from "./registry";
import type { SlashCommand, CommandContext } from "./types";

export function useCommands(ctx: CommandContext) {
  const commands = useMemo(() => loadCommands(), []);

  const execute = useCallback(
    (command: SlashCommand) => {
      if (command.category === "builtin" && command.handler) {
        command.handler(ctx);
      }
    },
    [ctx]
  );

  return { commands, execute };
}
```

---

### Task 8: Create CommandSuggestion component

**Files:**
- Create: `src/commands/CommandSuggestion.tsx`

- [ ] **Step 1: Create the dropdown component**

```tsx
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
```

---

### Task 9: Create exportSession utility

**Files:**
- Create: `src/commands/export-session.ts`

- [ ] **Step 1: Create the export utility**

```typescript
import type { ChatMessage } from "../hooks/useChat";
import type { Node, Edge } from "@xyflow/react";

export function exportSession(messages: ChatMessage[], nodes: Node[], edges: Edge[]) {
  const data = {
    exportedAt: new Date().toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      referencedNodes: m.referencedNodes,
    })),
    canvas: {
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `govio-session-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
```

---

### Task 10: Integrate into ChatInput

**Files:**
- Modify: `src/components/Chat/ChatInput.tsx`
- Modify: `src/components/Chat/ChatPanel.tsx`

- [ ] **Step 1: Update ChatPanel to pass required props**

In `src/components/Chat/ChatPanel.tsx`, import the new dependencies and pass them to ChatInput.

Add imports at the top:

```typescript
import { useCanvasStore } from "../../store/canvas-store";
import { exportSession } from "../../commands/export-session";
```

Update the `handleSend` function area to add command context props. Replace the ChatInput usage (around line 71):

```tsx
<ChatInput
  onSend={handleSend}
  onAbort={abort}
  isStreaming={isStreaming}
  isConnected={isConnected}
  referencedNodes={referencedNodes}
  onRemoveReference={removeReference}
  clearMessages={clearMessages}
  clearCanvas={useCanvasStore.getState().clearCanvas}
  messages={messages}
  nodes={useCanvasStore.getState().nodes}
  edges={useCanvasStore.getState().edges}
/>
```

Also destructure `clearMessages` from `useChatContext()` at the top of ChatPanel (line 12):

```typescript
const { messages, isConnected, isStreaming, send, abort, clearMessages } = useChatContext();
```

- [ ] **Step 2: Update ChatInput to support slash commands**

Replace the full content of `src/components/Chat/ChatInput.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Send, Square, Database, Code, Table2, FileText, X } from "lucide-react";
import type { ReferencedNode, NodeType } from "../../types";
import type { ChatMessage } from "../../hooks/useChat";
import type { Node, Edge } from "@xyflow/react";
import { useCommands } from "../../commands/useCommands";
import { filterCommands } from "../../commands/registry";
import { exportSession } from "../../commands/export-session";
import CommandSuggestion from "../../commands/CommandSuggestion";
import type { SlashCommand, CommandContext } from "../../commands/types";

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
  clearMessages?: () => void;
  clearCanvas?: () => void;
  messages?: ChatMessage[];
  nodes?: Node[];
  edges?: Edge[];
}

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  isConnected,
  referencedNodes = [],
  onRemoveReference,
  clearMessages = () => {},
  clearCanvas = () => {},
  messages = [],
  nodes = [],
  edges = [],
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addSystemMessage = useCallback((_content: string) => {
    // System messages are visual-only; the store handles display
  }, []);

  const ctx: CommandContext = useMemo(
    () => ({
      clearMessages,
      clearCanvas,
      exportSession: () => exportSession(messages, nodes, edges),
      addSystemMessage,
    }),
    [clearMessages, clearCanvas, messages, nodes, edges, addSystemMessage]
  );

  const { commands, execute } = useCommands(ctx);

  const filteredCommands = useMemo(() => {
    if (!value.startsWith("/")) return [];
    return filterCommands(commands, value);
  }, [value, commands]);

  useEffect(() => {
    setShowSuggestions(value.startsWith("/") && filteredCommands.length > 0);
    setSelectedIndex(0);
  }, [value, filteredCommands.length]);

  const handleSelect = useCallback(
    (command: SlashCommand) => {
      if (command.category === "builtin") {
        execute(command);
        setValue("");
      } else if (command.prompt) {
        setValue(command.prompt);
      }
      setShowSuggestions(false);
      textareaRef.current?.focus();
    },
    [execute]
  );

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
      if (showSuggestions) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSelect(filteredCommands[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSuggestions(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showSuggestions, filteredCommands, selectedIndex, handleSelect, handleSend]
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

      {/* Input row with suggestion dropdown */}
      <div className="relative flex gap-2">
        <CommandSuggestion
          commands={filteredCommands}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          onHover={setSelectedIndex}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Delay closing so click events on suggestions can fire
            setTimeout(() => setShowSuggestions(false), 150);
          }}
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
```

- [ ] **Step 3: Verify TypeScript compiles**

Note: `useChatContext.ts` uses `ReturnType<typeof useChat>`, so adding `clearMessages` to useChat's return (Task 3) automatically exposes it through context. No changes needed to that file.

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Verify dev server starts**

Run: `npm run dev`
Expected: Dev server starts without errors

- [ ] **Step 5: Manual test**

1. Open the app in browser
2. Type `/` in the chat input — dropdown should appear with all commands
3. Type `/cl` — should filter to `/clear` and `/clear-canvas`
4. Arrow down to select, Enter to execute `/clear`
5. Type `/sql` — should show `/sql` with description
6. Enter to select — textarea should fill with "请生成一个SELECT SQL语句"
7. Press Escape to close dropdown
8. Test `/export` — JSON file should download

- [ ] **Step 6: Commit**

```bash
git add src/commands/ src/data/commands.json src/components/Chat/ChatInput.tsx src/components/Chat/ChatPanel.tsx src/hooks/useChat.ts src/store/canvas-store.ts
git commit -m "feat: add slash command suggestions to chat input"
```
