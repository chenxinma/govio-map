# pi-coding-agent 集成实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 pi-coding-agent SDK 集成到 govio-map，通过 WebSocket 实现前端 Chat 与后端 Agent 的实时交互

**Architecture:** Vite 中间件方案，单 package.json，WebSocket 双向通信，mock fallback

**Tech Stack:** TypeScript, React, Vite, WebSocket (ws), pi-coding-agent, Zustand

---

## Task 1: 安装依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装 pi-coding-agent 和 ws**

Run: `npm install @mariozechner/pi-coding-agent ws`
Expected: 安装成功，package.json 新增两个依赖

**Step 2: 安装 ws 类型定义**

Run: `npm install -D @types/ws`
Expected: 安装成功

**Step 3: 验证安装**

Run: `npm ls @mariozechner/pi-coding-agent ws`
Expected: 显示已安装的版本

---

## Task 2: 创建后端 Agent 管理模块

**Files:**
- Create: `server/agent.ts`

**Step 1: 创建 server 目录**

Run: `mkdir server`
Expected: 目录创建成功

**Step 2: 编写 agent.ts**

```typescript
import { createAgentSession, SessionManager, readOnlyTools, type AgentSession } from "@mariozechner/pi-coding-agent";

let session: AgentSession | null = null;

export async function getOrCreateSession(): Promise<AgentSession> {
  if (session) return session;

  const result = await createAgentSession({
    tools: readOnlyTools,
    sessionManager: SessionManager.inMemory(),
  });

  session = result.session;
  return session;
}

export function getSession(): AgentSession | null {
  return session;
}
```

**Step 3: 验证编译**

Run: `npx tsc server/agent.ts --noEmit --esModuleInterop --moduleResolution node --module esnext --target esnext`
Expected: 无编译错误

---

## Task 3: 创建 WebSocket 处理模块

**Files:**
- Create: `server/ws-handler.ts`

**Step 1: 编写 ws-handler.ts**

```typescript
import { WebSocketServer, WebSocket } from "ws";
import { getOrCreateSession } from "./agent.js";

interface WSMessage {
  type: "prompt" | "steer" | "followUp" | "abort";
  content?: string;
  referencedNodes?: Array<{ nodeId: string; label: string; type: string }>;
}

export function setupWebSocket(server: any) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws: WebSocket) => {
    try {
      const session = await getOrCreateSession();

      ws.send(JSON.stringify({ type: "session_ready", sessionId: session.sessionId }));

      const unsubscribe = session.subscribe((event) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        switch (event.type) {
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              ws.send(JSON.stringify({ type: "text_delta", content: event.assistantMessageEvent.delta }));
            }
            break;
          case "tool_execution_start":
            ws.send(JSON.stringify({ type: "tool_start", toolName: event.toolName }));
            break;
          case "tool_execution_end":
            ws.send(JSON.stringify({ type: "tool_end", toolName: event.toolName, success: !event.isError }));
            break;
          case "message_start":
            ws.send(JSON.stringify({ type: "message_start" }));
            break;
          case "message_end":
            ws.send(JSON.stringify({ type: "message_end" }));
            break;
          case "agent_end":
            break;
        }
      });

      ws.on("message", async (data: Buffer) => {
        try {
          const msg: WSMessage = JSON.parse(data.toString());

          switch (msg.type) {
            case "prompt":
              if (msg.content) {
                if (session.isStreaming) {
                  await session.steer(msg.content);
                } else {
                  await session.prompt(msg.content);
                }
              }
              break;
            case "steer":
              if (msg.content) await session.steer(msg.content);
              break;
            case "followUp":
              if (msg.content) await session.followUp(msg.content);
              break;
            case "abort":
              await session.abort();
              break;
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: String(err) }));
        }
      });

      ws.on("close", () => {
        unsubscribe();
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `Session init failed: ${err}` }));
      ws.close();
    }
  });

  return wss;
}
```

**Step 2: 验证编译**

Run: `npx tsc server/ws-handler.ts --noEmit --esModuleInterop --moduleResolution node --module esnext --target esnext`
Expected: 无编译错误

