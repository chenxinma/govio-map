import type { ReferencedNode } from "../types";
import { matchQuery } from "./mock-ai";

export interface StreamEvent {
  type: "text_delta" | "message_start" | "message_end" | "tool_start" | "tool_end" | "error" | "thinking_delta";
  content?: string;
  toolName?: string;
  success?: boolean;
}

export interface AIService {
  sendMessage(content: string, refs?: ReferencedNode[]): Promise<void>;
  steer(content: string): Promise<void>;
  followUp(content: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(callback: (event: StreamEvent) => void): () => void;
  isConnected(): boolean;
}

class WebSocketAIService implements AIService {
  private ws: WebSocket | null = null;
  private callbacks: Set<(event: StreamEvent) => void> = new Set();
  private connectPromise: Promise<void> | null = null;

  constructor() {
    this.connect();
  }

  private connect() {
    this.connectPromise = new Promise((resolve) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsPort = parseInt(window.location.port) + 1;
      this.ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

      this.ws.onopen = () => { resolve(); };
      this.ws.onclose = () => { this.connectPromise = null; };
      this.ws.onerror = () => { this.connectPromise = null; };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.callbacks.forEach((cb) => cb(data));
      };
    });
  }

  async sendMessage(content: string, refs?: ReferencedNode[]): Promise<void> {
    if (this.connectPromise) await this.connectPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "prompt", content, referencedNodes: refs }));
  }

  async steer(content: string): Promise<void> {
    if (this.connectPromise) await this.connectPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "steer", content }));
  }

  async followUp(content: string): Promise<void> {
    if (this.connectPromise) await this.connectPromise;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "followUp", content }));
  }

  async abort(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "abort" }));
  }

  subscribe(callback: (event: StreamEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

class MockAIService implements AIService {
  private callbacks: Set<(event: StreamEvent) => void> = new Set();

  async sendMessage(content: string, _refs?: ReferencedNode[]): Promise<void> {
    void _refs;
    this.callbacks.forEach((cb) => cb({ type: "message_start" }));

    const response = matchQuery(content);
    const chars = response.explanation.split("");
    for (const char of chars) {
      await new Promise((r) => setTimeout(r, 20));
      this.callbacks.forEach((cb) => cb({ type: "text_delta", content: char }));
    }

    this.callbacks.forEach((cb) => cb({ type: "message_end" }));
  }

  async steer(_content: string): Promise<void> { void _content; }
  async followUp(_content: string): Promise<void> { void _content; }
  async abort(): Promise<void> {}

  subscribe(callback: (event: StreamEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  isConnected(): boolean { return false; }
}

let instance: AIService | null = null;

export function getAIService(): AIService {
  if (!instance) {
    try {
      instance = new WebSocketAIService();
    } catch {
      instance = new MockAIService();
    }
  }
  return instance;
}
