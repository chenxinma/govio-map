import type { AnalysisManifest, ManifestOrigin } from '../types';

/**
 * Analysis Manifest 的展示措辞（Phase 1 KR1 留痕 → KR4 交付导出共用）。
 *
 * 单独成文件的原因：节点「详情」面板（`ManifestDetails.tsx`）与交付报告附录 A
 * （`export-report.ts`）展示的是同一份留痕，字段措辞必须一致——两处各写一份
 * 会出现「同一个 origin 两种叫法」，交付物与画布对不上。
 * 纯常量与纯函数，不依赖 React，导出模块动态加载时不会拖进组件代码。
 */

/** `AnalysisManifest.origin` 的展示标签 */
export const MANIFEST_ORIGIN_LABELS: Record<ManifestOrigin, string> = {
  'observe-load': 'observe load',
  'show-dataframe': 'show dataframe',
  'sql-editor': 'SQL 编辑器',
  'assistant-sql': '助手消息 SQL',
};

/** 来源标签；未知来源原样返回（前向兼容服务端新增的 origin） */
export function manifestOriginLabel(origin: ManifestOrigin | string): string {
  return MANIFEST_ORIGIN_LABELS[origin as ManifestOrigin] ?? String(origin);
}

/**
 * 生成模型的展示串：`provider / id`，虚拟模型路由后追加 `→ responseModel`。
 * 人工执行（SQL 编辑器）没有模型信息，返回 `—（人工执行）`。
 */
export function manifestModelLabel(manifest: AnalysisManifest): string {
  const m = manifest.model;
  if (!m) return '—（人工执行）';
  const base = [m.provider, m.id].filter(Boolean).join(' / ');
  return m.responseModel && m.responseModel !== m.id ? `${base} → ${m.responseModel}` : base || '—';
}

