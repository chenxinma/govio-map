# Chart.js 节点实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 chart 节点从 PNG base64 渲染切换为前端 chart.js 直接渲染，agent 通过 `govio_show_chart` 工具透传 chart.js config。

**Architecture:** agent 调 govio-cli 取数后，调 `govio_show_chart(config)` 工具传 chart.js 配置对象；服务端把 config 推到 node queue；前端 ChartNode 用 chart.js 实例渲染 canvas，点击打开全屏 ChartModal。配套 `.claude/skills/chart-selector/SKILL.md` 指导 agent 选型与配置。

**Tech Stack:** chart.js 4.x, React 19, TypeScript, @xyflow/react, Zustand, @sinclair/typebox

---

## File Structure

**新增文件：**
- `src/components/Nodes/ChartErrorBoundary.tsx` — chart canvas 错误兜底，config 非法时显示占位
- `src/components/Nodes/ChartModal.tsx` — 全屏放大 modal，独立 chart.js 实例
- `.claude/skills/chart-selector/SKILL.md` — chart 选型 + chart.js config 指导

**修改文件：**
- `package.json` — 新增 chart.js 依赖
- `src/types/index.ts` — 新增 `ChartConfig` 类型，改造 `ChartNodeData`
- `server/govio-node-queue.ts` — `GovioNodeCreateEvent` chart 字段改造
- `src/services/canvas-service.ts` — `CanvasEvent` chart 字段改造
- `server/extensions/govio-canvas.ts` — 重写 `govio_show_chart` 工具，移除 `readFileSync`
- `src/store/canvas-store.ts` — chart node 创建分支改用 `config`
- `src/components/Nodes/ChartNode.tsx` — 整体重写：canvas + chart.js + modal 触发

---

## Task 1: 安装 chart.js 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 chart.js**

Run:
```bash
npm install chart.js
```

Expected: `package.json` 的 `dependencies` 新增 `"chart.js": "^4.x.x"`，`package-lock.json` 更新。

- [ ] **Step 2: 验证安装**

Run:
```bash
node -e "require('chart.js'); console.log('chart.js loaded')"
```

Expected: 输出 `chart.js loaded`，无报错。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json
git commit -m "feat: add chart.js dependency for chart node rendering"
```

---

## Task 2: 定义 ChartConfig 类型并改造 ChartNodeData

**Files:**
- Modify: `src/types/index.ts:66-78`

- [ ] **Step 1: 替换 ChartType 和 ChartNodeData**

将 `src/types/index.ts` 的 line 66-78（`ChartType` 和 `ChartNodeData`）替换为：

```typescript
export interface ChartConfig {
  type: string;
  data: {
    labels?: string[];
    datasets: Array<{
      label: string;
      data: number[] | Array<{ x: number; y: number }>;
      [key: string]: unknown;
    }>;
  };
  options?: Record<string, unknown>;
}

export interface ChartNodeData {
  type: 'chart';
  title: string;
  createdAt: string;
  sourceDf?: string;
  config: ChartConfig;
  [key: string]: unknown;
}
```

注意：移除 `ChartType` 类型别名（`'bar' | 'line'`），移除 `chartType`、`xColumn`、`yColumn`、`imageBase64` 字段。`CanvasNodeData` 联合类型引用 `ChartNodeData` 不变。

- [ ] **Step 2: 验证类型检查（预期有错误）**

Run:
```bash
npx tsc --noEmit
```

Expected: 报错来自 `canvas-service.ts`、`govio-node-queue.ts`（server 端不在此 tsc 范围）、`canvas-store.ts`、`ChartNode.tsx`，因为它们还引用旧字段。这些错误会在后续 task 修复。**此步仅确认 types 文件本身无语法错误。**

- [ ] **Step 3: 提交**

```bash
git add src/types/index.ts
git commit -m "refactor: replace ChartNodeData PNG fields with ChartConfig type"
```

---

## Task 3: 改造 GovioNodeCreateEvent

**Files:**
- Modify: `server/govio-node-queue.ts:26-31`

- [ ] **Step 1: 替换 chart 字段**

将 `server/govio-node-queue.ts` 的 line 26-31（`// chart` 注释及后续 4 个字段）替换为：

