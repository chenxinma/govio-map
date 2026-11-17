import { createContext, useContext } from "react";

/**
 * 只读画布上下文（T3.5 活视图）。
 *
 * 五类节点组件不只是展示——卡片内有「引用 / 删除 / 预览 / 复跑 / 编辑 SQL」等入口，
 * 会调 store action 或打 `POST /api/preview`、`/api/rerun-dataframe`、`/api/execute-sql`，
 * 而这些接口作用于**服务端当前会话单例**（即分享链接的源实例），构成对源 session 的
 * 写/执行副作用。只读页复用同一套节点组件，就必须有一个开关把这些入口全部关掉。
 *
 * 默认值 `false` ⇒ 主画布（无 Provider）行为零变化；`ShareView` 用
 * `<ReadOnlyCanvasContext.Provider value>` 包住 ReactFlow，节点组件据此隐藏副作用入口。
 * 纯本地展示态（字段/口径/关系/Manifest 展开、图表放大）不受影响——只读页与主画布
 * 的视觉一致性要求它们照常可用。
 */
export const ReadOnlyCanvasContext = createContext<boolean>(false);

/** 当前是否处于只读画布（分享活视图）中。 */
export function useReadOnlyCanvas(): boolean {
  return useContext(ReadOnlyCanvasContext);
}
