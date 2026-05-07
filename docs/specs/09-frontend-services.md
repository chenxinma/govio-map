# Frontend Services 前端服务层

## 概述

前端服务层封装了 WebSocket 通信和节点 ID 生成逻辑，为 Store 和 Hook 提供底层能力。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/services/canvas-service.ts` | Canvas WebSocket 服务 |
| `src/services/mock-ai.ts` | 节点 ID 生成器 |

## canvas-service.ts

### 接口

```typescript
interface CanvasService {
  subscribe(callback: (event: CanvasEvent) => void): () => void;
  isConnected(): boolean;
}
```

### CanvasEvent

```typescript
interface CanvasEvent {
  type: "govio_node_create";
  nodeType: "sqlQuery" | "dataFrame" | "report" | "sourceTable";
  title: string;
  // sqlQuery 字段
  sql?: string;
  outputColumns?: string[];
  // dataFrame 字段
  dfName?: string;
  sourceName?: string;
  totalRows?: number;
  totalColumns?: number;
  memoryUsage?: string;
  columns?: Array<{ name: string; nonNull: number; dtype: string }>;
  // report 字段
  reportType?: "diff" | "correlation";
  content?: string;
  sourceRefs?: Array<{ label: string }>;
  // sourceTable 字段
  tableName?: string;
  database?: string;
  fields?: Array<{ name: string; type: string; nullable: boolean; description?: string; isPrimaryKey?: boolean; isForeignKey?: boolean; references?: { table: string; field: string } }>;
  // 连线
  referencedNodes?: Array<{ nodeId: string; label: string }>;
}
```

### WebSocketCanvasService

- 连接地址：`ws://hostname:{port+1}/canvas`
- 接收消息后分发给所有注册的 callback
- 单例模式（`getCanvasService()`）

### MockCanvasService

WebSocket 不可用时的降级方案，subscribe 为 no-op，isConnected 返回 false。

## mock-ai.ts

### nextId(prefix)

模块级递增计数器，生成格式 `{prefix}-{N}`，如 `src-1`, `gov-3`, `sql-2`。

### syncCountersFromNodes(nodes)

扫描节点 ID 列表，将计数器重置为已存在的最大 N 值。在 Store 持久化恢复时调用，避免 ID 冲突。

## Mock 数据

### mock-tables.ts

8 张 `govio_dw` 数据库的业务表：

| 表名 | 行数 | 外键 |
|------|------|------|
| billing | 12,340 | customer, sales_group |
| customer | 2,450 | region, department |
| department | 45 | - |
| sales_group | 120 | department |
| product | 580 | - |
| billing_item | 35,600 | billing, product |
| region | 32 | - |
| payment | 11,800 | billing |

每张表包含完整的字段定义，含中文描述、PK/FK 标注、跨表引用关系。
