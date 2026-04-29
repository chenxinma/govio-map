# TODO Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three features from TODO.json: Card Reference (attach nodes to chat messages), Restore Canvas (sync with backend dataframes), and Manual SQL Query (create editable SQL cards).

**Architecture:** Extend the Zustand canvas store with reference state and new node actions. Add a floating canvas toolbar for SQL/Restore buttons. Wire references through the chat input → useChat → WebSocket pipeline. Server handles `observe_list` via child process.

**Tech Stack:** React 18, TypeScript, Zustand, @xyflow/react, lucide-react, WebSocket (ws), Tailwind CSS v4

---

### Task 1: Store — Add reference state and actions

**Files:**
- Modify: `src/store/canvas-store.ts:18-35` (interface) and `src/store/canvas-store.ts:37-209` (implementation)

- [ ] **Step 1: Add `referencedNodes` and reference actions to the store interface**

In `src/store/canvas-store.ts`, add to the `CanvasStore` interface (after line 34):

```ts
  referencedNodes: ReferencedNode[];
  addReference: (nodeId: string) => void;
  removeReference: (nodeId: string) => void;
  clearReferences: () => void;
```

Add import at top of file:

```ts
import type { CanvasNodeData, DataFrameNodeData, ReferencedNode } from '../types';
```

- [ ] **Step 2: Implement reference state and actions in the store**

In the `create` call, add to state (after `previewPanels: []`):

```ts
  referencedNodes: [],
```

Add actions (after `movePreviewPanel`):

```ts
  addReference: (nodeId) => {
    const { nodes, referencedNodes } = get();
    if (referencedNodes.some((r) => r.nodeId === nodeId)) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data as unknown as CanvasNodeData;
    set({
      referencedNodes: [
        ...referencedNodes,
        { nodeId, label: data.title, type: data.type },
      ],
    });
  },

  removeReference: (nodeId) => {
    set({ referencedNodes: get().referencedNodes.filter((r) => r.nodeId !== nodeId) });
  },

  clearReferences: () => {
    set({ referencedNodes: [] });
  },
```

- [ ] **Step 3: Commit**

```bash
rtk git add src/store/canvas-store.ts
rtk git commit -m "feat(store): add referencedNodes state and addReference/removeReference/clearReferences actions"
```

---

### Task 2: Store — Add `updateNodeData`, `createManualSQLNode`, and `restoreCanvas`

**Files:**
- Modify: `src/store/canvas-store.ts` (interface + implementation)

- [ ] **Step 1: Add `updateNodeData` to the store**

Add to `CanvasStore` interface:

```ts
  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
```

Implement:

```ts
  updateNodeData: (nodeId, data) => {
    set({
      nodes: get().nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n
      ),
    });
  },
```

- [ ] **Step 2: Add `createManualSQLNode` to the store**

Add to `CanvasStore` interface:

```ts
  createManualSQLNode: () => void;
```

Implement:

```ts
  createManualSQLNode: () => {
    const { nodes, edges } = get();
    const nodeId = nextId('sql');
    const newNode: Node = {
      id: nodeId,
      type: 'sqlQuery',
      position: { x: 0, y: 0 },
      data: {
        type: 'sqlQuery',
        title: 'New Query',
        createdAt: new Date().toISOString(),
        sql: '',
        outputColumns: [],
      },
    };
    const allNodes = [...nodes, newNode];
    try {
      const { nodes: layoutedNodes } = getLayoutedElements(allNodes, edges);
      set({ nodes: layoutedNodes });
    } catch {
      newNode.position = { x: 100 + nodes.length * 60, y: 100 + nodes.length * 40 };
      set({ nodes: allNodes });
    }
  },
```

- [ ] **Step 3: Add `restoreCanvas` to the store**

Add to `CanvasStore` interface:

```ts
  restoreCanvas: (dataframes: Array<{ dfName: string; [key: string]: unknown }>) => void;
```

Implement:

