/**
 * plotly.js-dist-min 懒加载（X3 bundle 拆分）。
 *
 * plotly.js-dist-min 是前端最大的单体依赖（压缩后约 3.5 MB 级）。过去被静态
 * import 进主 bundle，拖慢首屏。本模块把加载推迟到真正需要渲染图表的时刻：
 * chart 节点 / ChartModal 挂载时才 `import('plotly.js-dist-min')`，让 bundler
 * 把它拆成独立 chunk、首屏不再加载。
 *
 * 用法：组件在 effect 里 `const Plotly = await loadPlotly()`，拿到的 promise
 * 在模块级缓存（同一页面只加载一次）；加载失败时 reject，调用方按原有
 * 渲染失败路径降级（ChartNode / ChartModal 的 `hasError` 兜底）。
 */

/** plotly 模块的运行时实例类型（懒加载，见 use-plotly.ts） */
export type PlotlyModule = typeof import('plotly.js-dist-min').default;

let cached: Promise<PlotlyModule> | null = null;

/** 加载 plotly（模块级缓存；重复调用返回同一个 promise） */
export function loadPlotly(): Promise<PlotlyModule> {
  cached ??= import('plotly.js-dist-min').then((m) => m.default);
  return cached;
}
