# BUGFIX-minimap-navigation：小地图无法点击导航

日期：2026-11-23（用户报障）→ 2026-11-25（修复）
状态：**已修复并验收（X30，PR #52 已合并，用户人工验证通过）**

## 现象

画布右下角的 MiniMap（小地图）「应该可以点击」，实际点击没有任何反应，用户无法通过小地图跳到画布的对应位置。

## 代码实证（修复前）

| 位置 | 现状 |
|---|---|
| `src/components/Canvas/Canvas.tsx:73-88` | `<MiniMap nodeColor maskColor className />` —— 只传了展示类 props，**没有 `onClick`、没有视口跳转逻辑** |
| `src/components/Share/ShareView.tsx:213-228` | 只读分享视图里同样是纯展示配置，小地图导航同样缺失 |
| `node_modules/@xyflow/system/dist/esm/index.mjs:2668-2740` | `XYMinimap.update()` 只注册 d3-zoom 的 `start` / `zoom` / `zoom.wheel` —— 即**拖拽平移**与**滚轮缩放**；`onClick` 仅把指针位置回传给使用方，本身不移动视口 |

## 根因

**「点击跳转」不是 xyflow 的默认行为**：d3-zoom 只在有位移（drag）或滚轮时触发，单次点击不会移动视口。`MiniMap` 暴露的 `onClick(event, position)` 只提供坐标、不替你 `setViewport`，本项目两端都没有接这个回调 → 点击必然无反应。

拖拽平移本身是可用的（`pannable` 默认 true），因此本次问题是「缺点击跳转 + 缺 affordance」，不是「整块不可交互」。

## 修复（X30）

新增共享组件 `src/components/Canvas/CanvasMiniMap.tsx`（`Canvas.tsx` 与 `ShareView.tsx` 同改调用它）：

1. **点击跳转**：点击 → 用 svg 的 `viewBox` + 屏幕矩形把点击位置线性换算成画布坐标 → `setCenter(x, y, { zoom: getZoom(), duration: 200 })`。缩放保持用户当前倍率，不重置视口。
2. **显式 `pannable` / `zoomable`**：把原本依赖默认值的语义写死，避免后续升级把拖拽/滚轮关掉。
3. **光标反馈**：className 追加 `cursor-pointer`（此前小地图没有任何「可操作」视觉线索）。
4. **只读分享视图保留导航**：移动视口不是数据副作用，`/share/:token` 页面同样可点击跳转。
5. **拖拽不误跳**：d3-drag 在指针位移超过 `clickDistance`（默认 0）时会于 window **捕获阶段**注册一次性 click 抑制器（`node_modules/d3-drag/src/nodrag.js:15-20` `yesdrag`），拖拽收尾的 click 到不了处理函数，故无需自算阈值。实测确认拖拽平移后视口不会被拉回指针处。

### 关键实现取舍：为什么不用 `MiniMap` 自带的 `onClick`

真实浏览器实测（moli CDP + Chrome 145，详见下方取证）发现：**`<MiniMap>` 渲染出的 svg 上 React 的 `onClick` 不派发**——手工调用该 svg 的 `props.onClick` 能正常执行、且同一组件里自建的探针 `<svg onClick>` 点击也能触发，唯独库渲染的那个 svg 在原生点击时 React 不回调。为避免踩这条不明路径，改为在**外层 `display: contents` wrapper** 上接 click（事件从 svg 冒泡到 wrapper），坐标换算自己算（`src/utils/minimap.ts`）。

- wrapper 用 `display: contents` 不生成盒子，`Panel` 的右下角绝对定位不受影响；
- 换算函数 `minimapClickToFlowPoint()` 是纯函数，单测覆盖中心/角点/尺寸非法三类输入；
- 副作用：不再依赖库的 `pointer()` 实现，xyflow 升级不会影响换算。

## 验证

### 自动化（`npm run build` / `lint` / `verify` 全绿）

| 项 | 结果 |
|---|---|
| `tests/ui/minimap-navigation.test.tsx`（新增） | 8 例：`parseViewBox` ×2、`minimapClickToFlowPoint` ×3（中心/左上/尺寸非法）、组件点击 → `setCenter(400,200,{zoom:1.5,duration:200})`、尺寸为 0 不跳转、`pannable/zoomable/className` 契约 |
| 脚本断言 | 92 / 71 / 119 / 148 / 39 / 54 / 77 / 13 + 58 = **671**（零回归） |
| vitest | integration 34 文件 **484** 例（476 + 8）；UI 11 文件 **95** 例（87 + 8） |
| `git status --porcelain` | verify 全跑后仅本任务改动 |

### 浏览器真机取证（moli CDP，1600×1100，`http://localhost:5173`，3 个 dataFrame 节点散布 0/0、2400/300、1200/1800）

| 场景 | 结果 |
|---|---|
| 点击小地图左上 15% | `translate(0px)` → `translate(1004px, 899px)`，视口移向画布左上 ✅ |
| 点击小地图右下 85% | → `translate(-449.8px, -2121.5px)`，视口移向画布右下 ✅ |
| 在小地图上拖拽 40×25px | 视口平移（`-449.8,-2121.5` → `-876.1,-1894.2`），**未被拉回指针处**、缩放不变 ✅ |
| 小地图 hover 光标 | `pointer` ✅ |
| 主画布滚轮缩放（对照） | `scale(1)` → `scale(2)` ✅（证明 store 的 pan/zoom 链路正常） |
| **小地图滚轮缩放** | ❌ 未生效（`deltaY` -120 / -600 均无变化） |

## 人工验证（用户，2026-11-25）

用户在浏览器中人工验证通过：点击小地图跳转到对应位置、在可编辑画布上拖拽平移均正常（用户原话「小地图也人工验证过了」）。
本次未逐一确认滚轮缩放与只读分享页三条清单，滚轮项仍见下方遗留 1。

## 遗留问题

1. **小地图滚轮缩放不生效**：与本次修复无关（修复前 `pannable`/`zoomable` 默认即为 true，行为一致），怀疑是 `XYMinimap` 的 `zoom.wheel` 分支在库内少走了一步（或 CDP 合成 wheel 与 d3-zoom 的 `filter`/`sourceEvent` 判定不匹配）。本次未改其语义，需要真实鼠标/触控板复测后再决定是否另立条目。**手动验证项**：浏览器里把鼠标放到小地图上滚轮 → 是否缩放。
2. 小地图默认位置（右下角）与应用内其它右下角浮层（`FloatingPreviewPanel` 可被拖到右下角）存在潜在重叠；本次未调整层级与默认位置。
3. 点击跳转是「立即跳转 + 200ms 动画」，未做双击/右键等扩展交互。

## 手动验证清单（合并前/发布前由人复跑）

1. 可编辑画布：点击小地图左上、右下、中心 → 视口平滑居中到对应位置，缩放不变；
2. 可编辑画布：在小地图上拖拽 → 画布实时平移，松手后不被拉回；
3. 可编辑画布：小地图上滚轮 → 观察是否缩放（对应遗留 1）；
4. `/share/:token` 只读分享页：重复 1-3，确认导航可用且不触发任何写操作；
5. 缩放边界：小地图点击后缩放仍受 `minZoom 0.1 / maxZoom 2` 约束。
