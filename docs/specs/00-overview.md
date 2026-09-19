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
| 图表 | Plotly.js (plotly.js-dist-min) |
| AI Agent | @earendil-works/pi-coding-agent |
| 子 Agent | pi-subagents (项目 npm 依赖) |
| 通信 | WebSocket (ws) |
| 数据预览 | hyparquet (parquet 文件读取) |
| 桌面端 | Electron |

## 模块划分

```
┌─────────────────────────────────────────────────┐
│  Layout (Header + 两栏布局)                       │
│  ┌──────────────┬──┬───────────┐                │
│  │  Canvas      │R │  Chat     │                │
│  │  (ReactFlow) │e │  Panel    │                │
│  │              │s │  (WS)     │                │
│  │  Nodes       │i │  Input    │                │
│  │  Toolbar     │z │  Messages │                │
│  │  Preview     │e │  Model    │                │
│  │  FindBar     │  │  Sessions │                │
│  └──────────────┴──┴───────────┘                │
└─────────────────────────────────────────────────┘

前端 Store:  canvas-store (Zustand, persist → localStorage)
前端 Hooks:  useChat, useChatContext, useCommands
前端服务:    canvas-service, mock-ai
前端工具:    layout (dagre)

后端 Server:  Vite Plugin / Electron main (独立端口)
后端 WebSocket: ws-handler (双端点: /ws, /canvas)
后端 Agent:   agent.ts (pi-coding-agent session, 持久化会话)
后端扩展:     govio-canvas.ts (工具注册 + 事件拦截 + treemap 解析)
后端队列:     govio-node-queue.ts (批量节点事件)
后端 API:     parquet-api.ts (/api/preview)
后端会话:     session-history.ts (JSONL 持久化 + 画布 sidecar)
后端模型:     models-config.ts (多模型配置管理)
后端权限:     permission-manager.ts (observe load 权限审批)
后端安装:     govio-installer.ts (govio-cli + skills 自动安装)
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

浅色 "Green Deck" 主题（详见 `docs/DESIGN.md`）：

- 背景：`#f5f5f5`（画布），`#ffffff`（卡片）
- 品牌色：`#1DB954`（绿色，用于连线、Handle、强调）
- 层级区分通过表面亮度（浅色 = 高层）+ 边框颜色
- 字体：DM Sans（正文）+ JetBrains Mono（代码/数据）
- 详细 token 定义见 `src/index.css` `@theme` 块