---

## Task 4: 创建服务入口和 Vite 插件

**Files:**
- Create: `server/index.ts`
- Modify: `vite.config.ts`

**Step 1: 编写 server/index.ts**

```typescript
import { createServer } from "http";
import { setupWebSocket } from "./ws-handler.js";
import type { Plugin } from "vite";

let httpServer: ReturnType<typeof createServer> | null = null;

export function wsPlugin(): Plugin {
  return {
    name: "ws-plugin",
    configureServer(server) {
      httpServer = createServer();
      setupWebSocket(httpServer);

      server.httpServer?.on("listening", () => {
        const address = server.httpServer?.address();
        if (address && typeof address === "object") {
          httpServer?.listen(address.port + 1, () => {
            console.log(`[ws] WebSocket server on port ${address.port + 1}`);
          });
        }
      });
    },
  };
}
```

**Step 2: 修改 vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { wsPlugin } from './server/index.js';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wsPlugin(),
  ],
  server: {
    port: 5173,
  },
});
```

**Step 3: 验证 dev server 启动**

Run: `npm run dev`
Expected: Vite 启动成功，WebSocket server 在相邻端口启动

---

## Task 5: 创建前端 AI 服务层

**Files:**
- Create: `src/services/ai-service.ts`

**Step 1: 定义接口和类型**

```typescript
import type { ReferencedNode } from "../types";

export interface StreamEvent {
  type: "text_delta" | "message_start" | "message_end" | "tool_start" | "tool_end" | "error";
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
```

**Step 2: 实现 WebSocket 服务**

```typescript
class WebSocketAIService implements AIService {
  private ws: WebSocket | null = null;
  private callbacks: Set<(event: StreamEvent) => void> = new Set();
  private connected = false;

  constructor() {
    this.connect();
  }

  private connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = parseInt(window.location.port) + 1;
    this.ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

    this.ws.onopen = () => { this.connected = true; };
    this.ws.onclose = () => { this.connected = false; };
    this.ws.onerror = () => { this.connected = false; };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.callbacks.forEach((cb) => cb(data));
    };
  }

  async sendMessage(content: string, refs?: ReferencedNode[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "prompt", content, referencedNodes: refs }));
  }

  async steer(content: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");
    this.ws.send(JSON.stringify({ type: "steer", content }));
  }

  async followUp(content: string): Promise<void> {
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
    return this.connected;
  }
}
```

**Step 3: 实现 Mock 服务和工厂函数**

```typescript
import { matchQuery, generateDataFrame, generateReport, nextId } from "./mock-ai";

class MockAIService implements AIService {
  private callbacks: Set<(event: StreamEvent) => void> = new Set();

  async sendMessage(content: string, refs?: ReferencedNode[]): Promise<void> {
    this.callbacks.forEach((cb) => cb({ type: "message_start" }));

    // 模拟流式输出
    const response = matchQuery(content);
    const words = response.explanation.split("");
    for (const char of words) {
      await new Promise((r) => setTimeout(r, 20));
      this.callbacks.forEach((cb) => cb({ type: "text_delta", content: char }));
    }

    this.callbacks.forEach((cb) => cb({ type: "message_end" }));
  }

  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async abort(): Promise<void> {}

