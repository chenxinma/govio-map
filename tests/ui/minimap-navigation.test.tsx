// @vitest-environment jsdom
/**
 * X30 小地图点击导航（src/components/Canvas/CanvasMiniMap.tsx + src/utils/minimap.ts）。
 *
 * 锁四件事：
 *  1. 点击换算：小地图屏幕坐标 → 画布坐标（viewBox 线性映射），中心点击得到 viewBox 中心；
 *  2. 单击把该画布坐标设为视口中心，缩放保持当前倍率（不重置）；
 *  3. 拖拽平移 / 滚轮缩放仍开启（pannable、zoomable 显式为 true）；
 *  4. 小地图有可点击的光标反馈（className 带 cursor-pointer）。
 *
 * 这里用替身换掉 MiniMap（@xyflow/react v12 的 MiniMap 不会把 pannable/zoomable 渲染成
 * DOM，只能从属性层面断言）。真实 MiniMap 的渲染与整页接线由 tests/ui/share-view.test.tsx
 * 覆盖；浏览器真机三态（点击/拖拽/滚轮）见 docs/tasks/BUGFIX-minimap-navigation.md。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import CanvasMiniMap, { MINIMAP_CLASS_NAME } from '../../src/components/Canvas/CanvasMiniMap.js';
import { minimapClickToFlowPoint, parseViewBox } from '../../src/utils/minimap.js';

const rf = vi.hoisted(() => ({
  setCenter: vi.fn(),
  getZoom: vi.fn(() => 1.5),
}));

const miniMapSpy = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

// 替身 MiniMap：渲染与真库同结构的 svg（带 viewBox），便于验证点击换算
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const MiniMapStub = (props: Record<string, unknown>) => {
    miniMapSpy.props.push(props);
    return <svg data-testid="minimap-svg" className="react-flow__minimap-svg" viewBox="-100 -50 1000 500" />;
  };
  return { ...actual, useReactFlow: () => rf, MiniMap: MiniMapStub };
});

const nodeColor = () => '#a7a7a7';

function renderMiniMap() {
  return render(
    <ReactFlowProvider>
      <CanvasMiniMap nodeColor={nodeColor} />
    </ReactFlowProvider>
  );
}

/** jsdom 的 getBoundingClientRect 恒为 0，这里给出 200x100 的小地图像素尺寸 */
function stubRect(el: Element, left = 0, top = 0, width = 200, height = 100) {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  miniMapSpy.props.length = 0;
});

describe('parseViewBox', () => {
  it('解析合法 viewBox', () => {
    expect(parseViewBox('-100 -50 1000 500')).toEqual({ x: -100, y: -50, width: 1000, height: 500 });
  });

  it('缺失 / 段数不对 / 零尺寸一律返回 null（画布未测量时）', () => {
    expect(parseViewBox(null)).toBeNull();
    expect(parseViewBox('1 2 3')).toBeNull();
    expect(parseViewBox('0 0 0 500')).toBeNull();
    expect(parseViewBox('a b c d')).toBeNull();
  });
});

describe('minimapClickToFlowPoint', () => {
  const viewBox = { x: -100, y: -50, width: 1000, height: 500 };
  const rect = { left: 1000, top: 500, width: 200, height: 100 };

  it('小地图中心点 → viewBox 中心（画布坐标）', () => {
    expect(minimapClickToFlowPoint({ x: 1100, y: 550 }, rect, viewBox)).toEqual({ x: 400, y: 200 });
  });

  it('左上角 → viewBox 左上角', () => {
    expect(minimapClickToFlowPoint({ x: 1000, y: 500 }, rect, viewBox)).toEqual({ x: -100, y: -50 });
  });

  it('画布尺寸非法时返回 null（不跳转）', () => {
    expect(minimapClickToFlowPoint({ x: 1100, y: 550 }, { ...rect, width: 0 }, viewBox)).toBeNull();
    expect(minimapClickToFlowPoint({ x: 1100, y: 550 }, rect, null)).toBeNull();
  });
});

describe('CanvasMiniMap 点击跳转', () => {
  it('单击把小地图点击位置换算成的画布坐标设为视口中心，缩放沿用当前倍率', () => {
    renderMiniMap();
    const svg = screen.getByTestId('minimap-svg');
    stubRect(svg, 1000, 500, 200, 100);
    fireEvent.click(svg, { clientX: 1100, clientY: 550 });
    expect(rf.setCenter).toHaveBeenCalledTimes(1);
    expect(rf.setCenter).toHaveBeenCalledWith(400, 200, { zoom: 1.5, duration: 200 });
  });

  it('画布尺寸为 0（未测量）时点击不跳转', () => {
    renderMiniMap();
    const svg = screen.getByTestId('minimap-svg');
    stubRect(svg, 0, 0, 0, 0);
    fireEvent.click(svg, { clientX: 10, clientY: 10 });
    expect(rf.setCenter).not.toHaveBeenCalled();
  });

  it('保留拖拽与滚轮交互，并给出可点击光标反馈', () => {
    renderMiniMap();
    const props = miniMapSpy.props[0];
    expect(props.pannable).toBe(true);
    expect(props.zoomable).toBe(true);
    expect(props.className).toBe(MINIMAP_CLASS_NAME);
    expect(MINIMAP_CLASS_NAME).toContain('cursor-pointer');
  });
});
