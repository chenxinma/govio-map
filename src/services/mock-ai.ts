let nodeIdCounter = 0;
export function nextId(prefix: string): string {
  nodeIdCounter++;
  return `${prefix}-${nodeIdCounter}`;
}

export function syncCountersFromNodes(nodes: Array<{ id: string }>) {
  for (const node of nodes) {
    const num = parseInt(node.id.split('-')[1], 10);
    if (!isNaN(num) && num > nodeIdCounter) {
      nodeIdCounter = num;
    }
  }
}
