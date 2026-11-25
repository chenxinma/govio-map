import { useCallback, useRef } from 'react';
import { MiniMap, useReactFlow, type Node } from '@xyflow/react';
import { minimapClickToFlowPoint, parseViewBox } from '../../utils/minimap';

/**
 * 小地图：单击跳转 + 拖拽平移 + 滚轮缩放（X30）。
 *
 * 行为约定（见 docs/tasks/BUGFIX-minimap-navigation.md）：
 *  - 单击：把视口中心移到点击位置对应的画布坐标，缩放保持用户当前倍率（不重置）
 *  - 拖拽：沿用 xyflow 内置的 d3-zoom 平移（pannable）；拖拽收尾的 click 由 d3-drag
 *    在 window 捕获阶段的一次性抑制器吞掉（node_modules/d3-drag/src/nodrag.js `yesdrag`），
 *    不会误触发跳转
 *  - 滚轮：沿用 xyflow 内置的缩放（zoomable）
 *  - 只读分享视图同样启用：导航只移动视口，不产生任何数据副作用
 *
 * 为什么不用 MiniMap 自带的 `onClick(event, position)`：真实浏览器实测该回调在 MiniMap
 * 渲染的 svg 上不派发（React 不调 svg 的 props.onClick，而同组件自建的 svg 正常）。
 * 改为在外层 `display: contents` wrapper 上接 click，并用 svg 的 viewBox 自行换算坐标
 * （viewBox 即画布坐标系）。wrapper 不产生盒子，不影响 Panel 的右下角定位。
 */
export const MINIMAP_CLASS_NAME =
  '!bg-bg-primary !border-border-default !rounded-lg cursor-pointer';

type Props = {
  nodeColor: (node: Node) => string;
  className?: string;
  /** 跳转动画时长（ms）；0 = 立即跳转 */
  duration?: number;
};

export default function CanvasMiniMap({ nodeColor, className = MINIMAP_CLASS_NAME, duration = 200 }: Props) {
  const { setCenter, getZoom } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      const svg = wrapper.current?.querySelector('svg.react-flow__minimap-svg');
      if (!svg) return;
      const point = minimapClickToFlowPoint(
        { x: event.clientX, y: event.clientY },
        svg.getBoundingClientRect(),
        parseViewBox(svg.getAttribute('viewBox'))
      );
      if (!point) return;
      setCenter(point.x, point.y, { zoom: getZoom(), duration });
    },
    [duration, getZoom, setCenter]
  );

  return (
    <div ref={wrapper} style={{ display: 'contents' }} onClick={onClick}>
      <MiniMap
        nodeColor={nodeColor}
        maskColor="rgba(0, 0, 0, 0.08)"
        className={className}
        pannable
        zoomable
      />
    </div>
  );
}