```typescript
  // chart
  config?: {
    type: string;
    data: {
      labels?: string[];
      datasets: Array<{
        label: string;
        data: number[] | Array<{ x: number; y: number }>;
        [key: string]: unknown;
      }>;
    };
    options?: Record<string, unknown>;
  };
  sourceDf?: string;
```

移除 `imageBase64`、`chartType`、`xColumn`、`yColumn`。保留 `sourceDf`（原已有）。

- [ ] **Step 2: 验证 server 端类型**

Run:
```bash
npx tsx --eval "import('./server/govio-node-queue.ts')" 2>&1 | head -5
```

Expected: 无类型错误输出（或空输出）。如果报错来自 `govio-canvas.ts` 引用旧字段，属于预期，下个 task 修复。

- [ ] **Step 3: 提交**

```bash
git add server/govio-node-queue.ts
git commit -m "refactor: replace GovioNodeCreateEvent chart fields with config"
```

---

## Task 4: 改造 CanvasEvent 类型

**Files:**
- Modify: `src/services/canvas-service.ts:20-25`

- [ ] **Step 1: 替换 chart 字段**

将 `src/services/canvas-service.ts` 的 line 20-25（`// chart` 注释及后续 4 个字段）替换为：

```typescript
  // chart
  config?: {
    type: string;
    data: {
      labels?: string[];
      datasets: Array<{
        label: string;
        data: number[] | Array<{ x: number; y: number }>;
        [key: string]: unknown;
      }>;
    };
    options?: Record<string, unknown>;
  };
```

移除 `imageBase64`、`chartType`、`xColumn`、`yColumn`。保留 `sourceDf`（原在 line 23）。

- [ ] **Step 2: 验证类型检查**

Run:
```bash
npx tsc --noEmit
```

Expected: 报错来自 `canvas-store.ts`（chart 创建分支引用旧字段）和 `ChartNode.tsx`（引用 `imageBase64` 等）。这些在后续 task 修复。

- [ ] **Step 3: 提交**

```bash
git add src/services/canvas-service.ts
git commit -m "refactor: replace CanvasEvent chart fields with config"
```

---

## Task 5: 重写 govio_show_chart 工具

**Files:**
- Modify: `server/extensions/govio-canvas.ts:1`（移除 import）
- Modify: `server/extensions/govio-canvas.ts:333-368`（重写工具）

- [ ] **Step 1: 移除 readFileSync import**

将 `server/extensions/govio-canvas.ts` line 1：
```typescript
import { readFileSync } from "fs";
```
替换为（即删除该行）：
```typescript
```

确认 `readFileSync` 在文件中无其他引用（原仅 line 346 使用）。

- [ ] **Step 2: 重写 govio_show_chart 工具**

将 `server/extensions/govio-canvas.ts` line 333-368（整个 `pi.registerTool({ name: "govio_show_chart", ... })` 块）替换为：

```typescript
  pi.registerTool({
    name: "govio_show_chart",
    label: "Govio Chart",
    description: "Show a chart node on the canvas with a chart.js config. Call govio-cli to fetch data first, then pass the chart.js configuration object. Refer to the chart-selector skill for chart type selection and config templates.",
    parameters: Type.Object({
      title: Type.String({ description: "Chart node title, e.g. \"Chart: df_sales (bar)\"" }),
      sourceDf: Type.Optional(Type.String({ description: "Source DataFrame name, shown in node header" })),
      config: Type.Object({
        type: Type.String({ description: "Chart.js chart type: \"bar\" | \"line\" | \"pie\" | \"doughnut\" | \"scatter\"" }),
        data: Type.Object({
          labels: Type.Optional(Type.Array(Type.String(), { description: "Category labels (required for bar/line/pie/doughnut, omit for scatter)" })),
          datasets: Type.Array(
            Type.Object({
              label: Type.String({ description: "Dataset label shown in legend" }),
              data: Type.Array(Type.Unknown(), { description: "Data values: number[] for bar/line/pie, [{x,y}] for scatter" }),
            }),
            { description: "Data series array" }
          ),
        }),
        options: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Chart.js options object (scales, plugins, etc.)" })),
      }),
    }),
    execute: async (_toolCallId, params) => {
      pushGovioNode({
        nodeType: "chart",
        title: params.title,
        sourceDf: params.sourceDf,
        config: params.config,
      });
      return {
        content: [{ type: "text", text: `Created chart node: ${params.title} (${params.config.type})` }],
        details: {},
      };
    },
  });
```

