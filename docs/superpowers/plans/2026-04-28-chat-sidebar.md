# Chat Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resizable chat sidebar that connects to the backend `/ws` endpoint for real-time Q&A with markdown rendering.

**Architecture:** useChat hook owns WebSocket connection + message state. ChatPanel is the sole consumer. Separate `/ws` connection from the existing `/canvas` connection. No changes to canvas-store or canvas-service.

**Tech Stack:** React 19, TypeScript, WebSocket (native), react-markdown, remark-gfm, Tailwind CSS v4, lucide-react

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/useChat.ts` | Create | WebSocket to /ws, message state, send/abort actions |
| `src/components/Layout/ResizeDivider.tsx` | Create | Vertical drag handle for panel resize |
| `src/components/Chat/ChatPanel.tsx` | Create | Chat sidebar layout (header + messages + input) |
| `src/components/Chat/ChatMessage.tsx` | Create | Single message rendering with markdown |
| `src/components/Chat/ChatInput.tsx` | Create | Textarea + send/abort button |
| `src/components/Layout/AppLayout.tsx` | Modify | Add ChatPanel + ResizeDivider |
| `src/index.css` | Modify | Add markdown prose styles for chat |
| `server/ws-handler.ts` | Modify | Add agent_start case + logging |

---

### Task 1: Backend Logging in ws-handler

**Files:**
- Modify: `server/ws-handler.ts:41-65`

- [ ] **Step 1: Add `agent_start` case and logging**

In `server/ws-handler.ts`, add a `case "agent_start"` to the switch statement, and add `console.log` calls for `agent_start`, `agent_end`, and `tool_execution_end`:

```typescript
        switch (event.type) {
          case "agent_start":
            console.log("[ws] Agent session started");
            ws.send(JSON.stringify({ type: "agent_start" }));
            break;
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              ws.send(JSON.stringify({ type: "text_delta", content: event.assistantMessageEvent.delta }));
            } else if (event.assistantMessageEvent.type === "thinking_delta") {
              ws.send(JSON.stringify({ type: "thinking_delta", content: event.assistantMessageEvent.delta }));
            }
            break;
          case "tool_execution_start":
            ws.send(JSON.stringify({ type: "tool_start", toolName: event.toolName }));
            break;
          case "tool_execution_end":
            console.log(`[ws] Tool execution end: ${event.toolName} success=${!event.isError}`);
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            emitFlushed(flushGovioNodes());
            break;
          case "message_start":
            ws.send(JSON.stringify({ type: "message_start" }));
            break;
          case "message_end":
            ws.send(JSON.stringify({ type: "message_end" }));
            emitFlushed(flushGovioNodes());
            break;
          case "agent_end":
            console.log("[ws] Agent session ended");
            break;
        }
```

The changes from current code:
1. Add `case "agent_start":` block with console.log + ws.send
2. Add `console.log` in `case "tool_execution_end":` before the existing ws.send line
3. Add `console.log` in `case "agent_end":` before the existing break

- [ ] **Step 2: Verify the server compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit --project tsconfig.node.json 2>&1 | head -20`

Expected: No errors (or only pre-existing errors unrelated to this change)

- [ ] **Step 3: Commit**

```bash
rtk git add server/ws-handler.ts && rtk git commit -m "feat: add agent_start event forwarding and console logging for agent_start, agent_end, tool_execution_end"
```

---

### Task 2: useChat Hook

**Files:**
- Create: `src/hooks/useChat.ts`

- [ ] **Step 1: Create the useChat hook**

Create `src/hooks/useChat.ts` with the full implementation:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";

export interface ToolCall {
  toolName: string;
  success?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  isStreaming?: boolean;
}

