# Govio Map - 项目概述

## 定位

无限画布数据治理工具。通过自然语言指令生成数据查询逻辑，以可视化卡片形式在画布上编排数据血缘关系。

## 核心能力

1. **自然语言驱动**：用户在 Chat 面板输入指令，AI Agent 生成 SQL、加载数据、分析比较
2. **可视化血缘编排**：在 ReactFlow 画布上以节点+连线形式展示数据处理流水线
3. **节点引用上下文**：用户可引用画布节点到对话中，AI 基于上下文生成下游节点
4. **实时预览**：DataFrame 节点支持浮窗预览 parquet 数据

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript |
| 构建 | Vite 8 |
| 画布 | @xyflow/react (ReactFlow) |
| 状态 | Zustand 5 (persist middleware) |
| 布局 | @dagrejs/dagre |
| 样式 | Tailwind CSS 4 |
| 图标 | Lucide React |
| AI Agent | @mariozechner/pi-coding-agent |
| 通信 | WebSocket (ws) |
| 数据预览 | hyparquet (parquet 文件读取) |

## 模块划分

```
┌─────────────────────────────────────────────────┐
│  Layout (Header + 三栏布局)                       │
│  ┌──────────────┬──┬───────────┐                │
│  │  Canvas      │R │  Chat     │                │
│  │  (ReactFlow) │e │  Panel    │                │
│  │              │s │  (WS)     │                │
│  │  Nodes       │i │  Input    │                │
│  │  Toolbar     │z │  Messages │                │
│  │  Preview     │e │           │                │
│  └──────────────┴──┴───────────┘                │
└─────────────────────────────────────────────────┘

前端 Store:  canvas-store (Zustand)
前端 Hooks:  useChat, useChatContext, useCommands
前端服务:    canvas-service, mock-ai
前端工具:    layout (dagre)

后端 Server:  Vite Plugin (独立端口)
后端 WebSocket: ws-handler (双端点: /ws, /canvas)
后端 Agent:   agent.ts (pi-coding-agent session)
后端扩展:     govio-canvas.ts (工具注册 + 事件拦截)
后端队列:     govio-node-queue.ts (批量节点事件)
后端 API:     parquet-api.ts (/api/preview)
```

## 数据流向

```
用户输入指令
  │
  ▼
ChatPanel → useChat → WebSocket /ws → ws-handler
  │                                        │
  │                                        ▼
  │                                  agent.prompt()
  │                                        │
  │                                        ▼
  │                                  pi-coding-agent 执行
  │                                  (调用 bash/govio-cli 工具)
  │                                        │
  │                              ┌─────────┼─────────┐
  │                              ▼         ▼         ▼
  │                         tool_result  message_end  govio_create_source_table
  │                              │         │              │
  │                              ▼         ▼              ▼
  │                         govio-canvas extension 拦截
  │                              │
  │                              ▼
  │                         pushGovioNode() → queue
  │                              │
  │                              ▼ (tool_end / message_end 时 flush)
  │                         emitFlushed → onGovioNodesFlushed
  │                              │
  │                              ▼
  │                         WebSocket /canvas → canvas-service
  │                              │
  ▼                              ▼
ChatMessage 渲染流式内容    canvas-store.createGovioNode()
                              │
                              ▼
                         Canvas 渲染新节点 + 连线
```

## 运行方式

```bash
npm run dev
# Vite 前端: http://localhost:5173/
# WebSocket: ws://localhost:5174/ws  (port+1)
# Canvas WS: ws://localhost:5174/canvas
# Parquet API: http://localhost:5174/api/preview
```

后端作为 Vite 插件运行，在 Vite dev server 启动时通过 `configureServer` 钩子创建独立 HTTP 服务器，端口为 Vite 端口 +1。

## 设计规范

暗色主题，基于 Supabase 设计系统：

- 背景：`#171717`，最深 `#0f0f0f`
- 品牌色：`#3ecf8e`（绿色，仅用于标识和连线）
- 层级区分通过边框颜色（`#242424` → `#2e2e2e` → `#363636`），不用 box-shadow
- 字重仅用 400（正文）和 500（交互元素）
