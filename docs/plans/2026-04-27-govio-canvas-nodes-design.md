# Govio Canvas 自动节点创建设计

## 目标

当 LLM 运行 `govio-cli observe` 命令或回答中包含 SQL 代码块时，自动在 Canvas 前端创建对应的数据治理节点（sqlQuery、dataFrame、report），并建立从用户引用节点到新节点的数据血缘边。

## 核心机制

参考 pi-coding-agent Extension API，创建 **Govio Canvas Extension**，全自动拦截 agent 事件，无需 LLM 调用新工具。

```
┌─────────────┐    prompt + refs    ┌──────────────┐
│   前端用户   │ ──────────────────▶ │  ws-handler  │
└─────────────┘                     └──────┬───────┘
                                           │
                              ┌────────────▼────────────┐
                              │   pi-coding-agent       │
                              │   ┌─────────────────┐   │
                              │   │ Govio Extension │   │
                              │   │ - tool_result   │   │
                              │   │ - message_end   │   │
                              │   └────────┬────────┘   │
                              │            │ push queue │
                              │   ┌────────▼────────┐   │
                              │   │  Node Queue     │   │
                              │   └────────┬────────┘   │
                              └────────────┼────────────┘
                                           │ flush
                              ┌────────────▼────────────┐
                              │  ws-handler 发送事件     │
                              │  type: govio_node_create │
                              └────────────┬────────────┘
                                           │
                              ┌────────────▼────────────┐
                              │  前端 Canvas Store       │
                              │  - 创建 Node             │
                              │  - 从 lastReferencedNodes│
                              │    建立 Edge             │
                              │  - autoLayout()          │
                              └─────────────────────────┘
```

## 节点映射规则

| 来源 | 节点类型 | 数据提取 |
|---|---|---|
| ` ```sql ` 代码块 | `sqlQuery` | `title`（默认"SQL Query"）、`sql`（代码块内容）、`outputColumns`（解析 SELECT 列） |
| `observe load` stdout | `dataFrame` | `dfName`、`sourceName`、`totalRows`、`totalColumns`、`memoryUsage`、`columns`、**`previewData`**（从本地 parquet 读取前 10 行） |
| `observe compare` stdout | `report` (diff) | `title`="差异比较报告"、`content`=`data.report`、`sourceRefs`=[比对的两个 df 名称] |
| `observe explore` stdout | `report` (correlation) | `title`="关系探查报告"、`content`=relations 格式化 markdown、`sourceRefs`=[探查的 df 名称] |
| `show-datasource` / `list` | **不创建节点** | 信息仅在聊天中展示 |

## 后端设计

### 1. 共享队列 `server/govio-node-queue.ts`

模块级内存队列，存放待发送的 `GovioNodeCreateEvent[]`。Extension 负责 `push`，ws-handler 在每个事件循环后 `flush` 并通过 WebSocket 发送。

### 2. Extension `server/extensions/govio-canvas.ts`

导出 `default function (pi: ExtensionAPI)`：

- **监听 `tool_result`**：过滤 `toolName === "bash"` 且输入命令包含 `govio-cli observe` 的事件。解析 `result.content` 中的 stdout JSON：
  - `observe load`：生成 dataFrame 节点，并通过 `pi.exec` 执行 Python 读取 `.govio/observe/dataframes/{dfName}.parquet` 前 10 行作为 previewData
  - `observe compare`：生成 report (diff) 节点
  - `observe explore`：生成 report (correlation) 节点
  - `show-datasource` / `list`：忽略
- **监听 `message_end`**：提取 assistant message 文本中的 ` ```sql ` 代码块，解析 SQL 和输出列，生成 sqlQuery 节点

### 3. `server/agent.ts` 修改

在 `DefaultResourceLoader` 中通过 `extensionFactories` 注册 Govio Canvas Extension。

### 4. `server/ws-handler.ts` 修改

在 `session.subscribe` 的事件处理中，于 `tool_execution_end` 和 `message_end` 后执行 `flushGovioNodes()`，将队列中的事件逐个通过 WebSocket 发送给前端。

## 前端设计

### 1. `src/services/ai-service.ts`

新增 `govio_node_create` 事件类型到 `StreamEvent` union。`WebSocketAIService` 收到后通过 `callbacks` 转发给 Canvas Store。

### 2. `src/store/canvas-store.ts`

- **`sendMessage`**：发送 prompt 前将当前 `referencedNodes` 保存到 `lastReferencedNodes`
- **`createGovioNode`** action：
  1. 根据 `GovioNodeCreateEvent` 构造对应类型的 `Node`
  2. 遍历 `lastReferencedNodes`，每个引用节点 → 新节点建立 `Edge`（source 到 target），已存在的边跳过
  3. 将新节点和边加入 state，调用 `autoLayout()`
- **`lastReferencedNodes`** 生命周期：保留到下一次 `sendMessage` 时覆盖

### 3. 边的创建规则

```
用户引用了 [T1, T2] → LLM 本轮创建了 [N1, N2]
Edges: T1→N1, T2→N1, T1→N2, T2→N2
```

## WebSocket 事件格式

后端 → 前端 `govio_node_create` 事件：

```ts
// sqlQuery
{ type: "govio_node_create", nodeType: "sqlQuery", title: string, sql: string, outputColumns: string[] }

// dataFrame
{ type: "govio_node_create", nodeType: "dataFrame", dfName: string, sourceName: string, totalRows: number, totalColumns: number, memoryUsage: string, columns: DataFrameColumn[], previewData: Record<string, unknown>[] }

// report
{ type: "govio_node_create", nodeType: "report", reportType: "diff" | "correlation", title: string, content: string, sourceRefs: { label: string }[] }
```

## 文件变更清单

| 文件 | 操作 |
|---|---|
| `server/govio-node-queue.ts` | 新增 |
| `server/extensions/govio-canvas.ts` | 新增 |
| `server/agent.ts` | 修改（注册 Extension） |
| `server/ws-handler.ts` | 修改（flush 队列转发 WS） |
| `src/services/ai-service.ts` | 修改（新增事件类型） |
| `src/store/canvas-store.ts` | 修改（`lastReferencedNodes` + `createGovioNode`） |

## 决策记录

1. **全自动拦截，无需 LLM 调用新工具**：参考 pi-coding-agent Extension API，通过拦截 `tool_result` 和 `message_end` 事件自动创建节点。
2. **Parquet 预览数据**：`observe load` 产生的 `.govio/observe/dataframes/*.parquet` 文件通过 Python 读取前 10 行作为 `previewData`。
3. **`lastReferencedNodes` 生命周期**：保留到下一次 `sendMessage` 时覆盖，符合"本轮 LLM 运行过程中产生的新卡片"的语义。
4. **边的去重**：创建 Edge 前检查是否已存在相同 source/target 的边，避免重复。