- [ ] **Step 3: 验证 server 端类型**

Run:
```bash
npx tsx --eval "import('./server/extensions/govio-canvas.ts')" 2>&1 | head -10
```

Expected: 无类型错误。如果 `Type.Unknown()` 报错，改用 `Type.Any()`。

- [ ] **Step 4: 提交**

```bash
git add server/extensions/govio-canvas.ts
git commit -m "refactor: rewrite govio_show_chart tool to accept chart.js config"
```

---

## Task 6: 改造 canvas-store chart 创建分支

**Files:**
- Modify: `src/store/canvas-store.ts:176-192`

- [ ] **Step 1: 替换 chart case 分支**

将 `src/store/canvas-store.ts` line 176-192（`case "chart":` 到 `break;`）替换为：

```typescript
      case "chart":
        newNode = {
          id: nodeId,
          type: "chart",
          position: { x: 0, y: 0 },
          data: {
            type: "chart",
            title: event.title || "Chart",
            createdAt: now,
            sourceDf: event.sourceDf || "",
            config: event.config || { type: "bar", data: { labels: [], datasets: [] } },
          },
        };
        break;
```

移除 `chartType`、`sourceDf`（从旧位置）、`xColumn`、`yColumn`、`imageBase64`。`sourceDf` 现在从 `event.sourceDf` 读。`config` 从 `event.config` 读，缺失时给空 bar config 兜底。

- [ ] **Step 2: 验证类型检查**

Run:
```bash
npx tsc --noEmit
```

Expected: `canvas-store.ts` 不再报错。剩余报错仅来自 `ChartNode.tsx`（下个 task 修复）。

- [ ] **Step 3: 提交**

```bash
git add src/store/canvas-store.ts
git commit -m "refactor: update canvas store chart branch to use config"
```

---

## Task 7: 创建 ChartErrorBoundary 组件

**Files:**
- Create: `src/components/Nodes/ChartErrorBoundary.tsx`

- [ ] **Step 1: 创建文件**

创建 `src/components/Nodes/ChartErrorBoundary.tsx`：

```tsx
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ChartErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[ChartErrorBoundary] chart render failed:', error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center justify-center h-full text-xs text-text-muted">
          图表配置错误
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: 验证类型检查**

Run:
```bash
npx tsc --noEmit
```

Expected: 新文件无类型错误。剩余报错仅来自 `ChartNode.tsx`。

- [ ] **Step 3: 提交**

```bash
git add src/components/Nodes/ChartErrorBoundary.tsx
git commit -m "feat: add ChartErrorBoundary for chart canvas error fallback"
```

---

## Task 8: 创建 ChartModal 组件

**Files:**
- Create: `src/components/Nodes/ChartModal.tsx`

- [ ] **Step 1: 创建文件**

创建 `src/components/Nodes/ChartModal.tsx`：

```tsx
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { ChartConfig } from '../../types';
import { ChartErrorBoundary } from './ChartErrorBoundary';

Chart.register(...registerables);

interface Props {
  config: ChartConfig;
  title: string;
  onClose: () => void;
}

