# X3 设计：前端 bundle 拆分（plotly 懒加载）

## 1. 背景与动机

`plotly.js-dist-min` 是前端最大的单体依赖（压缩后约 4.4 MiB chunk），改造前被打进主
bundle（`dist/assets/index-*.js` ≈ 6.07 MiB），拖慢首屏加载。chart 节点/ChartModal 只在
用户真有图表时才需要 plotly，把它改为渲染时才动态加载可获得用户可感知的首屏性能提升，
且改造面小、与后端/测试区域零交集。

## 2. 方案

### 2.1 懒加载入口：`src/components/Nodes/use-plotly.ts`（新增）

- 用 `import('plotly.js-dist-min')` 动态加载，bundler（Vite）据此把 plotly 拆成独立 chunk
- **模块级缓存**：`loadPlotly()` 返回同一个 promise，同一页面只加载一次
- 导出 `PlotlyModule` 类型（`typeof import('plotly.js-dist-min').default`），供调用方做类型标注

### 2.2 三个 import 点统一处理

| 文件 | 改造前 | 改造后 |
|---|---|---|
| `src/components/Nodes/ChartNode.tsx` | `import Plotly from 'plotly.js-dist-min'` | `loadPlotly()` 动态加载，effect 内 await 后 `react()`/`purge()` |
| `src/components/Nodes/ChartModal.tsx` | 同上 | 同上 |
| `src/utils/export-report.ts` | 已是 `await import('plotly.js-dist-min')`（本就不在主 chunk） | **保持不变**（见下） |

### 2.3 export-report.ts 为何不改

- 它已用 `await import('plotly.js-dist-min')` 动态加载，本就不在主 chunk（build 产物有独立
  `export-report-*.js`），无需为拆分再动
- 它被 `scripts/verify-export-report.ts` 直接 import 做单元验证。若让它 import
  `components/Nodes/use-plotly`，会让 utils → components 产生反向耦合（`src/utils` 是纯工具层，
  不应依赖组件层），也会让 verify 脚本的模块图牵连 React 组件。为避免跨层耦合与测试面扩张，
  **保留其现有动态 import 写法**，不强行三处统一到同一 helper。三处的「懒加载」语义一致
  （都是动态 import、都不进主 chunk），这已满足 acceptance。

## 3. 取舍

- **缓存粒度**：模块级单 promise（简单、够用）；不做 TTL/失效，图表库无需重载。
- **错误路径**：加载/渲染失败沿用组件原有 `hasError` 兑底（显示「图表配置错误」），不引入新 UI。
- **不重构 chart 组件**：只换加载方式，渲染调用与清理逻辑逐字保留（`react()` 入参、`purge(el)` 时机）。

## 4. 验证

见 `verification.md`（基线/拆分后体积对比、chunk 断言、冒烟方式、验证门槛全绿）。

## 5. 遗留问题

- `dist/assets/index-*.js` 主 chunk 仍有 1.42 MiB（gzip 440 kB）。若要进一步优化首屏，可分析
  其他大依赖（如 `@uiw/react-codemirror` + codemirror 系列、`react-markdown`/remark 系列）是否
  也值得按需懒加载（如仅在 SQL 编辑器/Markdown 渲染时加载）。**本次范围纪律内不扩大改造**，
  仅记录待议。
