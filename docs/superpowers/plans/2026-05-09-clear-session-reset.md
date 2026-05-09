# /clear Session Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance `/clear` to destroy the server-side `AgentSession` and create a fresh one, while also clearing frontend chat messages.

**Architecture:** Client sends a `{ type: "clear" }` WebSocket message. Server unsubscribes from the old session, nulls it out, creates a fresh `AgentSession`, resubscribes the WebSocket, and responds with `session_ready`. Frontend clears messages immediately.

**Tech Stack:** TypeScript, React (useCallback/useState/useRef), WebSocket (ws), @mariozechner/pi-coding-agent

---

### Task 1: Add `resetSession()` to `server/agent.ts`

**Files:**
- Modify: `server/agent.ts:61-63`

- [ ] **Step 1: Add `resetSession` function**

After the existing `getSession` function (line 63), add:

```ts
export function resetSession() {
  session = null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `rtk npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
rtk git add server/agent.ts
rtk git commit -m "feat: add resetSession to agent module"
```

---

### Task 2: Handle `"clear"` message in `server/ws-handler.ts`

**Files:**
- Modify: `server/ws-handler.ts:1-10` (imports + WSMessage type)
- Modify: `server/ws-handler.ts:31-134` (connection handler)

- [ ] **Step 1: Update import to include `resetSession`**

Change line 3 from:
```ts
import { getOrCreateSession, runGovioCli } from "./agent.js";
```
to:
```ts
import { getOrCreateSession, resetSession, runGovioCli } from "./agent.js";
```

- [ ] **Step 2: Add `"clear"` to the `WSMessage` type union**

Change line 8 from:
```ts
type: "prompt" | "steer" | "followUp" | "abort" | "observe_list";
```
to:
```ts
type: "prompt" | "steer" | "followUp" | "abort" | "observe_list" | "clear";
```

- [ ] **Step 3: Extract subscribe callback into a helper function**

Inside the `wss.on("connection", async (ws) => { ... })` handler, right after the `try {` on line 32, replace the `const session = await getOrCreateSession();` block and the `const unsubscribe = session.subscribe(...)` block with:

```ts
const initialSession = await getOrCreateSession();

let session = initialSession;

function subscribeToSession(s: typeof session, ws: WebSocket) {
  return s.subscribe((event) => {
    try {
      if (ws.readyState !== WebSocket.OPEN) return;
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
          if (event.message.role === "assistant") {
            ws.send(JSON.stringify({ type: "message_start" }));
          }
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            ws.send(JSON.stringify({ type: "message_end" }));
            emitFlushed(flushGovioNodes());
          }
          break;
        case "agent_end":
          console.log("[ws] Agent session ended");
          ws.send(JSON.stringify({ type: "agent_end" }));
          break;
      }
    } catch (err) {
      console.error("[ws] Subscribe callback error:", err);
    }
  });
}

let unsubscribe = subscribeToSession(session, ws);
```

This replaces the original `const session = await getOrCreateSession();` (line 33), the `ws.send(session_ready)` (line 35), and the entire `const unsubscribe = session.subscribe(...)` block (lines 37-80).

Keep the `ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));` line right after `let unsubscribe = subscribeToSession(session, ws);`.

- [ ] **Step 4: Add `"clear"` case to the message handler**

Inside the `ws.on("message", ...)` switch statement (after the `"observe_list"` case, before the closing `}` of the switch), add:

```ts
case "clear": {
  unsubscribe();
  resetSession();
  const newSession = await getOrCreateSession();
  session = newSession;
  unsubscribe = subscribeToSession(newSession, ws);
  ws.send(JSON.stringify({ type: "session_ready", sessionId: newSession.sessionId }));
  break;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `rtk npx tsc --noEmit -p tsconfig.node.json`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
rtk git add server/ws-handler.ts
rtk git commit -m "feat: handle clear message to reset agent session"
```

---

### Task 3: Add `clearSession()` to `src/hooks/useChat.ts`

**Files:**
- Modify: `src/hooks/useChat.ts:283-286` (after clearMessages, before observeList)
- Modify: `src/hooks/useChat.ts:311` (return statement)

- [ ] **Step 1: Add `clearSession` callback**

After the `clearMessages` callback (line 286), add:

```ts
const clearSession = useCallback(() => {
  const ws = wsRef.current;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isStreamingRef.current) {
    ws.send(JSON.stringify({ type: "abort" }));
    isStreamingRef.current = false;
    setIsStreaming(false);
    finalizeCurrent();
  }
  ws.send(JSON.stringify({ type: "clear" }));
  clearMessages();
}, [clearMessages, finalizeCurrent]);
```

- [ ] **Step 2: Export `clearSession` from the hook**

Change the return statement (line 311) from:
```ts
return { messages, isConnected, isStreaming, send, abort, observeList, isObserving, clearMessages };
```
to:
```ts
return { messages, isConnected, isStreaming, send, abort, observeList, isObserving, clearMessages, clearSession };
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `rtk npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
rtk git add src/hooks/useChat.ts
rtk git commit -m "feat: add clearSession to useChat hook"
```

