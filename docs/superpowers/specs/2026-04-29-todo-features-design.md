# TODO Features Design Spec

Three features from `docs/TODO.json`: Card Reference, Restore Canvas, Manual SQL Query.

---

## Feature 1: Card Reference (卡片引用)

**Goal:** Click a node's "引用" button to attach it as context to the next chat message. The referenced node's icon + name appear as chips above the chat input. On send, references are included in the WebSocket message.

### Data Flow

1. User clicks "引用" on any node → `addReference(nodeId)` stores `ReferencedNode { nodeId, label, type }`
2. `ChatInput` reads `referencedNodes` from store, renders chips above textarea
3. User types message and sends → `onSend(content, referencedNodes)`
4. `useChat.send()` includes `referencedNodes` in the WS JSON payload
5. Server `WSMessage` already has `referencedNodes` field — no server changes

### Store Changes (`canvas-store.ts`)

```ts
interface CanvasStore {
  // ... existing
  referencedNodes: ReferencedNode[];
  addReference: (nodeId: string) => void;
  removeReference: (nodeId: string) => void;
  clearReferences: () => void;
}
```

`addReference` looks up the node by ID, extracts `{ nodeId, label (from data.title), type (from data.type) }`, appends to list. Deduplicates by `nodeId`.

### ChatInput Changes

- New prop: `referencedNodes: ReferencedNode[]`, `onRemoveReference: (nodeId: string) => void`
- Render chips above the textarea: icon (based on type) + label + × button
- Style: dark chip (#242424 bg, #2e2e2e border, 6px radius), icon color matches node type

### useChat Changes

- `send(content: string, referencedNodes?: ReferencedNode[])` includes `referencedNodes` in the JSON payload when non-empty
- Message type stays `prompt` or `steer` — `referencedNodes` is an additional field

### Node Icon Mapping

| NodeType | Icon | Color |
|----------|------|-------|
| sourceTable | Database | purple |
| sqlQuery | Code | green |
| dataFrame | Table2 | orange |
| report | FileText | amber |

---

## Feature 2: Restore Canvas (恢复画布)

**Goal:** A reload button on the canvas that syncs with the backend. Runs `govio-cli observe list` to get loaded dataframes, then adds any missing ones to the canvas.

### Data Flow

1. User clicks reload button in canvas toolbar
2. Client sends `{ type: 'observe_list' }` via existing WebSocket (`/ws`)
3. Server runs `govio-cli observe list`, parses output
4. Server responds with `{ type: 'observe_list_result', dataframes: [...] }`
5. Client compares returned dataframe names with existing `dataFrame` nodes on canvas
6. Missing dataframes are created as new `dataFrame` nodes via `createGovioNode()`
7. Auto-layout runs after adding new nodes

### Server Changes (`ws-handler.ts`)

Handle new message type `observe_list`:
```ts
case 'observe_list': {
  const { execSync } = require('child_process');
  const output = execSync('govio-cli observe list', { encoding: 'utf-8' });
  const dataframes = JSON.parse(output); // expects array of { dfName, ... }
  ws.send(JSON.stringify({ type: 'observe_list_result', dataframes }));
  break;
}
```

Error handling: wrap in try/catch, send `{ type: 'error', message: '...' }` on failure.

### Client Changes (`useChat.ts`)

- Add `observeList()` function that sends `{ type: 'observe_list' }`
- Handle `observe_list_result` event → callback to store

### Store Changes (`canvas-store.ts`)

- Add `restoreCanvas(dataframes)` action
- Filter out dataframes whose `dfName` already exists as a `dataFrame` node
- Create missing nodes via `createGovioNode()` pattern
- Run `autoLayout()` after adding

### UI Changes (`Canvas.tsx`)

- Add floating toolbar with reload button (top-right, near ReactFlow Controls)
- Style: dark button per DESIGN.md (#0f0f0f bg, #2e2e2e border, 6px radius)
- Icon: `RefreshCw` from lucide-react
- Show loading spinner while waiting for response

---

## Feature 3: Manual SQL Query (手工SQLQuery)

**Goal:** A SQL button on the canvas toolbar that creates an editable SQLQuery card directly, without going through the agent.

### Data Flow

1. User clicks SQL button in canvas toolbar
2. New `sqlQuery` node created with empty SQL and "New Query" title
3. SQL area in the card is an editable textarea
4. User edits SQL inline → saved on blur or Ctrl+Enter
5. Node data updates in the store

### Store Changes (`canvas-store.ts`)

- Add `createManualSQLNode()` action
- Creates a `sqlQuery` node with: `{ type: 'sqlQuery', title: 'New Query', sql: '', outputColumns: [], createdAt: Date.now() }`
- Uses `nextId('sql')` for ID generation
- Runs `autoLayout()` after creation

### SQLQueryNode Changes (`SQLQueryNode.tsx`)

- Detect if `sql` is empty or node is newly created → show editable textarea instead of static preview
- Textarea: dark styled (#171717 bg, monospace font, auto-expanding)
- Ctrl+Enter or blur to save → update node data in store
- Visual indicator: green border pulse or "editable" badge while editing

### Store: Node Data Update

- Add `updateNodeData(nodeId: string, data: Partial<CanvasNodeData>)` action
- Uses `setNodes(nodes => nodes.map(n => n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n))`

---

## Toolbar Design

A new `CanvasToolbar` component floating near the top-right of the canvas, styled per DESIGN.md:

- Container: `#171717` bg, `1px solid #2e2e2e` border, 8px radius, 4px padding
- Buttons: `#0f0f0f` bg, `#fafafa` text, 6px radius, 8px padding, 14px Circular weight 500
- Hover: border lightens to `#363636`
- Active/loading: green accent border `rgba(62, 207, 142, 0.3)`
- Gap between buttons: 4px
- Icons: 16px, lucide-react

Buttons:
1. **SQL** (Code icon) — create manual SQL query
2. **Reload** (RefreshCw icon) — restore canvas from backend

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `src/store/canvas-store.ts` | Add `referencedNodes`, `addReference`, `removeReference`, `clearReferences`, `restoreCanvas`, `createManualSQLNode`, `updateNodeData` |
| `src/components/Chat/ChatInput.tsx` | Show reference chips, new props |
| `src/components/Chat/ChatPanel.tsx` | Wire references from store |
| `src/hooks/useChat.ts` | `send()` with refs, `observeList()`, handle `observe_list_result` |
| `src/components/Canvas/Canvas.tsx` | Add CanvasToolbar with SQL + Reload buttons |
| `src/components/Canvas/CanvasToolbar.tsx` | New component: floating toolbar |
| `src/components/Nodes/SQLQueryNode.tsx` | Inline SQL editing |
| `server/ws-handler.ts` | Handle `observe_list` message |

## No Changes Needed

- `src/types/index.ts` — `ReferencedNode` already defined, `SQLQueryNodeData` already has `sql`
- `server/agent.ts` — no changes
- `server/extensions/` — no changes
- Node components (SourceTable, DataFrame, Report) — "引用" buttons already call `addReference`, just need the store method to exist
