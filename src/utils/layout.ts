import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import { Position } from '@xyflow/react';
import { lineageKindOf } from './lineage';

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

/**
 * 真实测量：渲染过的节点取 DOM 实际尺寸（offset* 为布局像素，不受 viewport 缩放影响），
 * 未渲染/无 document（node 环境测试、新建节点尚未上屏）回退 getNodeSize 估算。
 */
function measureNodeSize(nodeId: string): { width: number; height: number } | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`);
  const width = el?.offsetWidth;
  const height = el?.offsetHeight;
  return width && height ? { width, height } : null;
}

function resolveNodeSize(node: Node): { width: number; height: number } {
  return measureNodeSize(node.id) ?? getNodeSize(node);
}

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
  // 新节点尚未渲染（set 之前调用），只能用估算；已渲染节点走 resolveNodeSize 实测
  const size = getNodeSize(newNode);

  const existingRects = existingNodes.map((n) => {
    const s = resolveNodeSize(n);
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
      const srcSize = resolveNodeSize(src);
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
      const nSize = resolveNodeSize(n);
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
      const nSize = resolveNodeSize(n);
      if (n.position.y + nSize.height > maxY) maxY = n.position.y + nSize.height;
      if (n.position.x < minX) minX = n.position.x;
    }
    const candidate = { x: minX, y: maxY + GAP_Y };
    return findNonOverlappingPosition(candidate, size, existingRects, 'down');
  }

  // Empty canvas
  return { x: 100, y: 100 };
}

/**
 * 方案B后处理：语义边不参与 dagre 分层，语义同伴对齐同列、按语义方向纵向堆叠
 * （源在上、目标在下，配 Handle 下出上入，线走节点间隙不穿节点）。
 * 数据边优先：接入数据边的节点位置冻结，纯语义节点移动去迁就它；
 * 无数据锚的组件以 source-most 成员的 dagre 原位为种子向下发散。
 */
function alignSemanticPeers(nodes: Node[], dataEdges: Edge[], semanticEdges: Edge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sem = semanticEdges.filter(
    (e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target),
  );
  if (sem.length === 0) return;

  const dataInvolved = new Set<string>();
  for (const e of dataEdges) {
    dataInvolved.add(e.source);
    dataInvolved.add(e.target);
  }

  const push = (map: Map<string, string[]>, key: string, val: string): void => {
    const arr = map.get(key);
    if (arr) arr.push(val);
    else map.set(key, [val]);
  };
  const outAdj = new Map<string, string[]>();
  const inAdj = new Map<string, string[]>();
  for (const e of sem) {
    push(outAdj, e.source, e.target);
    push(inAdj, e.target, e.source);
  }

  // 并查集：语义边连通分量
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const e of sem) {
    const rs = find(e.source);
    const rt = find(e.target);
    if (rs !== rt) parent.set(rs, rt);
  }
  const components = new Map<string, Set<string>>();
  for (const e of sem) {
    const root = find(e.source);
    let set = components.get(root);
    if (!set) {
      set = new Set();
      components.set(root, set);
    }
    set.add(e.source);
    set.add(e.target);
  }

  const rectOf = (n: Node): { x: number; y: number; w: number; h: number } => {
    const s = resolveNodeSize(n);
    return { x: n.position.x, y: n.position.y, w: s.width, h: s.height };
  };

  for (const members of components.values()) {
    if (members.size < 2) continue;
    const placed = new Set<string>();
    // 阶段1：数据边节点冻结（数据优先，不移动）
    for (const id of members) {
      if (dataInvolved.has(id)) placed.add(id);
    }
    let queue = [...placed];

    // 无数据锚的组件：取 source-most 成员（无组内入边）保持 dagre 原位作种子
    if (queue.length === 0) {
      const seed =
        [...members].find((id) => !(inAdj.get(id) ?? []).some((m) => members.has(m))) ??
        members.values().next().value!;
      placed.add(seed);
      queue = [seed];
    }

    // 阶段2：BFS 放置其余成员（锚点向发散，迁就已定位邻居）
    while (queue.length > 0) {
      const p = queue.shift()!;
      const pn = byId.get(p)!;
      const ps = resolveNodeSize(pn);
      const place = (m: string, below: boolean): void => {
        const n = byId.get(m)!;
        const size = resolveNodeSize(n);
        const x = pn.position.x + (ps.width - size.width) / 2;
        const y = below
          ? pn.position.y + ps.height + GAP_Y
          : pn.position.y - GAP_Y - size.height;
        // 避让只对照已定位节点（未放置的成员稍后自己迁就），冲突向下顺延
        const occupied = nodes
          .filter((o) => o.id !== m && (!members.has(o.id) || placed.has(o.id)))
          .map(rectOf);
        n.position = findNonOverlappingPosition({ x, y }, size, occupied, 'down');
      };
      for (const m of outAdj.get(p) ?? []) {
        if (!members.has(m) || placed.has(m)) continue;
        placed.add(m);
        queue.push(m);
        place(m, true); // p→m：m 放 p 下方
      }
      for (const m of inAdj.get(p) ?? []) {
        if (!members.has(m) || placed.has(m)) continue;
        placed.add(m);
        queue.push(m);
        place(m, false); // m→p：m 放 p 上方
      }
    }
  }
}

/**
 * 全局排版（方案B）：dagre 只按**数据血缘边**做 LR 分层（数据定列序），
 * 语义血缘边不参与分层，由 alignSemanticPeers 同列纵向堆叠；尺寸实测优先。
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'LR'
): { nodes: Node[]; edges: Edge[] } {
  const dataEdges = edges.filter((e) => lineageKindOf(e) !== 'semantic');
  const semanticEdges = edges.filter((e) => lineageKindOf(e) === 'semantic');

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
    const size = resolveNodeSize(node);
    dagreGraph.setNode(node.id, size);
  });

  // 语义边不进 dagre：否则语义同伴会被强制推到相邻列，破坏同列堆叠
  dataEdges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const size = resolveNodeSize(node);
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

  alignSemanticPeers(layoutedNodes, dataEdges, semanticEdges);

  return { nodes: layoutedNodes, edges };
}
