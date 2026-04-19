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

export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
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
