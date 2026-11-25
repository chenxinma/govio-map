/**
 * 小地图（MiniMap）点击 → 画布坐标换算（X30）。
 *
 * Why not use MiniMap's own `onClick(event, position)`: 实测（moli/CDP 真实浏览器）
 * 该回调在 `<MiniMap>` 渲染出的 svg 上不可靠触发——手工调用 svg 的 React props.onClick
 * 能正常执行，但在同一 DOM 上派发原生 click 时 React 不派发（同一组件里自建的 svg onClick
 * 正常）。因此改为在外层 wrapper 上接 click（事件从 svg 冒泡到 wrapper），并用 svg 的
 * viewBox + 屏幕矩形自己换算坐标：viewBox 就是画布坐标系，换算即线性映射。
 */

export type ClientPoint = { x: number; y: number };
export type RectLike = { left: number; top: number; width: number; height: number };
export type ViewBoxLike = { x: number; y: number; width: number; height: number };

/** 解析 svg 的 viewBox 属性（"x y width height"），非法或缺省返回 null。 */
export function parseViewBox(value: string | null): ViewBoxLike | null {
  if (!value) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts;
  if (width === 0 || height === 0) return null;
  return { x, y, width, height };
}

/**
 * 把小地图上的一次点击（视口坐标 clientX/clientY）换算成画布坐标。
 * 尺寸非法（画布未测量、隐藏）时返回 null，调用方应跳过跳转。
 */
export function minimapClickToFlowPoint(
  click: ClientPoint,
  rect: RectLike,
  viewBox: ViewBoxLike | null
): ClientPoint | null {
  if (!viewBox) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: viewBox.x + ((click.x - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((click.y - rect.top) / rect.height) * viewBox.height,
  };
}
