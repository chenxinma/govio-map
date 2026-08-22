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
    purge(root: HTMLElement): void;
  };

  export default Plotly;
}
