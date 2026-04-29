# Design: Dual WebSocket + Layout Redesign

**Date:** 2026-04-28
**Tasks:** docs/todo.json — 前后端交互重构 + 前端界面修改

## Context

The current govio-map app uses a single WebSocket (`/ws`) for both conversation streaming and canvas card creation. The user wants to:

1. **Separate concerns**: Card creation should flow through an independent channel from conversation
2. **Redesign layout**: Remove left sidebar, move chat to right side as a resizable panel (3:1 default)

## Task 1: Dual WebSocket Architecture

### Current state

One WebSocket path (`/ws`) carries all events: `text_delta`, `thinking_delta`, `tool_start/end`, `message_end`, `error`, and `govio_node_create`.

### Target state

Two WebSocket paths on the same HTTP server (port 5174):
- `/ws` — conversation only
- `/canvas` — card creation only

### Backend changes

#### `server/govio-node-queue.ts` — Add EventEmitter

Extend the module to emit events when nodes are flushed. This allows the canvas handler to subscribe without tight coupling.

```typescript
import { EventEmitter } from "events";

const emitter = new EventEmitter();
const queue: GovioNodeCreateEvent[] = [];

export function pushGovioNode(event: GovioNodeCreateEvent): void {
  queue.push(event);
}

export function flushGovioNodes(): GovioNodeCreateEvent[] {
  const result = [...queue];
  queue.length = 0;
  return result;
}

export function onGovioNodesFlushed(callback: (events: GovioNodeCreateEvent[]) => void): () => void {
  emitter.on("flushed", callback);
  return () => emitter.off("flushed", callback);
}

export function emitFlushed(events: GovioNodeCreateEvent[]): void {
  emitter.emit("flushed", events);
}
```

#### `server/ws-handler.ts` — Remove card creation

- Remove all `govio_node_create` sends from `tool_execution_end` and `message_end` cases
- Keep calling `flushGovioNodes()` to drain the queue (prevents memory leaks)
- Call `emitFlushed()` after flushing so the canvas handler picks them up

#### New: `server/canvas-ws-handler.ts`

```typescript
export function setupCanvasWebSocket(wss: WebSocketServer): void {
  // Handles /canvas path connections
  // On connection:
  //   - Subscribe to govio-node-queue onGovioNodesFlushed
  //   - Forward govio_node_create events to the client
  // On close:
  //   - Unsubscribe
}
```

#### `server/index.ts` — Register both paths

```typescript
setupWebSocket(httpServer);   // /ws — conversation
setupCanvasWebSocket(httpServer);  // /canvas — card creation
```

Both handlers share the same HTTP server on port 5174.

### Frontend changes

#### New: `src/services/canvas-service.ts`

```typescript
interface CanvasService {
  subscribe(callback: (event: GovioNodeCreateEvent) => void): () => void;
  isConnected(): boolean;
}
```

- Connects to `ws://<hostname>:<port>/canvas`
- Parses incoming JSON, broadcasts to subscribers
- Singleton factory pattern (same as ai-service.ts)
- Graceful degradation: if connection fails, log warning, no card creation

#### `src/store/canvas-store.ts` — Split subscriptions

- Remove `govio_node_create` handling from `sendMessage()` subscription
- Remove edge creation from `createGovioNode()` — cards appear independently
- New action `subscribeToCanvas()`: subscribes to `canvasService` for `govio_node_create` events
- Called once on app mount

### End-to-end flow

```
Conversation (/ws):
  User → ChatPanel → aiService.sendMessage()
  Backend → text_delta, thinking_delta, message_end → ChatPanel streaming

Card creation (/canvas):
  Backend govio-canvas extension → queue → flush → canvas-ws-handler
  Frontend canvas-service → createGovioNode() → new Node on canvas (no edges)
```

The two channels are completely independent.

## Task 2: Layout Redesign

### Current layout

