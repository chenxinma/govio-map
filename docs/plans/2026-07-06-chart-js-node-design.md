# Chart.js 节点设计（替换 PNG 渲染）

## 目标

将图表渲染从 govio-cli 生成 PNG + base64 透传的方式，改为前端 chart.js 直接渲染。agent 通过 `govio_show_chart` 工具传递 chart.js config，前端 ChartNode 用 chart.js 实例渲染 canvas。同时提供全屏放大 modal 和 chart-selector skill 指导 agent 选型与配置。

## 背景

当前实现（commit `01ac29e`）：
- agent 调 `govio-cli observe chart ...` 生成 PNG 文件
- agent 调 `govio_show_chart` 工具传 `outputPath`
- 服务端 `readFileSync` 读 PNG → base64 → 推 node event
- 前端 ChartNode 用 `<img src="data:image/png;base64,...">` 渲染

问题：
- 渲染依赖 govio-cli 的 matplotlib 环境，前端无法调整图表细节
- PNG 是位图，放大失真
- 节点内无法交互（hover tooltip 等 chart.js 原生能力缺失）

## 架构

```
agent 调 govio-cli 取数（query/observe load）
    ↓
agent 调 govio_show_chart(config)  ← chart.js config 透传
    ↓
server push chart node event（含 config，不含 imageBase64）
    ↓
前端 store 创建 chart node
    ↓
ChartNode 用 chart.js 渲染 <canvas>
    ↓
点击 canvas → ChartModal 全屏放大渲染
```

与旧流程的关键差异：
- agent 不再调 `govio-cli observe chart`
- `govio_show_chart` 参数从 `outputPath` 改为 `config`
- ChartNode 从 `<img base64>` 改为 `<canvas>` + chart.js 实例
- 移除 `imageBase64` 字段，新增 `config` 字段

## 工具参数设计

工具名：`govio_show_chart`（沿用旧名，参数完全替换）

```typescript
{
  title: string,              // 节点标题，如 "Chart: df_sales (bar)"
  sourceDf?: string,          // 来源 DataFrame 名，用于节点头部展示
  config: {                   // chart.js config 透传，不校验内部结构
    type: string,             // "bar" | "line" | "pie" | "doughnut" | "scatter" | ...
    data: {
      labels?: string[],
      datasets: Array<{
        label: string,
        data: number[] | Array<{x: number, y: number}>,
        [key: string]: unknown  // backgroundColor, borderColor 等由 agent 按 chart-selector skill 填
      }>
    },
    options?: { [key: string]: unknown }
  }
}
```

设计要点：
- `config` 用宽泛 schema（`type` + `data` 必填，其余 `unknown`），不做 chart.js 全量校验——校验逻辑留在 chart.js 运行时
- `title` 和 `sourceDf` 提到顶层，属于节点元数据，不混入 chart.js config
- 工具 execute 时不再读文件、不再 base64，直接把 config 推到 node queue
- 移除字段：`outputPath`、`imageBase64`、`chartType`、`xColumn`、`yColumn`

## 前端渲染设计

### 依赖

新增 `chart.js`（不引入 `react-chartjs-2`，直接用 chart.js API，避免 wrapper 限制）。

### ChartNode 改造

```tsx
function ChartNode({ data, id }: NodeProps) {
  const nodeData = data as unknown as ChartNodeData;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, nodeData.config);
    return () => chartRef.current?.destroy();
  }, [nodeData.config]);

  return (
    <div className="w-[420px] ...">
      <div className="...">{nodeData.title} <span>{nodeData.sourceDf}</span></div>
      <div
        className="border-t border-border-subtle p-2 cursor-zoom-in"
        onClick={() => setShowModal(true)}
      >
        <canvas ref={canvasRef} className="w-full h-[260px]" />
      </div>
      <div className="...">
        <button onClick={引用}>引用</button>
        <button onClick={() => setShowModal(true)}><Maximize2 /></button>
        <button onClick={删除}><Trash2 /></button>
      </div>
      {showModal && (
        <ChartModal config={nodeData.config} title={nodeData.title} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}
```

### ChartModal 组件（新增 `src/components/Nodes/ChartModal.tsx`）

```tsx
function ChartModal({ config, title, onClose }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const modalConfig = structuredClone(config);
    modalConfig.options = {
      ...modalConfig.options,
      responsive: true,
      maintainAspectRatio: false,
    };
    chartRef.current = new Chart(canvasRef.current, modalConfig);
    return () => chartRef.current?.destroy();
  }, [config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[860px] max-w-[90vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-medium text-text-primary">{title}</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>
        <div className="p-4 flex-1 min-h-0">
          <canvas ref={canvasRef} className="w-full h-[520px]" />
        </div>
      </div>
    </div>
  );
}
```