```ts
  restoreCanvas: (dataframes) => {
    const { nodes } = get();
    const existingDfNames = new Set(
      nodes
        .filter((n) => (n.data as unknown as CanvasNodeData).type === 'dataFrame')
        .map((n) => (n.data as unknown as { dfName: string }).dfName)
    );

    const missing = dataframes.filter((df) => !existingDfNames.has(df.dfName));
    if (missing.length === 0) return;

    for (const df of missing) {
      get().createGovioNode({
        type: 'govio_node_create',
        nodeType: 'dataFrame',
        title: `DF: ${df.dfName}`,
        dfName: df.dfName,
        sourceName: (df.sourceName as string) || '',
        totalRows: (df.totalRows as number) || 0,
        totalColumns: (df.totalColumns as number) || 0,
        memoryUsage: (df.memoryUsage as string) || '0 B',
        columns: (df.columns as Array<{ name: string; nonNull: number; dtype: string }>) || [],
      });
    }
  },
```

- [ ] **Step 4: Commit**

```bash
rtk git add src/store/canvas-store.ts
rtk git commit -m "feat(store): add updateNodeData, createManualSQLNode, restoreCanvas actions"
```

---

### Task 3: ChatInput — Add reference chips UI

**Files:**
- Modify: `src/components/Chat/ChatInput.tsx`

- [ ] **Step 1: Add reference-related props and chip rendering**

Replace the entire file with:

```tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { Send, Square, Database, Code, Table2, FileText, X } from "lucide-react";
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

interface ChatInputProps {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  isConnected: boolean;
  referencedNodes?: ReferencedNode[];
  onRemoveReference?: (nodeId: string) => void;
}

export default function ChatInput({
  onSend,
  onAbort,
  isStreaming,
  isConnected,
  referencedNodes = [],
  onRemoveReference,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
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

      {/* Input row */}
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
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

- [ ] **Step 2: Commit**

```bash
rtk git add src/components/Chat/ChatInput.tsx
rtk git commit -m "feat(chat): add reference chips UI to ChatInput"
```

---

### Task 4: useChat — Send references with messages

**Files:**
- Modify: `src/hooks/useChat.ts`

- [ ] **Step 1: Update `send()` to accept and include `referencedNodes`**

Change the `send` callback signature and body. Replace lines 205-221 with:

```ts
  const send = useCallback((content: string, referencedNodes?: Array<{ nodeId: string; label: string; type: string }>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMsg]);

    const payload: Record<string, unknown> = { content };
    if (referencedNodes && referencedNodes.length > 0) {
      payload.referencedNodes = referencedNodes;
    }

    if (isStreaming) {
      ws.send(JSON.stringify({ type: "steer", ...payload }));
    } else {
      ws.send(JSON.stringify({ type: "prompt", ...payload }));
    }
  }, [isStreaming]);
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/hooks/useChat.ts
rtk git commit -m "feat(chat): add referencedNodes to send()"
```

---

### Task 5: Store — Add `observeList` with one-shot WS connection

**Files:**
- Modify: `src/store/canvas-store.ts`

The store needs its own `observeList()` for the Restore Canvas feature. It opens a one-shot WebSocket connection, sends `observe_list`, waits for `observe_list_result`, calls `restoreCanvas`, then closes. This keeps the logic self-contained in the store without coupling to `useChat`.

- [ ] **Step 1: Add `observeList` to the store interface and implement**

Add to `CanvasStore` interface:

```ts
  observeList: () => Promise<void>;
```

Implement:

```ts
  observeList: async () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = parseInt(window.location.port) + 1;
    const ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("observe_list timeout"));
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "observe_list" }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "observe_list_result") {
            clearTimeout(timeout);
            ws.close();
            get().restoreCanvas(data.dataframes || []);
            resolve();
          } else if (data.type === "error") {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(data.message));
          }
        } catch {
          // ignore non-JSON messages (session_ready, etc.)
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("WebSocket error"));
      };
    });
  },
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/store/canvas-store.ts
rtk git commit -m "feat(store): add observeList() with one-shot WS for canvas restore"
```

---

### Task 6: ChatPanel — Wire references from store

**Files:**
- Modify: `src/components/Chat/ChatPanel.tsx`

- [ ] **Step 1: Import store and pass references to ChatInput**

Replace the file with:

```tsx
import { useRef, useEffect, useCallback } from "react";
import { useChat } from "../../hooks/useChat";
import { useCanvasStore } from "../../store/canvas-store";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";

