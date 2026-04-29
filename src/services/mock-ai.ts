let nodeIdCounter = 0;
export function nextId(prefix: string): string {
  nodeIdCounter++;
  return `${prefix}-${nodeIdCounter}`;
}

export function resetIdCounter() {
  nodeIdCounter = 0;
}
