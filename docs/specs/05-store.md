# Store 状态管理

## 概述

使用 Zustand 5 管理 Canvas 画布状态，通过 `persist` 中间件持久化到 localStorage。

## 文件

| 文件 | 职责 |
|------|------|
| `src/store/canvas-store.ts` | Canvas 状态 Store |
| `src/services/mock-ai.ts` | 节点 ID 生成器 |

## CanvasStore 状态

| 字段 | 类型 | 说明 |
|------|------|------|
| nodes | Node[] | ReactFlow 节点列表 |
| edges | Edge[] | ReactFlow 边列表 |
| previewPanels | PreviewPanel[] | 打开的预览浮窗 |
| referencedNodes | ReferencedNode[] | 当前引用的节点列表 |

## ReactFlow 集成

| 方法 | 说明 |
|------|------|
| onNodesChange | 应用节点变更（拖拽、选择等） |
| onEdgesChange | 应用边变更 |
| onConnect | 新建连线（addEdge） |

## 节点操作

### addSourceTableToCanvas(tableName)

从 `MOCK_TABLES` 查找表定义，创建 sourceTable 节点。重复添加同一表会被忽略。

流程：
1. 检查画布是否已有同 tableName 的 sourceTable 节点
2. 生成 ID: `nextId('src')` (如 src-1, src-2)
3. 调用 `positionNewNode()` 计算位置
4. 设置 `sourcePosition: Right, targetPosition: Left`

### createGovioNode(event: CanvasEvent)

核心节点创建方法，处理所有 4 种节点类型。

流程：
1. 生成 ID: `nextId('gov')` (如 gov-1, gov-2)
2. 根据 `event.nodeType` 创建对应 Node 对象
3. 自动创建连线：
   - 从 `event.referencedNodes` 中的 nodeId 查找画布节点，创建 source->target 边
   - Report 节点额外匹配 `sourceRefs.label` 到画布节点（按 title/tableName/dfName 匹配）
4. 边样式：`smoothstep`, `animated: true`, `stroke: #3ecf8e`, `strokeWidth: 2`
5. 调用 `positionNewNode()` 计算位置

### createManualSQLNode()

创建空白 SQL 节点（sql='', outputColumns=[]），ID 前缀 'sql'。

### deleteNodes(nodeIds)

删除节点及其关联资源：
- 过滤掉指定节点
- 过滤掉连接到这些节点的边
- 关闭关联的预览面板
- 移除关联的引用

### updateNodeData(nodeId, data)

部分更新节点 data 字段（浅合并）。

### clearCanvas()

重置 nodes, edges, previewPanels, referencedNodes 为空。

## 预览面板操作

| 方法 | 说明 |
|------|------|
| openPreviewPanel(nodeId) | 创建浮窗，从后端获取 parquet 数据 |
| closePreviewPanel(panelId) | 关闭浮窗 |
| movePreviewPanel(panelId, x, y) | 移动浮窗位置 |
| updatePreviewPanelData(panelId, previewData) | 更新预览数据（fetch 完成后调用） |

### openPreviewPanel 流程

1. 检查是否已有该节点的浮窗
2. 创建 PreviewPanel 对象，位置按已有浮窗数量偏移
3. 发起 `GET /api/preview?df={dfName}&rows=50`
4. 请求成功后调用 `updatePreviewPanelData()`

## 引用管理

| 方法 | 说明 |
|------|------|
| addReference(nodeId) | 添加引用，不同类型提取不同 data（SQL/sql, DataFrame/dfName, SourceTable/JSON） |
| removeReference(nodeId) | 移除引用 |
| clearReferences() | 清空所有引用（发送消息后调用） |

addReference 提取的 data：
- sqlQuery: `data.sql`
- dataFrame: `data.dfName`
- sourceTable: `JSON.stringify({full_table_name, fields})`

## 画布订阅

### subscribeToCanvas()

订阅 CanvasService WebSocket，接收 `govio_node_create` 事件，调用 `createGovioNode()`。

### restoreCanvas(dataframes)

从后端 DataFrame 列表恢复节点。对比已有 DataFrame 节点的 dfName，仅创建缺失的。

## 持久化

- 存储键: `govio-canvas-state`
- 持久化字段: nodes, edges, referencedNodes
- 不持久化: previewPanels（每次重新打开）
- 恢复时调用 `syncCountersFromNodes(nodes)` 同步 ID 计数器

## ID 生成 (mock-ai.ts)

```typescript
nextId(prefix: string): string  // "src-1", "gov-3", "sql-2"
syncCountersFromNodes(nodes): void  // 扫描已有节点 ID，重置计数器最大值
```

模块级计数器 `nodeIdCounter`，确保 ID 唯一递增。