---

### Task 4: Plumb `clearSession` through the component tree

**Files:**
- Modify: `src/commands/types.ts:9-14` (CommandContext interface)
- Modify: `src/commands/built-in.ts:3-6` (handleClear)
- Modify: `src/components/Chat/ChatPanel.tsx:12` (destructure clearSession)
- Modify: `src/components/Chat/ChatPanel.tsx:71-83` (pass to ChatInput)
- Modify: `src/components/Chat/ChatInput.tsx:26-38` (ChatInputProps)
- Modify: `src/components/Chat/ChatInput.tsx:40-51` (destructure props)
- Modify: `src/components/Chat/ChatInput.tsx:62-70` (CommandContext construction)

- [ ] **Step 1: Add `clearSession` to `CommandContext`**

In `src/commands/types.ts`, change the `CommandContext` interface to:

```ts
export interface CommandContext {
  clearMessages: () => void;
  clearCanvas: () => void;
  clearSession: () => void;
  exportSession: () => void;
  addSystemMessage: (content: string) => void;
}
```

- [ ] **Step 2: Update `handleClear` in `built-in.ts`**

Change `handleClear` from:
```ts
function handleClear(ctx: CommandContext) {
  ctx.clearMessages();
  ctx.addSystemMessage("已清理会话上下文");
}
```
to:
```ts
function handleClear(ctx: CommandContext) {
  ctx.clearSession();
}
```

- [ ] **Step 3: Update `ChatPanel.tsx` to pass `clearSession`**

On line 12, add `clearSession` to the destructure:
```ts
const { messages, isConnected, isStreaming, send, abort, clearMessages, clearSession } = useChatContext();
```

In the `<ChatInput>` JSX (around line 71), add the `clearSession` prop:
```tsx
<ChatInput
  onSend={handleSend}
  onAbort={abort}
  isStreaming={isStreaming}
  isConnected={isConnected}
  referencedNodes={referencedNodes}
  onRemoveReference={removeReference}
  clearMessages={clearMessages}
  clearSession={clearSession}
  clearCanvas={useCanvasStore.getState().clearCanvas}
  messages={messages}
  nodes={useCanvasStore.getState().nodes}
  edges={useCanvasStore.getState().edges}
/>
```

- [ ] **Step 4: Update `ChatInput.tsx` to accept and use `clearSession`**

Add `clearSession` to the `ChatInputProps` interface:
```ts
interface ChatInputProps {
  onSend: (content: string) => void;
  onAbort: () => void;
  isStreaming: boolean;
  isConnected: boolean;
  referencedNodes?: ReferencedNode[];
  onRemoveReference?: (nodeId: string) => void;
  clearMessages?: () => void;
  clearCanvas?: () => void;
  clearSession?: () => void;
  messages?: ChatMessage[];
  nodes?: Node[];
  edges?: Edge[];
}
```

Add `clearSession` to the destructured props with default:
```ts
clearSession = () => {},
```

Include `clearSession` in the `CommandContext` construction:
```ts
const ctx: CommandContext = useMemo(
  () => ({
    clearMessages,
    clearCanvas,
    clearSession,
    exportSession: () => exportSession(messages, nodes, edges),
    addSystemMessage,
  }),
  [clearMessages, clearCanvas, clearSession, messages, nodes, edges, addSystemMessage]
);
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `rtk npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
rtk git add src/commands/types.ts src/commands/built-in.ts src/components/Chat/ChatPanel.tsx src/components/Chat/ChatInput.tsx
rtk git commit -m "feat: wire clearSession through command context and components"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Expected: server starts on port 5173, WebSocket on 5174

- [ ] **Step 2: Verify /clear resets session**

1. Open browser to `http://localhost:5173`
2. Send a message (e.g., "hello") — verify assistant responds
3. Type `/clear` and press Enter
4. Verify: chat messages disappear, no error in console
5. Send another message — verify the agent has no memory of the previous conversation

- [ ] **Step 3: Verify TypeScript and lint pass**

Run: `rtk npx tsc --noEmit && rtk npm run lint`
Expected: no errors

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
rtk git add -A
rtk git commit -m "fix: polish clear session reset"
```
