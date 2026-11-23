# BUGFIX-minimap-navigation：小地图无法点击导航

日期：2026-11-23（用户报障，当前仅记录，待排期修复）
状态：**pending（未修复）**

## 现象

画布右下角的 MiniMap（小地图）「应该可以点击」，实际点击没有任何反应，用户无法通过小地图跳到画布的对应位置。

## 代码实证

| 位置 | 现状 |
|---|---|
| `src/components/Canvas/Canvas.tsx:73-88` | `<MiniMap nodeColor maskColor className />` —— 只传了展示类 props，**没有 `onClick`、没有 `pannable`/`zoomable` 显式设定、没有视口跳转逻辑** |
| `src/components/Share/ShareView.tsx:213-228` | 只读分享视图里同样是纯展示配置（`nodesDraggable={false} elementsSelectable={false}`，但小地图导航同样缺失） |
| `node_modules/@xyflow/react@12.12.0/dist/esm/index.mjs:4760-4820` | MiniMap 内置交互只来自 `XYMinimap(...)`：`selection.call(d3.zoom)` |
| `node_modules/@xyflow/system/dist/esm/index.mjs:2668-2740` | `XYMinimap.update()` 只注册 d3-zoom 的 `start` / `zoom` / `zoom.wheel` —— 即**拖拽平移**与**滚轮缩放**；`onClick` 仅用于把指针位置回传给使用方（`minimapInstance.pointer(event)`），本身不移动视口 |

## 根因判断

1. **「点击跳转」不是 xyflow 的默认行为**：d3-zoom 只在有位移（drag）或滚轮时触发，单次点击不会移动视口。`MiniMap` 虽然暴露 `onClick(event, {x, y})`，但它只提供坐标、不替你 `setViewport`，本项目两端都没有接这个回调 → 点击必然无反应。
2. **待实测确认**：拖拽平移/滚轮缩放是否也失效。代码路径上 `pannable`/`zoomable` 默认 `true`（`XYMinimap.update` 默认值），理论上拖拽可用；若实测拖拽也不动，则是另一个成因（层级覆盖 / `pointer-events` / svg 尺寸为 0），需浏览器 DevTools 取证后另立条目。报障描述为「无法操作」，倾向于连拖拽也失效，**修复前必须先做这一步实测**。

## 修复建议（待评审）

1. 给 MiniMap 加点击跳转：`onClick={(_e, pos) => setCenter(pos.x, pos.y, { zoom: getViewport().zoom, duration: 200 })}`（或 `setViewport`），并显式 `pannable` / `zoomable`。
2. **两处同改**：`Canvas.tsx`（可编辑态）与 `ShareView.tsx`（只读分享态）。分享态是只读的，但导航（平移/缩放视口）不属于数据副作用，应保留；若评审认为分享态也要禁用导航，则在 design 里写明并保持一致。
3. 若实测发现拖拽失效，先修成因（层级/pointer-events/尺寸），再补点击跳转——不要用点击跳转掩盖拖拽失效。
4. 光标反馈：hover 小地图时 `cursor: pointer` / `grab`，让「可点击」在视觉上成立（当前无任何 affordance，这也是用户感知不到可操作的直接原因之一）。

## 验证方式（预估）

- `tests/ui` 新增用例：渲染 `Canvas`/`ShareView`，断言 MiniMap 的 `onClick` 触发后视口 transform 变化（jsdom 下 d3-zoom 无法真实模拟拖拽，**只能覆盖 onClick → setCenter 这条路径**；拖拽/滚轮必须列入手动验证清单）
- 手动验证清单写进 `verification.md`：① 点击小地图左上/右下区域 → 视口居中到对应位置；② 在小地图上拖拽 → 画布实时平移；③ 小地图上滚轮 → 缩放；④ 分享视图（`/share/:token`）同样三条；⑤ 缩放边界（minZoom 0.1 / maxZoom 2）不被突破

## 遗留问题

- 若确认拖拽也失效，需要单独定位覆盖层成因（候选：`FloatingPreviewPanel` 的 `absolute z-40`、`CanvasToolbar` 的 `absolute top-3 right-3 z-10`，二者默认位置与小地图不重叠，但预览面板可被拖到右下角压住小地图）。
- 小地图默认位置为右下角，与应用内其他右下角浮层（预览面板）存在潜在重叠，是否需要提升小地图层级或调整默认位置，留待评审。
