# Edge Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to delete edges by clicking to select and pressing Backspace/Delete.

**Architecture:** Add a `deleteEdges` method to the Zustand store, wire it to ReactFlow's `onEdgesDelete` callback, and add CSS for selected edge visual feedback.

**Tech Stack:** React, @xyflow/react v12, Zustand, Tailwind CSS v4

---

### Task 1: Add `deleteEdges` to the store

**Files:**
- Modify: `src/store/canvas-store.ts:43` (interface) and `src/store/canvas-store.ts:347` (implementation)

- [ ] **Step 1: Add `deleteEdges` to the `CanvasStore` interface**

In `src/store/canvas-store.ts`, add after line 43 (`deleteNodes: ...`):

```ts
  deleteEdges: (edgeIds: string[]) => void;
```

- [ ] **Step 2: Implement `deleteEdges`**

In `src/store/canvas-store.ts`, add after the `deleteNodes` method (after line 347):

```ts
  deleteEdges: (edgeIds) => {
    const idSet = new Set(edgeIds);
    set({ edges: get().edges.filter((e) => !idSet.has(e.id)) });
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `rtk tsc`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
rtk git add src/store/canvas-store.ts
rtk git commit -m "feat: add deleteEdges method to canvas store"
```

---

### Task 2: Wire `onEdgesDelete` on ReactFlow

**Files:**
- Modify: `src/components/Canvas/Canvas.tsx:21-22` (selector) and `src/components/Canvas/Canvas.tsx:49` (prop)

- [ ] **Step 1: Add `deleteEdges` selector**

In `src/components/Canvas/Canvas.tsx`, add after line 21 (`const deleteNodes = ...`):

```ts
  const deleteEdges = useCanvasStore((s) => s.deleteEdges);
```

- [ ] **Step 2: Add `onEdgesDelete` prop to ReactFlow**

In `src/components/Canvas/Canvas.tsx`, add after line 49 (`onNodesDelete={...}`):

```tsx
        onEdgesDelete={(deletedEdges) => deleteEdges(deletedEdges.map((e) => e.id))}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `rtk tsc`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
rtk git add src/components/Canvas/Canvas.tsx
rtk git commit -m "feat: wire onEdgesDelete callback on ReactFlow"
```

---

### Task 3: Add selected edge visual style

**Files:**
- Modify: `src/index.css:62-73` (after existing edge styles)

- [ ] **Step 1: Add selected edge CSS**

In `src/index.css`, add after the `@keyframes dashdraw` block (after line 73):

```css
.react-flow__edge.selected .react-flow__edge-path {
  stroke: #00c573;
  stroke-width: 3;
}
```

- [ ] **Step 2: Verify dev server starts**

Run: `npm run dev`
Expected: Server starts without errors

- [ ] **Step 3: Manual test**

1. Open the canvas in the browser
2. Create two nodes and connect them
3. Click the edge — it should highlight with a brighter green and thicker stroke
4. Press Backspace — the edge should be deleted
5. Verify undo with Ctrl+Z does NOT work (not implemented, expected)

- [ ] **Step 4: Commit**

```bash
rtk git add src/index.css
rtk git commit -m "feat: add selected edge visual style"
```
