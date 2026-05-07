# Canvas 画布模块

## 概述

画布模块基于 `@xyflow/react` (ReactFlow) 实现，是应用的核心交互区域。支持节点拖拽、连线、自动布局、数据预览等操作。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/components/Canvas/Canvas.tsx` | 画布主组件，ReactFlow 容器 |
| `src/components/Canvas/CanvasToolbar.tsx` | 画布右上角工具栏 |
| `src/components/Canvas/FloatingPreviewPanel.tsx` | DataFrame 数据预览浮窗 |
| `src/utils/layout.ts` | Dagre 自动布局 + 智能节点定位 |

## Canvas 组件

### 功能

- 渲染 ReactFlow 画布，加载节点和边
- 处理拖拽放置（从 Sidebar 拖入表）
- 管理浮动预览面板

### 配置

| 属性 | 值 | 说明 |
|------|-----|------|
| `minZoom` | 0.1 | 最小缩放 |
| `maxZoom` | 2 | 最大缩放 |
| `snapToGrid` | true | 吸附网格 |
| `snapGrid` | [15, 15] | 网格间距 |
| `defaultEdgeOptions.type` | smoothstep | 平滑阶梯连线 |
| `defaultEdgeOptions.animated` | true | 连线动画 |
| `defaultEdgeOptions.style` | stroke: #3ecf8e, strokeWidth: 2 | 品牌绿连线 |

### 子组件

- **Background**: 点阵背景，gap=20, size=1, color=#2e2e2e
- **Controls**: 缩放控制，隐藏交互按钮
- **MiniMap**: 迷你地图，节点按类型着色

### 拖拽处理

```typescript
onDragOver: event.dataTransfer.dropEffect = 'move'
onDrop: 
  1. 获取 dataTransfer 中的 tableName
  2. 调用 canvas-store.addSourceTableToCanvas(tableName)
```

### 节点删除

通过 `onNodesDelete` 回调，调用 `canvas-store.deleteNodes()` 同步清理关联的边、预览面板和引用。

### MiniMap 节点颜色

| 节点类型 | 颜色 |
|---------|------|
| sourceTable | hsl(270, 60%, 60%) 紫色 |
| sqlQuery | hsl(152, 58%, 52%) 绿色 |
| dataFrame | hsl(25, 75%, 55%) 橙色 |
| report | hsl(270, 60%, 70%) 浅紫 |

## CanvasToolbar 组件

画布右上角浮动工具栏，提供两个操作：

| 按钮 | 功能 | 实现 |
|------|------|------|
| **SQL** | 创建空白 SQL 查询节点 | `canvas-store.createManualSQLNode()` |
| **恢复** | 从后端恢复 DataFrame 节点 | `useChatContext().observeList()` → `canvas-store.restoreCanvas()` |

恢复流程：
1. 调用 `observeList()` 向 `/ws` 发送 `{type: "observe_list"}`
2. 后端执行 `govio-cli observe list`，返回 DataFrame 列表
3. `restoreCanvas()` 对比已有节点，创建缺失的 DataFrame 节点

## FloatingPreviewPanel 组件

DataFrame 节点的数据预览浮窗，支持拖拽移动和翻页。

### 数据结构

```typescript
interface PreviewPanel {
  id: string;          // "preview-{nodeId}"
  nodeId: string;      // 关联的 DataFrame 节点 ID
  data: DataFrameNodeData;
  x: number;           // 浮窗位置
  y: number;
}
```

### 功能

- **拖拽移动**：鼠标按下标题栏拖动，调用 `canvas-store.movePreviewPanel()`
- **数据表格**：等宽字体表格，列头来自 `data.columns`，行数据来自 `data.previewData`
- **翻页**：每页 10 行，底部显示翻页控件和行号范围
- **关闭**：右上角 X 按钮，调用 `canvas-store.closePreviewPanel()`

### 预览数据加载

`canvas-store.openPreviewPanel()` 创建面板后，发起 HTTP 请求：

```
GET http://localhost:{apiPort}/api/preview?df={dfName}&rows=50
```

后端通过 `parquet-api.ts` 读取 `.govio/observe/dataframes/{df}.parquet` 文件，返回 JSON 行数据。

## Layout 工具

### getNodeSize(node)

根据节点类型返回固定尺寸，用于布局计算：

| 类型 | 宽 | 高 |
|------|-----|-----|
| sourceTable | 280 | 240 |
| sqlQuery | 300 | 280 |
| dataFrame | 320 | 300 |
| report | 380 | 340 |
| default | 280 | 200 |

### positionNewNode(existingNodes, newNode, newEdges)

智能定位新节点，不移动已有节点：

1. **有入边** → 放在最右侧源节点的右边
2. **独立节点** → 放在同类型最下方节点的下面
3. **无同类型** → 放在所有节点的左下角
4. **空画布** → 放在 (100, 100)
5. 所有位置通过 `findNonOverlappingPosition()` 避免重叠（最多 50 次尝试，向下/向右滑动）

间距常量：`GAP_X = 80`, `GAP_Y = 40`

### getLayoutedElements(nodes, edges, direction='LR')

Dagre 全局自动布局：

| 参数 | 值 | 说明 |
|------|-----|------|
| rankdir | 'LR' | 从左到右 |
| nodesep | 40 | 同层节点间距 |
| ranksep | 140 | 层级间距 |
| edgesep | 30 | 边间距 |
| ranker | network-simplex | 最优排列算法 |

布局后修正坐标：dagre 返回中心点坐标，需减去半宽/半高。同时设置 `sourcePosition: Right`, `targetPosition: Left`。
