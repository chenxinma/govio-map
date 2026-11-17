/**
 * 只读分享页的画布持久化中和（T3.5，陷阱 1）。
 *
 * `useCanvasStore` 带 zustand `persist`（localStorage key `govio-canvas-state`），而
 * `/share/<token>` 与主界面**同源共享**这份 localStorage。只读活视图要把远端画布灌进
 * 这个单例 store 才能复用五类节点组件，若不先中和持久化，远端（别人的）画布会被写进
 * `govio-canvas-state`——用户下次打开主界面就 rehydrate 成「别人的画布」，静默顶掉本机
 * 画布，属数据损坏级 bug。
 *
 * 做法：把 persist 的 storage 换成内存空实现。`getItem` 恒返回 null 也顺带保证只读页
 * 不会把本机 localStorage 里的画布当成初始内容（陷阱 2 的一半，另一半由 ShareView 的
 * 「远端数据到达前只渲染 loading」兜住）。
 *
 * 必须在**任何 `set()` 之前**调用：ShareView 在组件体首行调用它，早于所有 effect 与
 * 事件回调；幂等，重复调用无副作用。主界面（App 分支）永不 import 本模块，行为零变化。
 */
import { useCanvasStore } from "../../store/canvas-store";

let neutralized = false;

export function neutralizeCanvasPersistence(): void {
  if (neutralized) return;
  neutralized = true;
  useCanvasStore.persist.setOptions({
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
}

/** 只读页是否已中和画布持久化（测试断言用）。 */
export function isCanvasPersistenceNeutralized(): boolean {
  return neutralized;
}