interface ChatPanelProps {
  width: number;
}

export default function ChatPanel({ width }: ChatPanelProps) {
  const { messages, isConnected, isStreaming, send, abort } = useChat();
  const referencedNodes = useCanvasStore((s) => s.referencedNodes);
  const removeReference = useCanvasStore((s) => s.removeReference);
  const clearReferences = useCanvasStore((s) => s.clearReferences);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

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
      <ChatInput
        onSend={handleSend}
        onAbort={abort}
        isStreaming={isStreaming}
        isConnected={isConnected}
        referencedNodes={referencedNodes}
        onRemoveReference={removeReference}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/components/Chat/ChatPanel.tsx
rtk git commit -m "feat(chat): wire referencedNodes from store to ChatInput, clear on send"
```

---

### Task 7: CanvasToolbar — New component

**Files:**
- Create: `src/components/Canvas/CanvasToolbar.tsx`

- [ ] **Step 1: Create the CanvasToolbar component**

Create `src/components/Canvas/CanvasToolbar.tsx`:

```tsx
import { useState, useCallback } from "react";
import { Code, RefreshCw, Loader2 } from "lucide-react";
import { useCanvasStore } from "../../store/canvas-store";

export default function CanvasToolbar() {
  const createManualSQLNode = useCanvasStore((s) => s.createManualSQLNode);
  const observeList = useCanvasStore((s) => s.observeList);
  const [isRestoring, setIsRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    if (isRestoring) return;
    setIsRestoring(true);
    try {
      await observeList();
    } catch (err) {
      console.error("[toolbar] observeList failed:", err);
    } finally {
      setIsRestoring(false);
    }
  }, [isRestoring, observeList]);

  return (
    <div className="absolute top-3 right-3 z-10 flex items-center gap-1 p-1 rounded-lg bg-bg-surface border border-border-default">
      <button
        onClick={createManualSQLNode}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors"
        title="创建 SQL 查询"
      >
        <Code size={14} />
        <span>SQL</span>
      </button>
      <button
        onClick={handleRestore}
        disabled={isRestoring}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-text-primary hover:bg-bg-primary border border-transparent hover:border-border-default transition-colors disabled:opacity-50"
        title="恢复画布"
      >
        {isRestoring ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        <span>恢复</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/components/Canvas/CanvasToolbar.tsx
rtk git commit -m "feat(canvas): add CanvasToolbar with SQL and Restore buttons"
```

---

### Task 8: Canvas — Integrate toolbar

**Files:**
- Modify: `src/components/Canvas/Canvas.tsx`

- [ ] **Step 1: Import and render CanvasToolbar**

Add import after existing imports:

```ts
import CanvasToolbar from './CanvasToolbar';
```

Add `<CanvasToolbar />` inside the wrapper div, before `<ReactFlow>`:

```tsx
    <div ref={reactFlowWrapper} className="relative w-full h-full">
      <CanvasToolbar />
      <ReactFlow
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/components/Canvas/Canvas.tsx
rtk git commit -m "feat(canvas): integrate CanvasToolbar into Canvas"
```

---

### Task 9: SQLQueryNode — Inline SQL editing

**Files:**
- Modify: `src/components/Nodes/SQLQueryNode.tsx`

- [ ] **Step 1: Add editable SQL textarea**

Replace the entire file with:

```tsx
import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Quote } from 'lucide-react';
import type { SQLQueryNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';

function SQLNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as SQLQueryNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const [isEditing, setIsEditing] = useState(nodeData.sql === '');
  const [editValue, setEditValue] = useState(nodeData.sql);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [isEditing, editValue]);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim();
    updateNodeData(id, { sql: trimmed });
    setIsEditing(false);
  }, [id, editValue, updateNodeData]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        setEditValue(nodeData.sql);
        setIsEditing(false);
      }
    },
    [handleSave, nodeData.sql]
  );

  const handleDoubleClick = useCallback(() => {
    setEditValue(nodeData.sql);
    setIsEditing(true);
  }, [nodeData.sql]);

  const sqlLines = nodeData.sql.split('\n').slice(0, 8);
  const hasMore = nodeData.sql.split('\n').length > 8;

  return (
    <div className="w-[300px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-sql px-4 py-3">
        <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
      </div>

      <div className="border-t border-border-subtle px-4 py-3">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            placeholder="输入 SQL... (Ctrl+Enter 保存)"
            className="w-full text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap bg-bg-primary border border-brand/30 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-brand/50"
            rows={3}
          />
        ) : (
          <pre
            onDoubleClick={handleDoubleClick}
            className="text-[11px] text-text-secondary font-mono leading-relaxed whitespace-pre-wrap break-all cursor-text"
            title="双击编辑 SQL"
          >
            {nodeData.sql ? (
              <>
                {sqlLines.join('\n')}
                {hasMore && '\n...'}
              </>
            ) : (
              <span className="text-text-dim italic">双击编辑 SQL</span>
            )}
          </pre>
        )}
      </div>

      <div className="border-t border-border-subtle px-4 py-2">
        <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted mb-1.5">输出列</div>
        <div className="flex flex-wrap gap-1">
          {nodeData.outputColumns.map((col) => (
            <span key={col} className="text-[11px] px-1.5 py-0.5 rounded bg-node-sql/10 text-node-sql font-mono">
              {col}
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-border-subtle px-4 py-2 flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); addReference(id); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Quote size={12} />
          <span>引用</span>
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />
    </div>
  );
}

