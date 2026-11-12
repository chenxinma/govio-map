/**
 * 血缘边分类与样式（T2.2）：`Edge.data.lineageKind` → 可视化区分。
 *
 * 数据血缘（绿色实线动画）与语义血缘（紫虚线静态，口径沿袭）的唯一色值/线型来源；
 * 画布边渲染与导出 HTML（export-report）共用，样式区分可在验证脚本中直接断言。
 */
import type { Edge } from '@xyflow/react';
import type { LineageKind } from '../types';

/** 血缘边外观（画布 ReactFlow 与导出 SVG 共用的取值） */
export interface LineageEdgeAppearance {
  stroke: string;
  strokeWidth: number;
  /** 虚线样式（undefined = 实线） */
  strokeDasharray?: string;
  /** 数据血缘动画流动；语义血缘是静态沿袭关系，不流动 */
  animated: boolean;
  /** 图例文案 */
  label: string;
  /** 边形状（smoothstep/straight/bezier），唯一来源 APPEARANCE */
  edgeType: 'smoothstep' | 'straight' | 'bezier';
}

const APPEARANCE: Record<LineageKind, LineageEdgeAppearance> = {
  data: { stroke: '#1db954', strokeWidth: 2, animated: true, label: '数据血缘', edgeType: "smoothstep" },
  // 语义血缘取 report 系 violet（green-deck 设计 token，hsl(270, 60%, ...) 色相），
  // 加深到 55% 保证浅色画布上的描边对比；虚线 + 不流动与数据血缘区分
  semantic: { stroke: 'hsl(270, 60%, 55%)', strokeWidth: 1, strokeDasharray: '6 4', animated: false, label: '语义血缘', edgeType: "bezier" },
};

export function lineageEdgeAppearance(kind: LineageKind): LineageEdgeAppearance {
  return APPEARANCE[kind];
}

/**
 * 语义血缘专用 Handle id：节点组件渲染同名 Handle（type 必须匹配）。
 * 朝向统一为下出上入（source@Bottom / target@Top）：配合方案B排版把语义同伴
 * 同列纵向堆叠（源在上、目标在下），线走在两节点间隙、不穿节点。
 * 两类语义边端点同构（sqlQuery↔sqlQuery、sourceTable↔sourceTable），不会混接。
 */
export const SEMANTIC_SOURCE_HANDLE = 'semantic-source';
export const SEMANTIC_TARGET_HANDLE = 'semantic-target';

/** 边的形状/动画/样式（唯一来源 APPEARANCE）：供 defaultEdgeOptions 与 lineageEdge 共用 */
export function lineageEdgeDefaults(
  kind: LineageKind,
): Pick<Edge, 'type' | 'animated' | 'style' | 'sourceHandle' | 'targetHandle'> {
  const ap = APPEARANCE[kind];
  return {
    type: ap.edgeType,
    animated: ap.animated,
    style: { stroke: ap.stroke, strokeWidth: ap.strokeWidth, ...(ap.strokeDasharray ? { strokeDasharray: ap.strokeDasharray } : {}) },
    // 语义边走上/下 Handle（与数据血缘左右向区分）；数据边省略键走默认左右 Handle
    ...(kind === 'semantic'
      ? { sourceHandle: SEMANTIC_SOURCE_HANDLE, targetHandle: SEMANTIC_TARGET_HANDLE }
      : {}),
  };
}

/** 创建血缘边的唯一工厂：调用方只提供 id/source/target，形状样式与 lineageKind 全部由此派生 */
export function lineageEdge(kind: LineageKind, parts: { id: string; source: string; target: string }): Edge {
  return { ...parts, ...lineageEdgeDefaults(kind), data: { lineageKind: kind } };
}

/**
 * 恢复/水合时把旧持久化的语义边升级到当前 Handle/形状（幂等，已升级的返回原引用；
 * 数据边不动）。否则改动前保存的画布恢复后语义边仍接左右默认 Handle。
 */
export function withSemanticHandles(edges: Edge[]): Edge[] {
  return edges.map((e) => {
    if (lineageKindOf(e) !== 'semantic') return e;
    const d = lineageEdgeDefaults('semantic');
    return e.sourceHandle === d.sourceHandle && e.targetHandle === d.targetHandle && e.type === d.type
      ? e
      : { ...e, ...d };
  });
}

/**
 * 读边的血缘分类。旧边没有 data / 未知值一律回退 `"data"`（兼容历史 sidecar、
 * 手动连线与 onConnect 之外的任何来源）。
 */
export function lineageKindOf(edge: { data?: unknown } | null | undefined): LineageKind {
  const data = edge?.data;
  if (data && typeof data === 'object' && (data as Record<string, unknown>).lineageKind === 'semantic') {
    return 'semantic';
  }
  return 'data';
}
