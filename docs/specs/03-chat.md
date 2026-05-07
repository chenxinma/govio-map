# Chat 聊天模块

## 概述

聊天模块是用户与 AI Agent 交互的界面，支持流式输出、工具调用展示、节点引用上下文、斜杠命令等。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/components/Chat/ChatPanel.tsx` | 聊天面板容器 |
| `src/components/Chat/ChatInput.tsx` | 输入框 + 引用标签 + 斜杠命令 |
| `src/components/Chat/ChatMessage.tsx` | 消息渲染（用户/助手） |
| `src/hooks/useChat.ts` | WebSocket 聊天核心 Hook |
| `src/hooks/useChatContext.ts` | React Context 传递 |

## ChatPanel 组件

### Props

| 属性 | 类型 | 说明 |
|------|------|------|
| width | number | 面板宽度（受布局拖拽控制） |

### 结构

1. **头部**：标题 "对话" + 连接状态指示灯（绿色=已连接，红色=未连接）
2. **消息列表**：可滚动区域，自动滚底（用户手动上滚时暂停自动滚动）
3. **输入区**：ChatInput 组件

### 消息发送

发送时将 `referencedNodes` 附加到消息，发送后清空引用列表。

## ChatInput 组件

### Props

| 属性 | 类型 | 说明 |
|------|------|------|
| onSend | (content: string) => void | 发送回调 |
| onAbort | () => void | 中止回调 |
| isStreaming | boolean | 是否正在流式输出 |
| isConnected | boolean | 是否已连接 |
| referencedNodes | ReferencedNode[] | 当前引用的节点 |
| onRemoveReference | (nodeId) => void | 移除引用 |
| clearMessages | () => void | 清空消息 |
| clearCanvas | () => void | 清空画布 |
| messages | ChatMessage[] | 消息列表（用于导出） |
| nodes | Node[] | 画布节点（用于导出） |
| edges | Edge[] | 画布边（用于导出） |

### 功能

1. **引用标签**：在输入框上方显示已引用的节点标签，按类型着色图标，支持移除
2. **输入框**：textarea，自动调整高度（最大 160px），Enter 发送，Shift+Enter 换行
3. **斜杠命令**：输入 `/` 时弹出命令建议列表，支持键盘上下选择
4. **发送/中止按钮**：流式输出时显示红色中止按钮，否则显示绿色发送按钮

### 引用节点图标映射

| 节点类型 | 图标 | 颜色类 |
|---------|------|--------|
| sourceTable | Database | text-node-source |
| sqlQuery | Code | text-node-sql |
| dataFrame | Table2 | text-node-df |
| report | FileText | text-node-report |

### 斜杠命令交互

- 输入 `/` 触发命令过滤
- 上下箭头导航，Enter 选择
- builtin 命令：执行 handler，清空输入
- custom 命令：将 prompt 填入输入框
- Escape 关闭建议列表
- 失焦延迟 150ms 关闭（确保点击事件可触发）

## ChatMessage 组件

### 消息类型

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  isStreaming?: boolean;
  referencedNodes?: ReferencedNode[];
}

interface ToolCall {
  toolName: string;
  success?: boolean;  // undefined=运行中, true=成功, false=失败
}
```

### 用户消息渲染

- 右对齐，左品牌绿边框
- 如有引用节点，在文字上方显示 ReferenceChips
- 文字 `whitespace-pre-wrap`

### 助手消息渲染

- 左对齐，标准边框
- 可折叠 Thinking 区域（默认折叠）
- ToolPills 工具调用标签（运行中显示 spinner，成功绿色勾，失败红色叉）
- 正文通过 `react-markdown` + `remark-gfm` 渲染
- 空内容且正在流式输出时显示 "思考中..." 加载动画

### ToolPill

胶囊标签，显示工具名 + 状态图标：
- 运行中：灰色背景 + Loader2 spinner
- 成功：绿色 Check 图标
- 失败：红色 X 图标

## useChat Hook

### 返回值

| 属性 | 类型 | 说明 |
|------|------|------|
| messages | ChatMessage[] | 消息列表 |
| isConnected | boolean | WebSocket 连接状态 |
| isStreaming | boolean | 是否正在流式输出 |
| send | (content, referencedNodes?) => void | 发送消息 |
| abort | () => void | 中止当前输出 |
| observeList | () => Promise<unknown[]> | 获取 DataFrame 列表 |
| isObserving | boolean | 是否正在观察列表 |
| clearMessages | () => void | 清空消息 |

### WebSocket 连接

- 连接地址：`ws://hostname:{port+1}/ws`
- 指数退避重连：最大 10s，倍数增长
- 卸载时标记 `disposedRef` 阻止重连

### 流式消息协议处理

| 事件类型 | 处理 |
|---------|------|
| session_ready | 设置已连接状态 |
| agent_start | 标记流式输出开始 |
| message_start | 创建新的助手消息（空内容，isStreaming=true） |
| thinking_delta | 追加思考内容到当前消息 |
| text_delta | 追加正文内容到当前消息 |
| tool_start | 追加工具调用标签（success=undefined） |
| tool_end | 更新最后一个工具标签的 success 状态 |
| message_end | 终结当前消息（isStreaming=false） |
| agent_end | 标记流式输出结束 |
| observe_list_result | 解析 DataFrame 列表，resolve Promise |
| error | 记录错误，取消 pending 的 observe 操作 |

### send() 逻辑

1. 创建用户消息加入 state
2. 如果正在流式输出，发送 `{type: "steer", content, referencedNodes?}`
3. 否则发送 `{type: "prompt", content, referencedNodes?}`

### observeList() 逻辑

1. 发送 `{type: "observe_list"}`
2. 返回 Promise，等待 `observe_list_result` 事件
3. 15 秒超时自动 reject

## useChatContext

React Context 包装，提供 `useChat()` 返回值给子树。`ChatPanel` 外使用会抛错。
