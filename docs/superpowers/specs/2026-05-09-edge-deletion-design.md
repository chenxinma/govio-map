# Edge Deletion on Canvas

**Date:** 2026-05-09

## Problem

Users cannot visually delete edges (connections between nodes) on the canvas. While ReactFlow's default Backspace key technically works through the generic `onEdgesChange` path, there is no visual feedback for edge selection and no dedicated deletion logic.

## Design

### UX: Click to select + Backspace/Delete

- Click an edge to select it (visual highlight)
- Press Backspace or Delete to remove it
- Consistent with how node deletion already works

### Changes

**1. Store: `deleteEdges` method** (`src/store/canvas-store.ts`)

```ts
deleteEdges: (edgeIds: string[]) => {
  const idSet = new Set(edgeIds);
  set({ edges: get().edges.filter((e) => !idSet.has(e.id)) });
},
```

No additional cleanup needed — edges don't have associated preview panels or referenced nodes.

**2. Canvas: Wire `onEdgesDelete`** (`src/components/Canvas/Canvas.tsx`)

```tsx
onEdgesDelete={(deletedEdges) => deleteEdges(deletedEdges.map((e) => e.id))}
```

**3. Selected edge style** (`src/index.css`)

Add a selected state so users see which edge is active before deleting:

```css
.react-flow__edge.selected .react-flow__edge-path {
  stroke: #00c573;
  stroke-width: 3;
}
```

Uses the existing `--color-brand-link` (#00c573) for consistency with the design system.

## Files to modify

| File | Change |
|------|--------|
| `src/store/canvas-store.ts` | Add `deleteEdges` method |
| `src/components/Canvas/Canvas.tsx` | Add `onEdgesDelete` prop |
| `src/index.css` | Add `.react-flow__edge.selected` style |