interface WSEvent {
  type: string;
  content?: string;
  toolName?: string;
  success?: boolean;
}

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg-${++msgIdCounter}`;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const currentAssistantId = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = parseInt(window.location.port) + 1;
    const ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

    ws.onopen = () => {
      console.log("[chat] Connected to /ws");
      setIsConnected(true);
      reconnectAttempts.current = 0;
    };

    ws.onclose = () => {
      console.log("[chat] Disconnected from /ws");
      setIsConnected(false);
      wsRef.current = null;
      const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 10000);
      reconnectAttempts.current += 1;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      console.warn("[chat] WebSocket error");
    };

    ws.onmessage = (event) => {
      try {
        const data: WSEvent = JSON.parse(event.data);

        switch (data.type) {
          case "session_ready":
            setIsConnected(true);
            break;

          case "message_start":
            setIsStreaming(true);
            const assistantId = nextMsgId();
            currentAssistantId.current = assistantId;
            setMessages((prev) => [
              ...prev,
              {
                id: assistantId,
                role: "assistant",
                content: "",
                tools: [],
                isStreaming: true,
              },
            ]);
            break;

          case "thinking_delta":
            if (data.content && currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, thinking: (m.thinking || "") + data.content }
                    : m
                )
              );
            }
            break;

          case "text_delta":
            if (data.content && currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, content: m.content + data.content }
                    : m
                )
              );
            }
            break;

          case "tool_start":
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, tools: [...(m.tools || []), { toolName: data.toolName || "unknown", success: undefined }] }
                    : m
                )
              );
            }
            break;

          case "tool_end":
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== currentAssistantId.current) return m;
                  const tools = [...(m.tools || [])];
                  const lastTool = tools.length - 1;
                  if (lastTool >= 0) {
                    tools[lastTool] = { ...tools[lastTool], success: data.success ?? false };
                  }
                  return { ...m, tools };
                })
              );
            }
            break;

          case "message_end":
            setIsStreaming(false);
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, isStreaming: false }
                    : m
                )
              );
              currentAssistantId.current = null;
            }
            break;

          case "error":
            console.error("[chat] Server error:", data.content);
            break;
        }
      } catch (err) {
        console.error("[chat] Parse error:", err);
      }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((content: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMsg]);

    if (isStreaming) {
      ws.send(JSON.stringify({ type: "steer", content }));
    } else {
      ws.send(JSON.stringify({ type: "prompt", content }));
    }
  }, [isStreaming]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "abort" }));
    setIsStreaming(false);
    if (currentAssistantId.current) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === currentAssistantId.current
            ? { ...m, isStreaming: false }
            : m
        )
      );
      currentAssistantId.current = null;
    }
  }, []);

  return { messages, isConnected, isStreaming, send, abort };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors in `src/hooks/useChat.ts`

- [ ] **Step 3: Commit**

```bash
rtk git add src/hooks/useChat.ts && rtk git commit -m "feat: add useChat hook with WebSocket connection and message streaming"
```

---

### Task 3: ResizeDivider Component

**Files:**
- Create: `src/components/Layout/ResizeDivider.tsx`

- [ ] **Step 1: Create ResizeDivider component**

Create `src/components/Layout/ResizeDivider.tsx`:

```tsx
import { useCallback, useRef } from "react";

interface ResizeDividerProps {
  onResize: (deltaX: number) => void;
}

export default function ResizeDivider({ onResize }: ResizeDividerProps) {
  const startXRef = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const delta = startXRef.current - moveEvent.clientX;
        startXRef.current = moveEvent.clientX;
        onResize(delta);
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [onResize]
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-2 cursor-col-resize bg-border-subtle hover:bg-border-default active:bg-brand/30 flex-shrink-0 transition-colors"
    />
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
rtk git add src/components/Layout/ResizeDivider.tsx && rtk git commit -m "feat: add ResizeDivider component for panel resize"
```

---

### Task 4: ChatInput Component

**Files:**
- Create: `src/components/Chat/ChatInput.tsx`

- [ ] **Step 1: Create ChatInput component**

Create `src/components/Chat/ChatInput.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect } from "react";
import { Send, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  isConnected: boolean;
}

export default function ChatInput({ onSend, onAbort, isStreaming, isConnected }: ChatInputProps) {
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
    <div className="flex gap-2 p-3 border-t border-border-subtle">
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
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
rtk git add src/components/Chat/ChatInput.tsx && rtk git commit -m "feat: add ChatInput component with send/abort controls"
```

---

### Task 5: ChatMessage Component

**Files:**
- Create: `src/components/Chat/ChatMessage.tsx`

- [ ] **Step 1: Create ChatMessage component**

Create `src/components/Chat/ChatMessage.tsx`:

```tsx
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, ChevronRight, Wrench, Check, X, Loader2 } from "lucide-react";
import type { ChatMessage as ChatMessageType, ToolCall } from "../../hooks/useChat";

function ToolPill({ tool }: { tool: ToolCall }) {
  const isSuccess = tool.success === true;
  const isFail = tool.success === false;
  const isRunning = tool.success === undefined;

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-bg-primary border border-border-subtle text-text-secondary">
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
        <div className="mt-1 p-2 rounded bg-bg-primary text-xs text-text-muted whitespace-pre-wrap border border-border-subtle">
          {content}
        </div>
      )}
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
          <p className="whitespace-pre-wrap">{message.content}</p>
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
rtk git add src/components/Chat/ChatMessage.tsx && rtk git commit -m "feat: add ChatMessage component with markdown, thinking, and tool pills"
```

---

### Task 6: ChatPanel Component

**Files:**
- Create: `src/components/Chat/ChatPanel.tsx`

- [ ] **Step 1: Create ChatPanel component**

Create `src/components/Chat/ChatPanel.tsx`:

```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Commit**

