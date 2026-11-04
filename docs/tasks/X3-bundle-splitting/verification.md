# X3 验证记录（plotly 懒加载 / 前端 bundle 拆分）

> 本文记录基线、改造后 bundle 体积对比、chunk 断言与冒烟验证方式。全部命令在 Windows Git Bash 下运行。

## 1. 拆分前基线（pre-split baseline）

`npm run build`（`tsc -b && vite build`）产物：

| 产物 | 体积（bytes） | gzip（vite 报告） |
|---|---|---|
| `dist/assets/index-*.js`（主 chunk） | **6,071,629**（≈ 5.79 MiB） | 1,861.43 kB |
| `dist/assets/export-report-*.js`（已有懒加载 chunk） | 41,017 | 15.27 kB |
| `dist/assets/index-*.css` | 51,382 | 9.58 kB |
| `dist/index.html` | 790 | 0.42 kB |
| **产物总计（dist 全部文件）** | **6,164,818** | — |

主 chunk 体积 ≈ 6.07 MB，其中 `plotly.js-dist-min`（压缩后约 3.5 MB 级）被打进主 bundle，
是首屏加载的最大单体依赖。拆分目标：主 chunk 不再包含 plotly，仅 chart 节点/ChartModal
实际渲染时才动态加载。

## 2. 拆分后 bundle 对比

`npm run build`（改造后）产物：

| 产物 | 体积（bytes） | gzip（vite 报告） |
|---|---|---|
| `dist/assets/index-*.js`（主 chunk） | **1,424,488**（≈ 1.36 MiB） | 440.53 kB |
| `dist/assets/plotly.min-*.js`（**新增懒加载 chunk**） | 4,646,126（≈ 4.43 MiB） | 1,419.74 kB |
| `dist/assets/export-report-*.js`（已有懒加载 chunk） | 41,060 | 15.28 kB |
| `dist/assets/index-*.css` | 51,382 | 9.58 kB |
| `dist/index.html` | 790 | 0.42 kB |
| **产物总计** | **6,163,846** | — |

### 关键对比

| 指标 | 拆分前 | 拆分后 | 变化 |
|---|---|---|---|
| **主 chunk** | 6,071,629 | 1,424,488 | **↓ 76.5%**（-4,647,141 bytes） |
| 主 chunk gzip | 1,861.43 kB | 440.53 kB | ↓ 76.3% |
| 产物总计 | 6,164,818 | 6,163,846 | 基本不变（仅拆分、不增删功能） |
| plotly chunk | （混在主 chunk） | 4,646,126 | 拆出，按需加载 |

首屏不再加载 plotly（≈ 4.4 MiB），只在 chart 节点/ChartModal 实际渲染时动态加载，
用户可感知的首屏加载体积从 ≈ 6.1 MiB 降到 ≈ 1.5 MiB（主 chunk + css + html）。

## 3. 拆分后断言（主 chunk 不含 plotly）

- `npm run build` 的 chunk 清单出现独立的 `plotly.min-*.js`（4.6 MB），主 `index-*.js` 仅 1.42 MB
- 对主 chunk `dist/assets/index-*.js` 做字符串检查：
  - `grep -o "plotly.js-dist-min\|plotly.min\|import("` → 只剩 `plotly.min` 一处（懒加载 chunk 文件名引用）与 2 处 `import(`（plotly 与 export-report 两个动态入口），**无 plotly 运行时代码**
  - plotly 运行时代码（`newPlot`/`purge`/`react` 等）全部位于 `plotly.min-*.js`
- 三个 import 点（ChartNode / ChartModal / export-report）全部改为动态 `import()`，静态分析下 plotly 不再进入主 chunk

## 4. chart 节点 / ChartModal 渲染冒烟方式

- **不回归依据**：改造仅把 `import Plotly from 'plotly.js-dist-min'` 换成 `loadPlotly()`（懒加载 + 缓存），
  渲染调用 `Plotly.react(...)` 与清理 `Plotly.purge(el)` 的入参与原有逻辑逐字一致；错误路径沿用原有
  `hasError` 兑底（加载失败/渲染失败 → 显示「图表配置错误」）。
- **自动化断言**：`npm run build` 通过（tsc 类型检查覆盖 `PlotlyModule` 类型一致性）；
  `npm run verify`（含 verify:export 用 ChartNodeData/ChartRenderMap 静态契约）全绿。
- **手动冒烟建议**（dev server）：画布生成 chart 节点 → 缩略图渲染、点击「放大」ChartModal 渲染、
  关闭后重开；网络面板确认 `plotly.min-*.js` 仅在首次渲染 chart 时加载一次（模块级缓存）。

## 5. 验证门槛（全绿）

| 命令 | 结果 |
|---|---|
| `npm run build` | ✓（tsc -b + vite build，chunk 拆分符合预期） |
| `npm run lint` | ✓ 无告警 |
| `npm run verify` | ✓ 6 套脚本、共 460 断言、失败 0（manifest 92 / rerun 71 / audit 119 / export 126 / source-table 39 / cwd 13） |
| verify 全跑后 `git status --porcelain` | ✓ 只含本任务改动（ChartNode/ChartModal/use-plotly + docs），无散落垃圾 |

