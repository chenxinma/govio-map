# Chat Sidebar Design

## Goal

Add a resizable chat sidebar to the right side of the canvas that connects to the backend `/ws` endpoint for real-time Q&A with the pi-coding-agent. Supports markdown rendering of assistant responses.

## Architecture

### Approach: Single ChatPanel + useChat hook

Chat state lives in a `useChat` hook — not in Zustand. The chat sidebar is the sole consumer. If global access is needed later, state can be lifted to a store.

### Data Flow

```
User types prompt
  → useChat sends { type: "prompt", content: "..." }
  → Backend AgentSession processes
  → Backend streams events over /ws:
      { type: "message_start" }
      { type: "thinking_delta", content: "..." }  (optional)
      { type: "text_delta", content: "..." }
      { type: "tool_start", toolName: "bash" }
      { type: "tool_end", toolName: "bash", success: true }
      { type: "message_end" }
  → useChat accumulates into ChatMessage objects
  → ChatPanel renders
```

Chat connects to `/ws` separately. Canvas connects to `/canvas` separately. Two independent WebSocket connections. No changes to existing canvas-service or canvas-store.

## Message Model

```ts
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;          // full markdown text (accumulated from text_delta)
  thinking?: string;        // accumulated thinking text
  tools?: ToolCall[];       // tool executions during this message
  isStreaming?: boolean;    // still receiving deltas
}

interface ToolCall {
  toolName: string;
  success?: boolean;        // undefined while running, true/false when done
}
```

When `message_start` arrives, create a new `assistant` message with `isStreaming: true`. Each `text_delta`/`thinking_delta` appends to it. `tool_start`/`tool_end` add/update entries in the `tools` array. `message_end` sets `isStreaming: false`.

## Layout

AppLayout becomes a horizontal flex:

```
┌──────────────────────────────────┬──┬─────────────┐
│           Header                 │  │             │
├──────────────────────────────────┤  │  ChatPanel  │
│                                  │D │             │
│           Canvas                 │i │  Messages   │
│         (flex-1)                 │v │  ...        │
│                                  │i │             │
│                                  │d │  Input      │
│                                  │e │             │
│                                  │r │             │
└──────────────────────────────────┴──┴─────────────┘
```

- Canvas: flex-1, min-width 400px
- ResizeDivider: 8px drag handle
- ChatPanel: default 400px, min 280px, max 600px

## Components

### ResizeDivider
Vertical bar between canvas and chat. On mousedown, tracks mouse X and updates chat panel width. Cursor: `col-resize`.

### ChatPanel
Top to bottom:
1. **Header bar** — "对话" title, connection status (green dot = connected, red = disconnected)
2. **Message list** — scrollable, renders all ChatMessage objects
3. **Input area** — textarea + send/abort button

### ChatMessage
- User messages: right-aligned text bubble (brand green accent)
- Assistant messages: left-aligned, containing (in order from top to bottom):
  1. Collapsible "Thinking" section (collapsed by default, shows thinking content)
  2. Tool execution pills: small pills showing each tool name + status (spinner while running, checkmark/cross when done)
  3. Main content rendered via `react-markdown` + `remark-gfm`

### ChatInput
- Enter sends, Shift+Enter adds newline
- While streaming: send button becomes abort (stop) button
- Sends `{ type: "prompt" }` if not streaming, `{ type: "steer" }` if streaming

## Key Decisions

- **Auto-scroll**: Auto-scrolls to bottom on new content. If user scrolls up, disable auto-scroll until they scroll back to bottom.
- **Reconnection**: Show "Reconnecting..." indicator on disconnect. Auto-reconnect with exponential backoff.
- **No message persistence**: Messages live in hook state only. Refresh clears history.
- **Markdown**: `react-markdown` + `remark-gfm` for GFM tables, strikethrough, task lists. Code blocks styled with CSS (no heavy syntax highlighter).

## File Structure

**New files:**
- `src/components/Chat/ChatPanel.tsx` — Main chat sidebar
- `src/components/Chat/ChatMessage.tsx` — Message rendering
- `src/components/Chat/ChatInput.tsx` — Input area
- `src/components/Layout/ResizeDivider.tsx` — Drag divider
- `src/hooks/useChat.ts` — WebSocket + message state

**Modified files:**
- `src/components/Layout/AppLayout.tsx` — Add ChatPanel + ResizeDivider

**Modified files (backend logging):**
- `server/ws-handler.ts` — Add `agent_start` case to the switch (currently missing), add console.log for `agent_start`, `agent_end`, `tool_execution_end`

**Unchanged:**
- `canvas-store.ts`, `canvas-service.ts`

## Design System

Chat panel follows the existing dark Supabase theme:
- Panel background: `#171717`
- Message bubbles (user): `#0f0f0f` with `#3ecf8e` left border
- Message bubbles (assistant): `#0f0f0f` with `#2e2e2e` border
- Input area: `#0f0f0f` background, `#2e2e2e` border
- Tool pills: `#242424` background, muted text
- Thinking section: `#242424` background, `#898989` text

## Also: Backend Logging

Add console logging in `server/ws-handler.ts` for three event types:
- `agent_start`: log session start
- `agent_end`: log session end
- `tool_execution_end`: log tool name and success/fail