export default function ChartModal({ config, title, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const modalConfig: ChartConfig = structuredClone(config);
    modalConfig.options = {
      ...(config.options ?? {}),
      responsive: true,
      maintainAspectRatio: false,
    };
    chartRef.current = new Chart(canvasRef.current, modalConfig as Parameters<typeof Chart>[1]);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[860px] max-w-[90vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 flex-1 min-h-0">
          <ChartErrorBoundary>
            <canvas ref={canvasRef} className="w-full h-[520px]" />
          </ChartErrorBoundary>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 2: 验证类型检查**

Run:
```bash
npx tsc --noEmit
```

Expected: `ChartModal.tsx` 无类型错误。`structuredClone` 在 Node 17+ 和现代浏览器可用，无需 polyfill。如果 `Parameters<typeof Chart>[1]` 报错，改用 `as any`。

- [ ] **Step 3: 提交**

```bash
git add src/components/Nodes/ChartModal.tsx
git commit -m "feat: add ChartModal for full-screen chart zoom view"
```

---

## Task 9: 重写 ChartNode

**Files:**
- Modify: `src/components/Nodes/ChartNode.tsx`（整体重写）

- [ ] **Step 1: 整体重写 ChartNode.tsx**

将 `src/components/Nodes/ChartNode.tsx` 全文替换为：

```tsx
import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { BarChart3, Maximize2, Quote, Trash2 } from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import type { ChartNodeData } from '../../types';
import { useCanvasStore } from '../../store/canvas-store';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import ChartModal from './ChartModal';

Chart.register(...registerables);

function ChartNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as ChartNodeData;
  const addReference = useCanvasStore((s) => s.addReference);
  const deleteNodes = useCanvasStore((s) => s.deleteNodes);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, nodeData.config as Parameters<typeof Chart>[1]);
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [nodeData.config]);

  return (
    <div className="w-[420px] rounded-lg border border-border-default bg-bg-card overflow-hidden">
      <div className="border-l-[3px] border-l-node-chart px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <BarChart3 size={14} className="text-sky-400" />
          <span className="text-sm font-medium text-text-primary">{nodeData.title}</span>
        </div>
        {nodeData.sourceDf && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted font-mono border border-border-subtle">
              {nodeData.sourceDf}
            </span>
            <span className="text-[10px] text-text-dim font-mono uppercase">
              {nodeData.config.type}
            </span>
          </div>
        )}
      </div>

      <div
        className="border-t border-border-subtle p-2 cursor-zoom-in"
        onClick={() => setShowModal(true)}
      >
        <ChartErrorBoundary>
          <canvas ref={canvasRef} className="w-full h-[260px]" />
        </ChartErrorBoundary>
      </div>

      <div className="border-t border-border-subtle px-4 py-2 flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); addReference(id); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Quote size={12} />
          <span>引用</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setShowModal(true); }}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-brand transition-colors px-2 py-1 rounded-md hover:bg-brand/5"
        >
          <Maximize2 size={12} />
          <span>放大</span>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); deleteNodes([id]); }}
          className="ml-auto flex items-center text-text-muted hover:text-red-400 transition-colors p-1 rounded-md hover:bg-red-400/10"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-brand" />
      <Handle type="target" position={Position.Left} className="!bg-brand" />

      {showModal && (
        <ChartModal
          config={nodeData.config}
          title={nodeData.title}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

export default memo(ChartNode);
```

- [ ] **Step 2: 验证类型检查（全量）**

Run:
```bash
npx tsc --noEmit
```

Expected: 无类型错误。所有旧字段引用已清除。

- [ ] **Step 3: 验证构建**

Run:
```bash
npm run build
```

Expected: 构建成功，无 TypeScript 错误，`dist/` 目录生成。

- [ ] **Step 4: 提交**

```bash
git add src/components/Nodes/ChartNode.tsx
git commit -m "feat: rewrite ChartNode to render chart.js canvas with zoom modal"
```

---

## Task 10: 创建 chart-selector skill

**Files:**
- Create: `.claude/skills/chart-selector/SKILL.md`

- [ ] **Step 1: 创建目录和文件**

创建 `.claude/skills/chart-selector/SKILL.md`：

````markdown
---
name: chart-selector
description: Use when calling govio_show_chart tool — guides chart type selection and chart.js config structure for the Govio Map canvas. Covers bar/line/pie/doughnut/scatter with config templates and dark-theme color guidance.
---

# Chart Selector (Govio Map)

When the agent decides to visualize a DataFrame, use this skill to:
1. Pick the right chart type for the data shape and question
2. Build a valid chart.js config to pass to `govio_show_chart`

## 1. Chart Selection Decision Tree

```
Question: What are you trying to show?

├── Comparison (compare categories)
│   └── bar
│       ├── Vertical bar: time-axis comparison (monthly, weekly)
│       └── Horizontal bar (indexAxis: 'y'): item comparison (by product, by region)
│
├── Trend over time
│   ├── Single metric → line
│   └── Multiple metrics → multi-line (max 5 series)
│
├── Composition (part-to-whole, 2-5 categories)
│   ├── pie
│   └── doughnut (same as pie with cutout, preferred for readability)
│   ⚠️ 6+ categories → use bar instead
│
└── Relationship (correlation between 2 numeric variables)
    └── scatter
```

## 2. chart.js Config 结构说明

传给 `govio_show_chart` 的 `config` 是 chart.js 的顶层配置对象，三层结构：

```typescript
{
  type: string,              // "bar" | "line" | "pie" | "doughnut" | "scatter"
  data: {
    labels?: string[],       // 类别轴标签（bar/line/pie/doughnut 必填，scatter 不填）
    datasets: Array<{
      label: string,         // 系列名（显示在 legend）
      data: number[] | Array<{ x: number; y: number }>,
      backgroundColor?: string | string[],
      borderColor?: string | string[],
      borderWidth?: number,
      [key: string]: unknown,
    }>,
  },
  options?: {
    responsive?: boolean,
    maintainAspectRatio?: boolean,
    scales?: { x?: {...}, y?: {...} },
    plugins?: {
      legend?: { position?: 'top' | 'bottom' | 'left' | 'right' },
      tooltip?: { ... },
      title?: { display?: boolean, text?: string },
    },
  },
}
```

### 关键字段说明

**`type`**
决定渲染方式。Govio Map 支持 5 种。注意 scatter 必须显式 `"scatter"`，不能用 `"line"` 混用。

**`data.labels`**
类别轴的标签数组。bar/line/pie/doughnut 必填，且长度必须和每个 `dataset.data` 对齐。
scatter **不要填** `labels`——scatter 的坐标来自 `dataset.data` 里的 `{x, y}`。

**`data.datasets`**
数据系列数组。一个 chart 可以有多个 series（如 multi-line）。
- `data` 字段：bar/line/pie/doughnut 是 `number[]`，按索引对应 `labels`；scatter 是 `Array<{x, y}>`。
- `backgroundColor`：bar/pie/doughnut 的填充色，可传单色（全系列同色）或数组（每项不同色）。
- `borderColor`：line 的线色，必填；bar 的边框色，可选。

**`options.scales`**（仅 bar/line/scatter）
配置坐标轴。Govio Map 暗色主题需显式设网格和文字颜色：
```javascript
scales: {
  x: {
    grid: { color: 'rgba(255,255,255,0.08)' },
    ticks: { color: '#b4b4b4' },
  },
  y: {
    grid: { color: 'rgba(255,255,255,0.08)' },
    ticks: { color: '#b4b4b4' },
  },
}
```

**`options.plugins.legend`**
图例位置。pie/doughnut 建议设 `'right'`，bar/line 建议设 `'top'`。

## 3. Dark Theme Color Palette

背景 `#0f0f0f` / `#171717`，色板：
- 主色：`#3ecf8e` (brand green)
- 多系列：`['#3ecf8e', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899']`
- 网格线：`rgba(255,255,255,0.08)`
- 文字：`#b4b4b4`

## 4. Config 模板

### Bar

```javascript
{
  type: "bar",
  data: {
    labels: ["Jan", "Feb", "Mar", "Apr", "May"],
    datasets: [{
      label: "Revenue",
      data: [120, 150, 180, 200, 230],
      backgroundColor: "#3ecf8e",
      borderColor: "#3ecf8e",
      borderWidth: 1,
    }],
  },
  options: {
    plugins: { legend: { position: "top" } },
    scales: {
      x: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" } },
      y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" } },
    },
  },
}
```

### Line (multi-series)

```javascript
{
  type: "line",
  data: {
    labels: ["Jan", "Feb", "Mar", "Apr", "May"],
    datasets: [
      { label: "2025", data: [120, 150, 180, 200, 230], borderColor: "#3ecf8e", borderWidth: 2, tension: 0.3 },
      { label: "2026", data: [140, 170, 190, 220, 250], borderColor: "#60a5fa", borderWidth: 2, tension: 0.3 },
    ],
  },
  options: {
    plugins: { legend: { position: "top" } },
    scales: {
      x: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" } },
      y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" } },
    },
  },
}
```

### Pie / Doughnut

```javascript
{
  type: "doughnut",  // or "pie"
  data: {
    labels: ["Product A", "Product B", "Product C", "Other"],
    datasets: [{
      label: "Share",
      data: [45, 30, 20, 5],
      backgroundColor: ["#3ecf8e", "#60a5fa", "#f59e0b", "#898989"],
    }],
  },
  options: {
    plugins: { legend: { position: "right" } },
  },
}
```

### Scatter

```javascript
{
  type: "scatter",
  data: {
    datasets: [{
      label: "Price vs Sales",
      data: [
        { x: 10, y: 200 },
        { x: 15, y: 180 },
        { x: 20, y: 150 },
        { x: 25, y: 120 },
      ],
      backgroundColor: "#3ecf8e",
    }],
  },
  options: {
    plugins: { legend: { position: "top" } },
    scales: {
      x: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" }, title: { display: true, text: "Price", color: "#b4b4b4" } },
      y: { grid: { color: "rgba(255,255,255,0.08)" }, ticks: { color: "#b4b4b4" }, title: { display: true, text: "Sales", color: "#b4b4b4" } },
    },
  },
}
```

## 5. Per-Type Rules

### Bar
- Sort by size (except time-based)
- Same color, highlight only with accent
- Horizontal bar (`indexAxis: 'y'`) for long category labels

### Line
- Max 5 lines (excess: highlight key series + gray others)
- Hide point markers with 10+ data points (`pointRadius: 0`)
- Use `tension: 0.3` for smooth curves, omit for stepped

### Pie / Doughnut
- 2-5 categories only (6+ → use bar)
- Largest item first, "Other" item last
- Never use 3D pie
- Prefer doughnut over pie (center cutout improves readability)

## 6. Common Pitfalls

- **pie/doughnut 用 `labels` + `data`，不要传 x/y** — pie 没有 x/y 轴概念
- **scatter 的 `data` 元素是 `{x, y}` 对象** — 不是 `number[]`
- **`datasets.data` 长度要和 `labels` 对齐**（bar/line/pie/doughnut）
- **散点图误用 `"line"` type** → 不会渲染散点，必须用 `"scatter"`
- **暗色主题不设 `scales.ticks.color`** → 坐标轴文字看不见
- **pie/doughnut 不设 `backgroundColor`** → 默认灰色，辨识度差
- **scatter 不要传 `labels`** → 会被忽略但造成困惑
````

- [ ] **Step 2: 提交**

```bash
git add .claude/skills/chart-selector/SKILL.md
git commit -m "feat: add chart-selector skill for chart type and config guidance"
```

---

## Task 11: 最终验证

**Files:**
- 无修改，仅验证

- [ ] **Step 1: 全量类型检查**

Run:
```bash
npx tsc --noEmit
```

Expected: 无任何错误。

- [ ] **Step 2: ESLint**

Run:
```bash
npm run lint
```

Expected: 无错误。如有 `@typescript-eslint/no-explicit-any` 警告，检查 `ChartModal.tsx` 和 `ChartNode.tsx` 的 `as Parameters<typeof Chart>[1]` 是否需要调整。

- [ ] **Step 3: 构建**

Run:
```bash
npm run build
```

Expected: 构建成功，`dist/` 目录生成。

- [ ] **Step 4: 手动验证（启动 dev server）**

Run:
```bash
npm run dev
```

在浏览器打开 `http://localhost:5173`，通过 chat 让 agent 创建一个 chart 节点（例如"画一个 bar chart"），验证：
1. ChartNode 渲染出 chart.js canvas（非 `<img>`）
2. 点击 canvas 区打开全屏 modal
3. 点击"放大"按钮打开 modal
4. ESC / 背景点击 / X 按钮关闭 modal
5. modal 内 chart 比节点内更大且清晰

如果无法启动 WebSocket（agent 不连），可临时在 `canvas-store.ts` 的 `createGovioNode` 里手动 push 一个 chart event 测试渲染。

- [ ] **Step 5: 提交最终状态（如有 lint 修复）**

```bash
git status
```

如果有未提交的 lint 修复：
```bash
git add -A
git commit -m "fix: lint cleanup for chart.js node"
```

如果干净，无需提交。

---

## 完成标志

所有 task 完成后：
- `feat/chart-js-node` 分支包含 10 个提交（Task 1-10 各一个，Task 11 无提交或 1 个 lint 修复）
- `npm run build` 和 `npm run lint` 通过
- 浏览器手动验证 chart 节点渲染 + 放大 modal 交互正常
- 可合并到 main 或发起 PR
