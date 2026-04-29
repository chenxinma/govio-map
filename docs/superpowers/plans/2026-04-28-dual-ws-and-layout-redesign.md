# Dual WebSocket + Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single WebSocket into two channels (/ws for conversation, /canvas for card creation) and redesign the layout to remove the left sidebar with chat as a resizable right panel.

**Architecture:** Two WebSocket paths on the same HTTP server. The govio-node-queue gains an EventEmitter to notify the new canvas handler when nodes are flushed. The frontend gets a second WebSocket client (canvas-service.ts) and the layout switches from sidebar+bottom-chat to canvas|divider|right-chat.

**Tech Stack:** TypeScript, React 18, Zustand, ws (WebSocket), Node.js EventEmitter, Tailwind CSS v4, @xyflow/react

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/govio-node-queue.ts` | Modify | Add EventEmitter for flush notifications |
| `server/canvas-ws-handler.ts` | Create | Handle /canvas WebSocket connections, forward govio_node_create events |
| `server/ws-handler.ts` | Modify | Remove govio_node_create sends, call emitFlushed after flush |
| `server/index.ts` | Modify | Register both /ws and /canvas paths |
| `src/services/canvas-service.ts` | Create | WebSocket client for /canvas channel |
| `src/types/index.ts` | Modify | Add GovioNodeCreateEvent type (move from server) |
| `src/store/canvas-store.ts` | Modify | Split subscriptions, remove edge creation, add subscribeToCanvas |
| `src/components/Sidebar/Sidebar.tsx` | Delete | Remove left sidebar |
| `src/components/Layout/AppLayout.tsx` | Modify | Restructure to canvas+divider+chat layout |
| `src/components/Layout/ResizeDivider.tsx` | Create | Draggable vertical divider |
| `src/components/Chat/ChatPanel.tsx` | Modify | Full height, remove collapse toggle |

---

### Task 1: Add EventEmitter to govio-node-queue

**Files:**
- Modify: `server/govio-node-queue.ts`

- [ ] **Step 1: Add EventEmitter exports**

Replace the entire file with:

```typescript
import { EventEmitter } from "events";

export type GovioNodeType = "sqlQuery" | "dataFrame" | "report";

export interface GovioNodeCreateEvent {
  nodeType: GovioNodeType;
  title: string;
  // sqlQuery
  sql?: string;
  outputColumns?: string[];
  // dataFrame
  dfName?: string;
  sourceName?: string;
  totalRows?: number;
  totalColumns?: number;
  memoryUsage?: string;
  columns?: Array<{ name: string; nonNull: number; dtype: string }>;
  // report
  reportType?: "diff" | "correlation";
  content?: string;
  sourceRefs?: Array<{ label: string }>;
}

const queue: GovioNodeCreateEvent[] = [];
const emitter = new EventEmitter();

export function pushGovioNode(event: GovioNodeCreateEvent): void {
  queue.push(event);
}

export function flushGovioNodes(): GovioNodeCreateEvent[] {
  const result = [...queue];
  queue.length = 0;
  return result;
}

export function emitFlushed(events: GovioNodeCreateEvent[]): void {
  if (events.length > 0) {
    emitter.emit("flushed", events);
  }
}

export function onGovioNodesFlushed(
  callback: (events: GovioNodeCreateEvent[]) => void
): () => void {
  emitter.on("flushed", callback);
  return () => {
    emitter.off("flushed", callback);
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit server/govio-node-queue.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/govio-node-queue.ts
git commit -m "feat: add EventEmitter to govio-node-queue for canvas channel"
```

---

### Task 2: Create canvas WebSocket handler

**Files:**
- Create: `server/canvas-ws-handler.ts`

- [ ] **Step 1: Create canvas-ws-handler.ts**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { getOrCreateSession } from "./agent.js";
import { onGovioNodesFlushed, type GovioNodeCreateEvent } from "./govio-node-queue.js";

export function setupCanvasWebSocket(server: import("http").Server) {
  const wss = new WebSocketServer({ server, path: "/canvas" });

  wss.on("connection", async (ws: WebSocket) => {
    try {
      const session = await getOrCreateSession();

      ws.send(JSON.stringify({ type: "canvas_ready", sessionId: session.sessionId }));

      const unsubscribe = onGovioNodesFlushed((events: GovioNodeCreateEvent[]) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const node of events) {
          ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
        }
      });

      ws.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Canvas session init failed: ${err}` }));
      ws.close();
    }
  });

  return wss;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit server/canvas-ws-handler.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/canvas-ws-handler.ts