### 设计要点

- 节点内 canvas 固定 `420×260`，modal 内 canvas 固定 `860×520`，两处独立 chart.js 实例（避免 resize 冲突）
- modal 用 `structuredClone` 深拷贝 config，防止两实例共享 `data` 引用导致 chart.js 内部状态污染
- modal 强制 `responsive: true` + `maintainAspectRatio: false`，自适应容器
- ESC + 背景点击 + X 按钮三种关闭方式
- 节点内点击 canvas 区或底部放大按钮均可打开 modal（双入口）
- `ChartModal` 用 React Portal 挂到 `document.body`，避免 ReactFlow 的 transform 缩放影响 modal 定位
- 节点内和 modal 内的 canvas 都用 ErrorBoundary 包裹，config 非法时显示占位文案

### Chart.js 注册

在 `ChartNode.tsx` 顶部用 `Chart.register(...registerables)` 一次性全量注册（chart.js 自带 `registerables`），避免每个 chart type 单独注册的维护成本。

### ChartNodeData 类型变更

```typescript
export interface ChartNodeData {
  type: 'chart';
  title: string;
  createdAt: string;
  sourceDf?: string;
  config: { type: string; data: { ... }; options?: { ... } };
  [key: string]: unknown;
}
```

移除 `chartType`、`xColumn`、`yColumn`、`imageBase64`。

## chart-selector skill 设计

### 位置

`.claude/skills/chart-selector/SKILL.md`（项目级 skill，跟随仓库）

### 策略

在项目内创建 Govio Map 专属版本，复用 `/home/macx/work/skills/skills/chart-selector/skill.md` 的选型方法论，补充 chart.js 配置模板和项目集成部分。不直接 symlink 通用版，因为：
- 通用版含 KPI Card / Heatmap / Table / Dashboard Layout 等 Govio Map 不支持的类型
- Govio Map 需要暗色主题色板（通用版是浅色配色）
- 需要明确和 `govio_show_chart` 工具的对接

### SKILL.md 内容骨架

```markdown
---
name: chart-selector
description: Use when calling govio_show_chart tool — guides chart type selection
  and chart.js config structure for the Govio Map canvas.
---

# Chart Selector (Govio Map)

## 1. Chart Selection Decision Tree
（复用参考文件决策树，裁剪到 5 种类型）
├── Comparison > bar
├── Trend over time > line
├── Composition (2-5 items) > pie / doughnut
└── Relationship (2 numeric) > scatter

## 2. chart.js Config 结构说明

传给 govio_show_chart 的 config 是 chart.js 的顶层配置对象，三层结构：

{
  type: string,              // "bar" | "line" | "pie" | "doughnut" | "scatter"
  data: {
    labels?: string[],       // 类别轴标签（bar/line/pie/doughnut 必填，scatter 不填）
    datasets: Array<{
      label: string,
      data: number[] | Array<{x: number, y: number}>,
      backgroundColor?: string | string[],
      borderColor?: string | string[],
      borderWidth?: number,
    }>
  },
  options?: {
    responsive?: boolean,
    maintainAspectRatio?: boolean,
    scales?: { x: {...}, y: {...} },
    plugins?: {
      legend?: { position?: 'top' | 'bottom' | 'left' | 'right' },
      tooltip?: { ... },
      title?: { display?: boolean, text?: string },
    }
  }
}

### 关键字段说明

type：决定渲染方式。scatter 必须显式 "scatter"，不能用 "line" 混用。

data.labels：类别轴标签数组。bar/line/pie/doughnut 必填，长度和每个 dataset.data 对齐。
scatter 不要填 labels——坐标来自 dataset.data 里的 {x, y}。

data.datasets：数据系列数组。
- data 字段：bar/line/pie/doughnut 是 number[]，按索引对应 labels；scatter 是 Array<{x, y}>。
- backgroundColor：bar/pie/doughnut 的填充色，单色或数组。
- borderColor：line 的线色必填；bar 的边框色可选。

options.scales（仅 bar/line/scatter）：暗色主题需显式设网格和文字颜色：
scales: {
  x: { grid: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#b4b4b4' } },
  y: { grid: { color: 'rgba(255,255,255,0.08)' }, ticks: { color: '#b4b4b4' } }
}

options.plugins.legend：pie/doughnut 建议 'right'，bar/line 建议 'top'。

## 3. Dark Theme Color Palette

背景 #0f0f0f / #171717，色板：
- 主色: #3ecf8e (brand green)
- 多系列: ['#3ecf8e', '#60a5fa', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899']
- 网格线: rgba(255,255,255,0.08)
- 文字: #b4b4b4

## 4. Config 模板（每种 type 一个完整示例）

### Bar
（完整 config，含 scales + dark theme）

### Line
（完整 config，含 multi-series 示例）

### Pie / Doughnut
（强调 labels + single dataset，backgroundColor 用色板数组）

### Scatter
（强调 data 是 [{x,y}]，无 labels）

## 5. Per-Type Rules（精选自参考文件）

### Bar
- Sort by size (except time-based)
- Same color, highlight only with accent

### Line
- Max 5 lines (excess: highlight + gray others)
- Hide markers with 10+ data points

### Pie/Donut
- 2-5 categories only (6+ → use bar)
- Largest item first, "Other" last
- Never 3D pie

## 6. Common Pitfalls
- pie/doughnut 用 labels + data，不要传 x/y
- scatter 的 data 元素是 {x, y} 对象
- datasets.data 长度要和 labels 对齐（bar/line/pie）
- 散点图误用 "line" type → 不会渲染散点，必须用 "scatter"
- 暗色主题不设 scales 文字色 → 坐标轴文字看不见
- pie/doughnut 不设 backgroundColor → 默认灰色，辨识度差
```

