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
  referencedNodes?: Array<{ nodeId: string; label: string }>;
}

export interface CanvasService {
  subscribe(callback: (event: CanvasEvent) => void): () => void;
  isConnected(): boolean;
}

class WebSocketCanvasService implements CanvasService {
  private ws: WebSocket | null = null;
  private callbacks: Set<(event: CanvasEvent) => void> = new Set();

  constructor() {
    this.connect();
  }

  private connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsPort = parseInt(window.location.port) + 1;
      this.ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/canvas`);

      this.ws.onopen = () => {
        console.log("[canvas-service] Connected to /canvas");
      };
      this.ws.onclose = () => {
        console.log("[canvas-service] Disconnected from /canvas");
      };
      this.ws.onerror = () => {
        console.warn("[canvas-service] Failed to connect to /canvas");
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
    void _callback;
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