export default memo(SQLNode);
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/components/Nodes/SQLQueryNode.tsx
rtk git commit -m "feat(nodes): add inline SQL editing to SQLQueryNode"
```

---

### Task 10: Server — Handle `observe_list` message

**Files:**
- Modify: `server/ws-handler.ts:81-108` (message handler)

- [ ] **Step 1: Add `observe_list` and `observe_list_result` to WSMessage type**

Update the `WSMessage` interface:

```ts
interface WSMessage {
  type: "prompt" | "steer" | "followUp" | "abort" | "observe_list";
  content?: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type: string }>;
}
```

- [ ] **Step 2: Add `observe_list` handler in the message switch**

Add a new case in the `ws.onmessage` switch (after `case "abort"`):

```ts
            case "observe_list": {
              try {
                const { execSync } = await import("child_process");
                const output = execSync("govio-cli observe list", {
                  encoding: "utf-8",
                  timeout: 15000,
                });
                const dataframes = JSON.parse(output);
                ws.send(JSON.stringify({ type: "observe_list_result", dataframes }));
              } catch (listErr) {
                ws.send(JSON.stringify({
                  type: "error",
                  message: `observe list failed: ${listErr instanceof Error ? listErr.message : String(listErr)}`,
                }));
              }
              break;
            }
```

- [ ] **Step 3: Commit**

```bash
rtk git add server/ws-handler.ts
rtk git commit -m "feat(server): handle observe_list message to sync canvas with backend"
```

---

### Task 11: Verify TypeScript compilation

- [ ] **Step 1: Run TypeScript check**

```bash
rtk npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Fix any type errors if found**

- [ ] **Step 3: Run dev server to verify**

```bash
npm run dev
```

Verify:
1. Click "引用" on any node → chip appears above chat input
2. Click × on chip → chip removed
3. Send message with references → message sent (check network tab for `referencedNodes`)
4. Click SQL button → new editable SQLQuery node created
5. Double-click SQL area → textarea appears, edit, Ctrl+Enter saves
6. Click 恢复 button → sends observe_list (may error if govio-cli not available, that's OK)

- [ ] **Step 4: Final commit if any fixes needed**