```bash
rtk git add src/components/Chat/ChatPanel.tsx && rtk git commit -m "feat: add ChatPanel component with message list and auto-scroll"
```

---

### Task 7: Markdown Prose Styles

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Add markdown prose styles**

Append the following to `src/index.css` (after the existing minimap rule):

```css
/* Chat markdown styles */
.chat-markdown p {
  margin: 0.5em 0;
}
.chat-markdown p:first-child {
  margin-top: 0;
}
.chat-markdown p:last-child {
  margin-bottom: 0;
}
.chat-markdown code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: #242424;
  padding: 0.15em 0.35em;
  border-radius: 3px;
}
.chat-markdown pre {
  background: #0f0f0f;
  border: 1px solid #2e2e2e;
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.5em 0;
}
.chat-markdown pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
}
.chat-markdown table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
  font-size: 0.85em;
}
.chat-markdown th,
.chat-markdown td {
  border: 1px solid #2e2e2e;
  padding: 0.4em 0.6em;
  text-align: left;
}
.chat-markdown th {
  background: #242424;
  font-weight: 600;
}
.chat-markdown ul,
.chat-markdown ol {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.chat-markdown li {
  margin: 0.2em 0;
}
.chat-markdown blockquote {
  border-left: 3px solid #3ecf8e;
  margin: 0.5em 0;
  padding: 0.25em 0.75em;
  color: #b4b4b4;
}
.chat-markdown h1,
.chat-markdown h2,
.chat-markdown h3 {
  font-weight: 600;
  margin: 0.75em 0 0.25em;
}
.chat-markdown h1 { font-size: 1.25em; }
.chat-markdown h2 { font-size: 1.1em; }
.chat-markdown h3 { font-size: 1em; }
.chat-markdown a {
  color: #3ecf8e;
  text-decoration: underline;
}
.chat-markdown hr {
  border: none;
  border-top: 1px solid #2e2e2e;
  margin: 0.75em 0;
}
```

- [ ] **Step 2: Commit**

```bash
rtk git add src/index.css && rtk git commit -m "feat: add markdown prose styles for chat messages"
```

---

### Task 8: Update AppLayout

**Files:**
- Modify: `src/components/Layout/AppLayout.tsx`

- [ ] **Step 1: Update AppLayout to include ChatPanel + ResizeDivider**

Replace the entire content of `src/components/Layout/AppLayout.tsx`:

```tsx
import { useState, useCallback } from "react";
import Header from "./Header";
import Canvas from "../Canvas/Canvas";
import ResizeDivider from "./ResizeDivider";
import ChatPanel from "../Chat/ChatPanel";

const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

export default function AppLayout() {
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((prev) => Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, prev + deltaX)));
  }, []);

  return (
    <div className="w-full h-screen flex flex-col bg-bg-canvas">
      <Header />
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 min-w-[400px] overflow-hidden">
          <Canvas />
        </div>
        <ResizeDivider onResize={handleResize} />
        <ChatPanel width={chatWidth} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/macx/work/nodejs/govio-map && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors

- [ ] **Step 3: Run dev server and visually verify**

Run: `cd /home/macx/work/nodejs/govio-map && npm run dev`

Open browser at http://localhost:5173. Verify:
1. Canvas on the left, chat sidebar on the right
2. Divider is visible between them
3. Dragging divider resizes the chat panel
4. Chat input accepts text
5. Status shows "已连接" when backend is running, "未连接" when not

- [ ] **Step 4: Commit**

```bash
rtk git add src/components/Layout/AppLayout.tsx && rtk git commit -m "feat: add chat sidebar with resizable divider to AppLayout"
```

---

### Task 9: Integration Test

**Files:**
- No new files

- [ ] **Step 1: Start backend + frontend together**

Run: `cd /home/macx/work/nodejs/govio-map && npm run dev`

- [ ] **Step 2: Test chat flow end-to-end**

1. Open browser at http://localhost:5173
2. Verify chat sidebar appears on the right with "已连接" status
3. Type a message like "查询 users 表" and press Enter
4. Verify:
   - User message appears right-aligned
   - Assistant response streams in with markdown rendering
   - Tool execution pills appear when agent runs tools
   - Thinking section is collapsible
   - Stop button appears during streaming
5. Resize the chat panel by dragging the divider
6. Verify canvas nodes still appear when agent creates them

- [ ] **Step 3: Test error handling**

1. Stop the backend server
2. Verify chat shows "未连接" status
3. Verify input is disabled
4. Restart backend and verify reconnection happens automatically

- [ ] **Step 4: Final commit if any fixes needed**

If any fixes were needed during testing, commit them here.
