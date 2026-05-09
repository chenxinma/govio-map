# /clear Session Reset Design

## Problem

The `/clear` command only clears frontend React messages. The pi-coding-agent session on the server retains all conversation history and tool state, so the next prompt still has full prior context. Users expect `/clear` to give them a truly fresh start.

## Goal

`/clear` destroys the current `AgentSession` server-side and creates a fresh one, while also clearing frontend chat messages. The WebSocket connection stays alive — no reconnection.

## Scope

- 7 files modified, no new files
- ~40 lines of net change
- No new dependencies

## Design

### 1. Server: `resetSession()` in `server/agent.ts`

Add an exported function that sets the module-level `session` variable to `null`. The next call to `getOrCreateSession()` will create a fresh `AgentSession` with no history.

```ts
export function resetSession() {
  session = null;
}
```

### 2. Server: Handle `"clear"` message in `server/ws-handler.ts`

Inside the `wss.on("connection")` handler:

- Change `const session` and `const unsubscribe` to `let` bindings.
- Extract the `session.subscribe(...)` callback into a local helper `subscribeToSession(s: AgentSession, ws: WebSocket)` to avoid duplicating the event-forwarding switch.
- Add a `"clear"` case to the message handler:

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

Also add `"clear"` to the `WSMessage.type` union.

### 3. Client: `clearSession()` in `src/hooks/useChat.ts`

Add a new callback that:
1. If `isStreamingRef.current` is true, sends `{ type: "abort" }` first to stop the active agent run.
2. Sends `{ type: "clear" }` over the WebSocket.
3. Calls `clearMessages()` to reset frontend state immediately.
4. Resets `isStreamingRef.current = false` and calls `setIsStreaming(false)`.

Export it from the hook return value.

### 4. Plumb `clearSession` through the component tree

- `src/commands/types.ts` — add `clearSession: () => void` to `CommandContext`
- `src/components/Chat/ChatPanel.tsx` — destructure `clearSession` from `useChatContext()`, pass as prop to `ChatInput`
- `src/components/Chat/ChatInput.tsx` — accept `clearSession` prop, include in `CommandContext`
- `src/commands/built-in.ts` — `handleClear` calls `ctx.clearSession()` (replaces the current `ctx.clearMessages()` + no-op `addSystemMessage`)

### Data Flow

```
User types /clear
  → handleClear calls ctx.clearSession()
    → useChat.clearSession()
      → if streaming: WS send { type: "abort" }  // stop active run first
      → WS send { type: "clear" }
      → setMessages([])                          // frontend cleared immediately
      → isStreaming = false
    → server receives "clear"
      → unsubscribe from old session
      → resetSession()                           // session = null
      → getOrCreateSession()                     // fresh AgentSession
      → subscribeToSession(newSession, ws)       // rebind WS events
      → send { type: "session_ready" }           // client knows it's ready
    → client receives session_ready
      → isConnected stays true, no UI disruption
```

### What gets wiped

- All conversation history (user prompts + assistant responses)
- Tool execution state
- Agent memory / context from prior prompts
- Frontend message list

### What persists

- WebSocket connection (no reconnect)
- Canvas nodes and edges (not affected by /clear)
- Zustand persisted state in localStorage
