# Layout 布局模块

## 概述

布局模块定义应用整体结构：Header + 三栏布局（Canvas + ResizeDivider + ChatPanel）。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/components/Layout/AppLayout.tsx` | 应用主布局 |
| `src/components/Layout/Header.tsx` | 顶部导航栏 |
| `src/components/Layout/ResizeDivider.tsx` | 面板拖拽分隔条 |

## AppLayout 组件

### 布局结构

```
+---------------------------------------------+
|  Header (h-14)                               |
+----------------------------+--+--------------+
|  Canvas (flex-1, min-400)  |RD| ChatPanel    |
|                            |  | (280~600px)  |
+----------------------------+--+--------------+
```

### Chat 宽度管理

| 参数 | 值 |
|------|-----|
| DEFAULT_CHAT_WIDTH | 400px |
| MIN_CHAT_WIDTH | 280px |
| MAX_CHAT_WIDTH | 600px |

- `chatWidth` 通过 `useState` 管理
- `ResizeDivider` 拖拽时 `handleResize(deltaX)` 限制在 [280, 600]
- deltaX 取反向：`delta = startX - currentX`（向左拖 = 宽度增加）

### Context 注入

`AppLayout` 创建 `useChat()` 实例并通过 `ChatContext.Provider` 传递给子树，确保 ChatPanel 和 CanvasToolbar 共享同一聊天连接。

## Header 组件

固定高度 56px (`h-14`)，深色背景 `bg-bg-primary`，底部边框 `border-border-default`。

**左侧**：Hexagon 图标（品牌绿实心）+ "Govio Map" 标题 + "/" 分隔 + "数据治理画布" 副标题

**右侧**：用户头像圆圈（品牌绿 20% 背景 + 边框 + "U" 字母）

## ResizeDivider 组件

### Props

| 属性 | 类型 | 说明 |
|------|------|------|
| onResize | (deltaX: number) => void | 拖拽回调 |

### 行为

1. mousedown 记录起始 X
2. mousemove 计算 `delta = startX - currentX`，更新 startX，调用 onResize
3. mouseup 移除监听，恢复光标和 userSelect
4. 拖拽期间 `cursor: col-resize`, `userSelect: none`

### 样式

- 宽度 8px，默认 `bg-border-subtle`，悬停 `bg-border-default`，激活 `bg-brand/30`