```
┌────────────────────────────────────────────┐
│  Header (h-14)                              │
├────────────┬───────────────────────────────┤
│  Sidebar   │  Canvas (flex-1)              │
│  (w-280px) │                               │
│            ├───────────────────────────────┤
│  8 tables  │  ChatPanel (h-320px, bottom)  │
└────────────┴───────────────────────────────┘
```

### Target layout

```
┌──────────────────────────────────────────────────┐
│  Header (h-14)                                    │
├──────────────────────────┬─┬─────────────────────┤
│                          │ │                      │
│                          │D│   Chat Sidebar       │
│     Canvas (flex-1)      │I│   (25% default)      │
│                          │V│                      │
│                          │I│   Messages           │
│                          │D│   scrollable         │
│                          │E│                      │
│                          │R│   Input + Send       │
│                          │ │                      │
└──────────────────────────┴─┴─────────────────────┘
                           ↑
                     4px draggable divider
```

### Component changes

#### Remove: `src/components/Sidebar/Sidebar.tsx`

Delete entirely. Remove import from AppLayout.tsx.

#### Modify: `src/components/Layout/AppLayout.tsx`

```tsx
function AppLayout() {
  const [chatWidth, setChatWidth] = useState(25); // percentage

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth(prev => {
      const containerWidth = window.innerWidth;
      const deltaPercent = (deltaX / containerWidth) * 100;
      return Math.min(50, Math.max(15, prev - deltaPercent));
    });
  }, []);

  return (
    <div className="w-full h-screen flex flex-col bg-bg-canvas">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 min-w-0">
          <Canvas />
        </div>
        <ResizeDivider onResize={handleResize} />
        <div style={{ width: `${chatWidth}%` }} className="min-w-0 flex flex-col">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
```

#### New: `src/components/Layout/ResizeDivider.tsx`

```tsx
function ResizeDivider({ onResize }: { onResize: (deltaX: number) => void }) {
  // 4px wide vertical strip
  // Cursor: col-resize on hover
  // mousedown → document mousemove → mouseup
  // During drag: user-select: none on body
  // Calls onResize(deltaX) on mousemove
}
```

#### Modify: `src/components/Chat/ChatPanel.tsx`

- Remove collapsed/expanded toggle (always visible)
- Change from fixed height (`h-[320px]`) to full height (`h-full`)
- Replace `border-t` with `border-l` (left border)
- Keep all internal structure unchanged (messages, input, streaming, node badges)

### Canvas store edge changes

Remove edge creation block from `createGovioNode()`:

```diff
- // Create edges from referenced nodes → new node
- for (const ref of lastReferencedNodes) {
-   newEdges.push({
-     id: `e-${ref.nodeId}-${nodeId}`,
-     source: ref.nodeId,
-     target: nodeId,
-     ...
-   });
- }
```

Cards appear on canvas independently. No lineage edges.

## Files to modify

| File | Action | Task |
|------|--------|------|
| `server/govio-node-queue.ts` | Add EventEmitter | 1 |
| `server/ws-handler.ts` | Remove govio_node_create sends | 1 |
| `server/canvas-ws-handler.ts` | **New** — canvas WebSocket handler | 1 |
| `server/index.ts` | Register /canvas path | 1 |
| `src/services/canvas-service.ts` | **New** — canvas WS client | 1 |
| `src/store/canvas-store.ts` | Split subscriptions, remove edges | 1 |
| `src/components/Sidebar/Sidebar.tsx` | **Delete** | 2 |
| `src/components/Layout/AppLayout.tsx` | Restructure layout | 2 |
| `src/components/Layout/ResizeDivider.tsx` | **New** — drag divider | 2 |
| `src/components/Chat/ChatPanel.tsx` | Full height, remove collapse | 2 |

## Verification

1. `npm run dev` — app starts without errors
2. Chat panel appears on right side, 25% width
3. Drag divider to resize chat panel (15%–50% range)
4. Send a message → text streams in chat panel (via /ws)
5. Agent creates cards on canvas (via /canvas) — no edges between cards
6. Canvas and chat operate independently — cards appear even mid-stream
7. `npm run build` — TypeScript passes, no build errors
8. `npm run lint` — no lint errors