git commit -m "feat: add canvas WebSocket handler for /canvas path"
```

---

### Task 3: Update ws-handler to emit flushed events

**Files:**
- Modify: `server/ws-handler.ts:3,35-49`

- [ ] **Step 1: Update import**

Change line 3 from:
```typescript
import { flushGovioNodes } from "./govio-node-queue.js";
```
to:
```typescript
import { flushGovioNodes, emitFlushed } from "./govio-node-queue.js";
```

- [ ] **Step 2: Remove govio_node_create sends from tool_execution_end**

Replace lines 35-39:
```typescript
          case "tool_execution_end":
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            for (const node of flushGovioNodes()) {
              ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
            }
```
with:
```typescript
          case "tool_execution_end":
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            emitFlushed(flushGovioNodes());
```

- [ ] **Step 3: Remove govio_node_create sends from message_end**

Replace lines 44-48:
```typescript
          case "message_end":
            ws.send(JSON.stringify({ type: "message_end" }));
            for (const node of flushGovioNodes()) {
              ws.send(JSON.stringify({ type: "govio_node_create", ...node }));
            }
```
with:
```typescript
          case "message_end":
            ws.send(JSON.stringify({ type: "message_end" }));
            emitFlushed(flushGovioNodes());
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit server/ws-handler.ts`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add server/ws-handler.ts
git commit -m "refactor: remove govio_node_create from /ws, emit via EventEmitter"
```

---

### Task 4: Register both WebSocket paths in server/index.ts

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Add import and registration**

Replace the entire file with:

```typescript
import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import { setupCanvasWebSocket } from "./canvas-ws-handler.js";
import { handleParquetApi } from "./parquet-api.js";
import type { Plugin } from "vite";

let httpServer: ReturnType<typeof createServer> | null = null;

export function wsPlugin(): Plugin {
  return {
    name: "ws-plugin",
    configureServer(server) {
      httpServer = createServer((req, res) => {
        if (handleParquetApi(req, res)) return;
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
      setupWebSocket(httpServer);
      setupCanvasWebSocket(httpServer);

      server.httpServer?.on("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          httpServer?.listen(address.port + 1, () => {
            console.log(`[ws] WebSocket + API server on port ${address.port + 1}`);
          });
        }
      });
    },
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit server/index.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: register /canvas WebSocket path alongside /ws"
```

---

### Task 5: Create frontend canvas-service.ts

**Files:**
- Create: `src/services/canvas-service.ts`

- [ ] **Step 1: Create canvas-service.ts**

