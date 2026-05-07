# Nodes 节点模块

## 概述

节点是画布上的核心可视化单元。共 4 种类型，遵循从左到右的数据血缘方向：`SourceTable -> SQL -> DataFrame -> Report`。

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/components/Nodes/index.ts` | 节点类型注册表 |
| `src/components/Nodes/SourceTableNode.tsx` | 源表节点 |
| `src/components/Nodes/SQLQueryNode.tsx` | SQL 查询节点 |
| `src/components/Nodes/DataFrameNode.tsx` | DataFrame 节点 |
| `src/components/Nodes/ReportNode.tsx` | 报告节点 |
| `src/types/index.ts` | 所有节点数据类型定义 |

## 节点类型注册

```typescript
const nodeTypes: NodeTypes = {
  sourceTable: SourceTableNode,
  sqlQuery: SQLQueryNode,
  dataFrame: DataFrameNode,
  report: ReportNode,
};
```

所有节点使用 `memo()` 包裹，避免不必要的重渲染。

## 节点数据类型

### SourceTableNodeData

| 字段 | 类型 | 说明 |
|------|------|------|
| type | 'sourceTable' | 判别标识 |
| title | string | 显示标题 |
| description? | string | 描述 |
| createdAt | string | 创建时间 ISO |
| tableName | string | 表名 |
| database | string | 数据库名 |
| fields | TableField[] | 字段列表 |
| rowCount? | number | 行数 |

### SQLQueryNodeData

| 字段 | 类型 | 说明 |
|------|------|------|
| type | 'sqlQuery' | 判别标识 |
| title | string | 显示标题 |
| createdAt | string | 创建时间 |
| sql | string | SQL 语句 |
| outputColumns | string[] | 输出列名 |

### DataFrameNodeData

| 字段 | 类型 | 说明 |
|------|------|------|
| type | 'dataFrame' | 判别标识 |
| title | string | 显示标题 |
| createdAt | string | 创建时间 |
| dfName | string | DataFrame 名称 |
| sourceName | string | 数据源名称 |
| totalRows | number | 总行数 |
| totalColumns | number | 总列数 |
| memoryUsage | string | 内存占用（如 "1.2 MB"） |
| columns | DataFrameColumn[] | 列信息（name, nonNull, dtype） |
| previewData | Record<string, unknown>[] | 预览数据行 |

### ReportNodeData

| 字段 | 类型 | 说明 |
|------|------|------|
| type | 'report' | 判别标识 |
| title | string | 显示标题 |
| createdAt | string | 创建时间 |
| reportType | 'diff' / 'correlation' | 报告类型 |
| sourceRefs | { label: string }[] | 数据源引用标签 |
| content | string | Markdown 格式报告内容 |

### 公共辅助类型

```typescript
type TableField = {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  references?: { table: string; field: string };
}

type DataFrameColumn = {
  name: string;
  nonNull: number;
  dtype: string;
}

type CanvasNodeData = SourceTableNodeData | SQLQueryNodeData | DataFrameNodeData | ReportNodeData;
```

## 节点视觉规范

所有节点共享以下视觉模式：

- 圆角卡片 (`rounded-lg`)，边框 `border-border-default`
- 背景 `bg-bg-card`
- 左侧 3px 彩色边框标识类型
- 底部操作栏：引用按钮 + 删除按钮
- 左侧 Handle (target, Position.Left) + 右侧 Handle (source, Position.Right)
- Handle 颜色：品牌绿 `#3ecf8e`

### 颜色标识

| 类型 | 左边框颜色 | 图标 | MiniMap 颜色 |
|------|-----------|------|-------------|
| SourceTable | node-source (hsl 270, 紫色) | Database | hsl(270, 60%, 60%) |
| SQLQuery | node-sql (hsl 152, 绿色) | - | hsl(152, 58%, 52%) |
| DataFrame | node-df (hsl 25, 橙色) | Table2 | hsl(25, 75%, 55%) |
| Report (diff) | amber-400 (琥珀色) | GitCompare | hsl(270, 60%, 70%) |
| Report (correlation) | violet-400 (紫色) | TrendingUp | hsl(270, 60%, 70%) |

## SourceTableNode 详情

### 布局

1. **头部**：紫色左边框，Database 图标 + 表名，数据库 + 行数（等宽大写 + 1.2px 字距）
2. **字段列表**：默认显示前 6 个字段，PK/FK 标签，字段名 + 类型；超出可展开/折叠
3. **操作栏**：引用按钮 + 删除按钮

### 字段标签

- PK: 绿色背景 (brand/10) + 绿色文字
- FK: 紫色背景 (node-source/10) + 紫色文字

## SQLQueryNode 详情

### 布局

1. **头部**：绿色左边框，标题
2. **SQL 内容区**：
   - **显示模式**：等宽字体，最多 8 行，超出显示 `...`，双击进入编辑
   - **编辑模式**：textarea，自动调整高度（最大 200px），Ctrl+Enter 保存，Escape 取消
   - 空 SQL 显示斜体提示 "双击编辑 SQL"
3. **输出列**：绿色小标签展示 `outputColumns`
4. **操作栏**：引用按钮 + 删除按钮

### 编辑逻辑

- `isEditing` 初始值为 `sql === ''`（空 SQL 自动进入编辑）
- 保存时调用 `canvas-store.updateNodeData(id, { sql: trimmed })`
- `onBlur` 自动保存

## DataFrameNode 详情

### 布局

1. **头部**：橙色左边框，Table2 图标 + dfName，sourceName
2. **df.info() 区域**：行数、列数、内存占用（等宽字体，淡色文字）
3. **列信息表格**：序号、列名、Non-Null 计数、Dtype（dtype 列橙色高亮）
4. **操作栏**：引用按钮 + 预览按钮 + 删除按钮

### 预览功能

点击预览按钮调用 `canvas-store.openPreviewPanel(id)`，在画布上弹出 FloatingPreviewPanel 浮窗显示数据。

## ReportNode 详情

### 布局

1. **头部**：琥珀色(diff)/紫色(correlation) 左边框，对应图标 + 标题，sourceRef 标签
2. **内容区**：Markdown 解析渲染，最大高度 400px 可滚动
3. **操作栏**：引用按钮 + 删除按钮

### 内置 Markdown 解析器

ReportNode 实现了轻量级 Markdown 解析（`parseMarkdown`），支持：

- `##` / `###` 标题
- `- **bold**: text` 列表项
- `- text` 普通列表项
- `1. text` 有序列表
- `| col | col |` 表格（含分隔行）
- 空行 → 间距

不使用 react-markdown，而是自定义解析以保持卡片内紧凑渲染。

## 节点创建来源

| 节点类型 | 创建方式 |
|---------|---------|
| SourceTable | 1. 从 Sidebar 拖拽 2. AI 调用 `govio_create_source_table` 工具 |
| SQLQuery | 1. AI 回复中提取 SQL 代码块 2. 工具栏手动创建 |
| DataFrame | AI 执行 `govio-cli observe load` 命令后自动创建 |
| Report | AI 执行 `govio-cli observe compare/explore` 后自动创建 |
