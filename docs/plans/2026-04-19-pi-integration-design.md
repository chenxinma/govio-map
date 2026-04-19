# pi-coding-agent 集成设计方案

## 目标

将 `@mariozechner/pi-coding-agent` SDK 集成到 govio-map 项目，替换现有 mock AI，实现基于 WebSocket 的实时 Chat 交互。

## 架构方案

Vite 中间件 + 单进程方案。利用 Vite dev server 同时服务前端和 WebSocket，共享一个 package.json。

## 目录结构

```
govio-map/
├── server/
│   ├── agent.ts               # pi session 创建与管理
│   ├── ws-handler.ts          # WebSocket 消息处理
│   └── index.ts               # 入口，供 vite.config.ts 引用
├── src/
│   ├── services/
│   │   ├── ai-service.ts      # 统一 AI 接口（WebSocket/mock 切换）
│   │   └── mock-ai.ts         # 保留，fallback 用
│   ├── store/
│   │   └── canvas-store.ts    # 修改 sendMessage 调用 ai-service
│   └── components/
│       └── Chat/
│           └── ChatPanel.tsx   # 增加流式输出支持
├── vite.config.ts             # 添加 WebSocket 中间件
└── package.json               # 添加 pi-coding-agent, ws 依赖
```

## WebSocket 协议

### 客户端 → 服务端

```json
{ "type": "prompt", "content": "用户消息", "referencedNodes": [...] }
{ "type": "steer", "content": "调整指令" }
{ "type": "followUp", "content": "追加问题" }
{ "type": "abort" }
```

### 服务端 → 客户端

```json
{ "type": "text_delta", "content": "流式文本片段" }
{ "type": "tool_start", "toolName": "..." }
{ "type": "tool_end", "toolName": "...", "success": true }
{ "type": "message_start" }
{ "type": "message_end", "fullContent": "完整回复" }
{ "type": "error", "message": "错误信息" }
{ "type": "session_ready", "sessionId": "..." }
```

## 前端服务层

统一接口，WebSocket 优先，mock fallback：

```typescript
export interface AIService {
  sendMessage(content: string, refs?: ReferencedNode[]): Promise<void>;
  steer(content: string): Promise<void>;
  followUp(content: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(callback: (event: StreamEvent) => void): () => void;
  isConnected(): boolean;
}

export function createAIService(): AIService {
  const ws = new WebSocketAIService();
  if (ws.isConnected()) return ws;
  return new MockAIService();
}
```

`canvas-store.ts` 中的 `sendMessage` 改为调用 `aiService.sendMessage()`，通过 subscribe 接收流式事件更新 messages。

## 后端 Agent 管理

- 使用 `readOnlyTools`（read, grep, find, ls），不做文件修改
- `inMemory` session，不持久化
- 可后续扩展 custom tools 来操作 canvas 节点

## Vite 集成

- Vite dev server 启动时初始化 agent session
- WebSocket 挂载在 `/ws` 路径
- 开发时单命令 `npm run dev` 启动全部

## 数据流

```
用户输入 → ChatPanel → canvas-store.sendMessage()
  → ai-service.sendMessage() → WebSocket → server/ws-handler
  → session.prompt(content) → pi-coding-agent
  → subscribe events → WebSocket 推送 → ai-service callback
  → canvas-store 更新 messages/nodes
```
