import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import { Position } from '@xyflow/react';

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

function getNodeSize(node: Node): { width: number; height: number } {
  switch (node.type) {
    case 'sourceTable':
      return { width: 280, height: 240 };
    case 'sqlQuery':
      return { width: 300, height: 280 };
    case 'dataFrame':
      return { width: 320, height: 300 };
    case 'report':
      return { width: 380, height: 340 };
    default:
      return { width: 280, height: 200 };
  }
}

const GAP_X = 80;
const GAP_Y = 40;

function getNodeType(node: Node): string {
  return (node.data as Record<string, unknown>)?.type as string || node.type || 'default';
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function findNonOverlappingPosition(
  candidate: { x: number; y: number },
  size: { width: number; height: number },
  existingRects: Array<{ x: number; y: number; w: number; h: number }>,
  direction: 'down' | 'right',
): { x: number; y: number } {
  let pos = { ...candidate };
  let attempts = 0;
  const maxAttempts = 50;

  while (attempts < maxAttempts) {
    const rect = { x: pos.x, y: pos.y, w: size.width, h: size.height };
    const overlap = existingRects.some((r) => rectsOverlap(rect, r));
    if (!overlap) return pos;

    if (direction === 'down') {
      pos = { x: pos.x, y: pos.y + size.height + GAP_Y };
    } else {
      pos = { x: pos.x + size.width + GAP_X, y: pos.y };
    }
    attempts++;
  }

  return pos;
}

/**
 * Position a single new node without moving existing nodes.
 * - Independent node (no edges): place below same-type nodes
 * - Connected node: place to the right of source nodes
 */
export function positionNewNode(
  existingNodes: Node[],
  newNode: Node,
  newEdges: Edge[],
): { x: number; y: number } {
  const size = getNodeSize(newNode);

  const existingRects = existingNodes.map((n) => {
    const s = getNodeSize(n);
    return { x: n.position.x, y: n.position.y, w: s.width, h: s.height };
  });

  // Find edges where the new node is the target
  const incomingEdges = newEdges.filter((e) => e.target === newNode.id);
  const sourceIds = new Set(incomingEdges.map((e) => e.source));
  const sourceNodes = existingNodes.filter((n) => sourceIds.has(n.id));

  if (sourceNodes.length > 0) {
    // Connected: place to the right of the rightmost source node
    let rightmostX = -Infinity;
    let avgY = 0;
    for (const src of sourceNodes) {
      const srcSize = getNodeSize(src);
      const rightEdge = src.position.x + srcSize.width;
      if (rightEdge > rightmostX) rightmostX = rightEdge;
      avgY += src.position.y;
    }
    avgY /= sourceNodes.length;

    const candidate = { x: rightmostX + GAP_X, y: avgY };
    return findNonOverlappingPosition(candidate, size, existingRects, 'down');
  }

  // Independent: place below same-type nodes
  const newType = getNodeType(newNode);
  const sameTypeNodes = existingNodes.filter((n) => getNodeType(n) === newType);

  if (sameTypeNodes.length > 0) {
    let bottomY = -Infinity;
    let xOfBottom = 0;
    for (const n of sameTypeNodes) {
      const nSize = getNodeSize(n);
      const bottomEdge = n.position.y + nSize.height;
      if (bottomEdge > bottomY) {
        bottomY = bottomEdge;
        xOfBottom = n.position.x;
      }
    }
    const candidate = { x: xOfBottom, y: bottomY + GAP_Y };
    return findNonOverlappingPosition(candidate, size, existingRects, 'down');
  }

  // No same-type nodes: place at the bottom-left of all nodes
  if (existingNodes.length > 0) {
    let maxY = -Infinity;
    let minX = Infinity;
    for (const n of existingNodes) {
      const nSize = getNodeSize(n);
      if (n.position.y + nSize.height > maxY) maxY = n.position.y + nSize.height;
      if (n.position.x < minX) minX = n.position.x;
    }
    const candidate = { x: minX, y: maxY + GAP_Y };
    return findNonOverlappingPosition(candidate, size, existingRects, 'down');
  }

  // Empty canvas
  return { x: 100, y: 100 };
}

export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
  // Clear stale state from previous layout calls
  dagreGraph.nodes().forEach((id) => dagreGraph.removeNode(id));

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 40,
    ranksep: 140,
    edgesep: 30,
    ranker: 'network-simplex',
  });

  nodes.forEach((node) => {
    const size = getNodeSize(node);
    dagreGraph.setNode(node.id, size);
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const size = getNodeSize(node);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - size.width / 2,
        y: nodeWithPosition.y - size.height / 2,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });

  return { nodes: layoutedNodes, edges };
}