```typescript
export interface CanvasEvent {
  type: "govio_node_create";
  nodeType: "sqlQuery" | "dataFrame" | "report";
  title: string;
  sql?: string;
  outputColumns?: string[];
  dfName?: string;
  sourceName?: string;
  totalRows?: number;
  totalColumns?: number;
  memoryUsage?: string;
  columns?: Array<{ name: string; nonNull: number; dtype: string }>;
  reportType?: "diff" | "correlation";
  reportContent?: string;
  sourceRefs?: Array<{ label: string }>;
}

export interface CanvasService {
  subscribe(callback: (event: CanvasEvent) => void): () => void;
  isConnected(): boolean;
}

class WebSocketCanvasService implements CanvasService {
  private ws: WebSocket | null = null;
  private callbacks: Set<(event: CanvasEvent) => void> = new Set();
  private connectPromise: Promise<void> | null = null;

  constructor() {
    this.connect();
  }

  private connect() {
    this.connectPromise = new Promise((resolve) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsPort = parseInt(window.location.port) + 1;
      this.ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/canvas`);

      this.ws.onopen = () => {
        console.log("[canvas-service] Connected to /canvas");
        resolve();
      };
      this.ws.onclose = () => {
        console.log("[canvas-service] Disconnected from /canvas");
        this.connectPromise = null;
      };
      this.ws.onerror = () => {
        console.warn("[canvas-service] Failed to connect to /canvas");
        this.connectPromise = null;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.callbacks.forEach((cb) => {
            try {
              cb(data);
            } catch (err) {
              console.error("[canvas-service] callback error:", err);
            }
          });
        } catch (err) {
          console.error("[canvas-service] parse error:", err);
        }
      };
    });
  }

  subscribe(callback: (event: CanvasEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

class MockCanvasService implements CanvasService {
  subscribe(_callback: (event: CanvasEvent) => void): () => void {
    return () => {};
  }

  isConnected(): boolean {
    return false;
  }
}

let instance: CanvasService | null = null;

export function getCanvasService(): CanvasService {
  if (!instance) {
    try {
      instance = new WebSocketCanvasService();
    } catch {
      console.warn("[canvas-service] WebSocket not available, using mock");
      instance = new MockCanvasService();
    }
  }
  return instance;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/services/canvas-service.ts`
Expected: No errors (may need to adjust import path for GovioNodeCreateEvent depending on tsconfig)

- [ ] **Step 3: Commit**

```bash
git add src/services/canvas-service.ts
git commit -m "feat: add canvas-service.ts WebSocket client for /canvas channel"
```

---

### Task 6: Update canvas-store — split subscriptions, remove edges

**Files:**
- Modify: `src/store/canvas-store.ts`

- [ ] **Step 1: Add canvas-service import**

Add after line 8:
```typescript
import { getCanvasService } from '../services/canvas-service';
```

- [ ] **Step 2: Add subscribeToCanvas action to interface**

Add after line 41 (`createGovioNode`):
```typescript
  subscribeToCanvas: () => void;
```

- [ ] **Step 3: Remove govio_node_create from sendMessage subscription**

In the `sendMessage` method (line 116-157), remove the `govio_node_create` case from the switch statement. Delete lines 153-155:
```typescript
        case "govio_node_create":
          try { get().createGovioNode(event); } catch (err) { console.error("[canvas] createGovioNode error:", err); }
          break;
```

- [ ] **Step 4: Remove edge creation from createGovioNode**

In the `createGovioNode` method (lines 216-304), remove the edge creation block. Replace lines 275-292:
```typescript
    const newEdges: Edge[] = [];
    const seen = new Set<string>();
    for (const ref of lastReferencedNodes) {
      const key = `${ref.nodeId}->${nodeId}`;
      if (!seen.has(key)) {
        seen.add(key);
        newEdges.push({
          id: `e-${ref.nodeId}-${nodeId}`,
          source: ref.nodeId,
          target: nodeId,
          style: { stroke: "#3ecf8e", strokeWidth: 2 },
          animated: true,
        });
      }
    }

    const allNodes = [...nodes, newNode];
    const allEdges = [...edges, ...newEdges];
    try {
      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(allNodes, allEdges);
      set({ nodes: layoutedNodes, edges: layoutedEdges });
    } catch (err) {
```
with:
```typescript
    const allNodes = [...nodes, newNode];
    try {
      const { nodes: layoutedNodes } = getLayoutedElements(allNodes, edges);
      set({ nodes: layoutedNodes });
    } catch (err) {
```

Also update the fallback in the catch block (lines 299-302) to not set edges:
```typescript
      newNode.position = {
        x: 100 + nodes.length * 60,
        y: 100 + nodes.length * 40,
      };
      set({ nodes: allNodes });
```

- [ ] **Step 5: Add subscribeToCanvas implementation**

Add the `subscribeToCanvas` action in the store (after `createGovioNode`):

```typescript
  subscribeToCanvas: () => {
    const canvasService = getCanvasService();
    canvasService.subscribe((event) => {
      if (event.type === "govio_node_create") {
        try {
          get().createGovioNode(event);
        } catch (err) {
          console.error("[canvas] createGovioNode error:", err);
        }
      }
    });
  },
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/store/canvas-store.ts
git commit -m "refactor: split canvas subscriptions, remove edge creation"
```

---

### Task 7: Wire subscribeToCanvas in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add useEffect to call subscribeToCanvas**

Read the current App.tsx content, then add a useEffect hook that calls `useCanvasStore.getState().subscribeToCanvas()` on mount. The exact code depends on the current structure, but it should be:

```typescript
import { useEffect } from 'react';
import { useCanvasStore } from './store/canvas-store';

// Inside the App component, before the return:
useEffect(() => {
  useCanvasStore.getState().subscribeToCanvas();
}, []);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire subscribeToCanvas on app mount"
```

---

### Task 8: Delete Sidebar and update AppLayout

**Files:**
- Delete: `src/components/Sidebar/Sidebar.tsx`
- Modify: `src/components/Layout/AppLayout.tsx`

- [ ] **Step 1: Delete Sidebar.tsx**

```bash
rm src/components/Sidebar/Sidebar.tsx
```

- [ ] **Step 2: Rewrite AppLayout.tsx**

Replace the entire file with:

```tsx
import { useState, useCallback } from 'react';
import Header from './Header';
import Canvas from '../Canvas/Canvas';
import ChatPanel from '../Chat/ChatPanel';
import ResizeDivider from './ResizeDivider';

export default function AppLayout() {
  const [chatWidth, setChatWidth] = useState(25);

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((prev) => {
      const deltaPercent = (deltaX / window.innerWidth) * 100;
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

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: remove sidebar, restructure layout to canvas+divider+chat"
```

---

### Task 9: Create ResizeDivider component

**Files:**
- Create: `src/components/Layout/ResizeDivider.tsx`

- [ ] **Step 1: Create ResizeDivider.tsx**

```tsx
import { useCallback, useRef } from 'react';

interface ResizeDividerProps {
  onResize: (deltaX: number) => void;
}

export default function ResizeDivider({ onResize }: ResizeDividerProps) {
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging.current) {
        onResize(e.movementX);
      }
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/50 transition-colors flex-shrink-0"
    />
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/Layout/ResizeDivider.tsx
git commit -m "feat: add ResizeDivider component for chat panel resize"
```

---

### Task 10: Update ChatPanel — full height, remove collapse

**Files:**
- Modify: `src/components/Chat/ChatPanel.tsx`

- [ ] **Step 1: Remove collapsed state and toggle**

Remove the `collapsed` state (line 67) and the collapsed view (lines 96-109).

Remove the collapse button from the header (lines 120-125):
```tsx
        <button
          onClick={() => setCollapsed(true)}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          <ChevronDown size={16} />
        </button>
```

Remove `ChevronDown`, `ChevronUp` from the lucide-react import (line 2).

- [ ] **Step 2: Change container styling**

Change line 112 from:
```tsx
    <div className="h-[320px] bg-bg-primary border-t border-border-default flex flex-col">
```
to:
```tsx
    <div className="h-full bg-bg-primary border-l border-border-default flex flex-col">
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/Chat/ChatPanel.tsx
git commit -m "refactor: ChatPanel full height, remove collapse toggle"
```

---

### Task 11: Build verification

- [ ] **Step 1: Run TypeScript check**

Run: `npm run build`
Expected: No TypeScript errors, build succeeds

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No lint errors

- [ ] **Step 3: Manual verification**

Run: `npm run dev`

Verify:
1. App loads without errors
2. Chat panel appears on right side, ~25% width
3. Canvas fills remaining space
4. Drag divider resizes chat panel (15%–50% range)
5. Send a message → text streams in chat panel
6. No sidebar visible
7. Console shows `[canvas-service] Connected to /canvas`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: dual WebSocket channels + layout redesign complete"
```