### 设计要点

- 决策树和 per-type rules 精选自参考文件，去掉 Govio Map 不支持的 KPI Card / Heatmap / Table / Treemap
- 第 2 节专门讲 config 三层结构（type / data / options），用 TypeScript 接口形式给全貌
- 每个关键字段单独说明取值规则和适用 chart type
- `data.labels` 和 `datasets.data` 的对齐关系单独强调
- scatter 的 `{x,y}` vs bar/line 的 `number[]` 差异在字段说明和 pitfalls 里都点明
- scales 的暗色主题配置给具体代码片段，agent 可直接复制
- 模板（第 4 节）和结构说明（第 2 节）分离——结构说明讲规则，模板给可复制示例
- skill 随仓库提交，团队共享

## 代码改动清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/components/Nodes/ChartModal.tsx` | 全屏放大 modal 组件 |
| `.claude/skills/chart-selector/SKILL.md` | chart 选型 + chart.js config 指导 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `package.json` | 新增 `chart.js` 依赖 |
| `src/types/index.ts` | `ChartNodeData`：移除 `chartType`/`xColumn`/`yColumn`/`imageBase64`，新增 `config` + `sourceDf?` |
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent`：chart 字段同步改造（移除 `imageBase64`/`chartType`/`xColumn`/`yColumn`，新增 `config`） |
| `server/extensions/govio-canvas.ts` | 重写 `govio_show_chart` 工具：参数从 `outputPath` 改为 `config`；移除 `readFileSync` + base64 逻辑 |
| `src/store/canvas-store.ts` | chart node 创建分支：从 `event.config` 读配置，不再读 `imageBase64` |
| `src/components/Nodes/ChartNode.tsx` | 整体重写：`<img>` 换成 `<canvas>` + chart.js 实例 + 放大 modal 触发 |
| `src/services/canvas-service.ts` | chart 字段同步：移除 `imageBase64`/`chartType`/`xColumn`/`yColumn`，新增 `config`（确认有引用，line 21-25） |

### 移除的依赖/导入

- `ChartNode.tsx` 不再需要 `BarChart3`/`LineChart` icon 区分（chart type 在 config 里），但可保留 icon 用于节点头部装饰
- `govio-canvas.ts` 不再需要 `readFileSync`（仅用于读 PNG，line 1 的 import 一并移除）

### 不动的地方

- `mock-ai.ts` 不动（chart 节点不走 mock 路径，由 agent tool 驱动）
- 其他 node 类型（sourceTable/sqlQuery/dataFrame/report）不动
- ReactFlow 画布布局、边、引用机制不动

## 分支策略

- 从 `main` 切出 `feat/chart-js-node`
- 实现按依赖顺序：types → server tool → store → ChartNode → ChartModal → skill → 依赖安装
- 完成后跑 `npm run build`（含 tsc）验证类型，再提交

## 错误处理

- 节点内和 modal 内的 canvas 都用 ErrorBoundary 包裹，config 非法时显示"图表配置错误"占位文案，不让整个 ReactFlow 崩
- 工具 execute 不做 config 校验，运行时错误由前端 ErrorBoundary 兜底