  subscribe(callback: (event: StreamEvent) => void): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  isConnected(): boolean { return true; }
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
```

**Step 4: 验证编译**

Run: `npx tsc src/services/ai-service.ts --noEmit --jsx react-jsx --esModuleInterop --moduleResolution bundler --module esnext --target esnext --strict`
Expected: 无编译错误

---

## Task 6: 修改 canvas-store 集成 AI 服务

**Files:**
- Modify: `src/store/canvas-store.ts`

**Step 1: 导入 ai-service**

在文件顶部添加:
```typescript
import { getAIService, type StreamEvent } from "../services/ai-service";
```

**Step 2: 添加 streaming 相关状态**

在 CanvasStore 接口中添加:
```typescript
isStreaming: boolean;
streamingContent: string;
```

在初始状态中添加:
```typescript
isStreaming: false,
streamingContent: "",
```

**Step 3: 替换 sendMessage 实现**

将现有的 mock 逻辑替换为:

```typescript
sendMessage: async (content) => {
  const { messages, referencedNodes, isStreaming } = get();
  if (isStreaming) return;

  const userMsg: ChatMessage = {
    id: nextId("msg"),
    role: "user",
    content,
    timestamp: new Date().toISOString(),
    nodePreviews: referencedNodes.length > 0
      ? referencedNodes.map((r) => ({ id: r.nodeId, type: r.type, label: r.label }))
      : undefined,
  };

  set({
    messages: [...messages, userMsg],
    referencedNodes: [],
    isStreaming: true,
    streamingContent: "",
  });

  const aiService = getAIService();

  if (!aiService.isConnected()) {
    // fallback 到 mock
    // 保留原有 mock 逻辑...
    set({ isStreaming: false });
    return;
  }

  let fullContent = "";

  const unsubscribe = aiService.subscribe((event: StreamEvent) => {
    switch (event.type) {
      case "text_delta":
        fullContent += event.content || "";
        set({ streamingContent: fullContent });
        break;
      case "message_end":
        const aiMsg: ChatMessage = {
          id: nextId("msg"),
          role: "assistant",
          content: fullContent,
          timestamp: new Date().toISOString(),
        };
        set({
          messages: [...get().messages, aiMsg],
          isStreaming: false,
          streamingContent: "",
        });
        unsubscribe();
        break;
      case "error":
        set({ isStreaming: false, streamingContent: "" });
        unsubscribe();
        break;
    }
  });

  await aiService.sendMessage(content, referencedNodes);
},
```

**Step 4: 验证类型**

Run: `npx tsc --noEmit`
Expected: 无类型错误

---

## Task 7: 修改 ChatPanel 支持流式输出

**Files:**
- Modify: `src/components/Chat/ChatPanel.tsx`

**Step 1: 添加流式状态读取**

```typescript
const isStreaming = useCanvasStore((s) => s.isStreaming);
const streamingContent = useCanvasStore((s) => s.streamingContent);
```

**Step 2: 在消息列表末尾添加流式消息**

```tsx
{isStreaming && streamingContent && (
  <div className="flex justify-start mb-3">
    <div className="max-w-[85%]">
      <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-brand mb-1">
        AI Assistant
      </div>
      <div className="rounded-lg px-3 py-2 text-sm leading-relaxed bg-bg-surface text-text-secondary border border-border-subtle">
        {streamingContent}
        <span className="inline-block w-1.5 h-4 ml-0.5 bg-brand/60 animate-pulse" />
      </div>
    </div>
  </div>
)}
```

**Step 3: 禁用发送按钮（流式中）**

```tsx
disabled={(!input.trim() && referencedNodes.length === 0) || isStreaming}
```

**Step 4: 验证 UI**

Run: `npm run dev`
Expected: 流式输出时有光标动画，按钮禁用

---

## Task 8: 端到端验证

**Step 1: 启动 dev server**

Run: `npm run dev`
Expected: Vite 和 WebSocket 均启动

**Step 2: 测试 Chat 交互**

- 在 ChatPanel 输入消息
- 验证 WebSocket 连接建立
- 验证流式输出正常显示
- 验证 mock fallback 正常

**Step 3: 运行 lint**

Run: `npm run lint`
Expected: 无 lint 错误

**Step 4: 运行 build**

Run: `npm run build`
Expected: 构建成功

---

## 总结

| Task | 描述 | 依赖 |
|------|------|------|
| 1 | 安装依赖 | 无 |
| 2 | 创建 agent.ts | Task 1 |
| 3 | 创建 ws-handler.ts | Task 2 |
| 4 | 创建 index.ts + 修改 vite.config | Task 3 |
| 5 | 创建 ai-service.ts | 无 |
| 6 | 修改 canvas-store.ts | Task 5 |
| 7 | 修改 ChatPanel.tsx | Task 6 |
| 8 | 端到端验证 | 全部 |
