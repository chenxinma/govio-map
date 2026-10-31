// plotly.js-dist-min ships no TS types; declare only the surface we use.
// ponytail: add @types/plotly.js if full figure typing is ever needed.
declare module "plotly.js-dist-min" {
  export interface PlotlyConfig {
    responsive?: boolean;
    displayModeBar?: boolean | string;
    [key: string]: unknown;
  }

  const Plotly: {
    react(
      root: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: PlotlyConfig,
    ): Promise<unknown>;
    /** 首次绘制（交付导出把 chart 节点画到离屏容器上，再 toImage 成静态图片） */
    newPlot(
      root: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: PlotlyConfig,
    ): Promise<unknown>;
    /** 导出为 data URL；format 为 'svg' 时返回矢量图（WebGL trace 只支持栅格格式） */
    toImage(
      root: HTMLElement,
      opts?: { format?: 'png' | 'svg' | 'jpeg' | 'webp'; width?: number; height?: number; scale?: number },
    ): Promise<string>;
    purge(root: HTMLElement): void;
  };

  export default Plotly;
}
