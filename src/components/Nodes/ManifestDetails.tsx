import { memo } from 'react';
import type { AnalysisManifest } from '../../types';
import { manifestModelLabel, manifestOriginLabel } from '../../utils/manifest-labels';

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-2 text-[10px] font-mono leading-relaxed">
      <span className="shrink-0 w-[62px] text-text-dim">{label}</span>
      <span className="text-text-secondary break-all" title={title ?? value}>{value}</span>
    </div>
  );
}

/**
 * Analysis Manifest 只读详情面板（Phase 1 KR1）。
 * dataFrame / sqlQuery 节点的「详情」按钮展开后渲染，仅展示服务端固化的留痕字段，
 * 不提供编辑入口——留痕一旦被改写就失去复现意义。
 */
function ManifestDetails({ manifest }: { manifest: AnalysisManifest }) {
  const checksum = manifest.checksum;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted">
        分析留痕 · Manifest v{manifest.schemaVersion}
      </div>
      <Row label="来源" value={manifestOriginLabel(manifest.origin)} />
      <Row label="数据源" value={manifest.datasource || '—'} />
      <Row label="执行时间" value={manifest.executedAt} />
      {manifest.dfName && <Row label="DataFrame" value={manifest.dfName} />}
      {typeof manifest.rowCount === 'number' && (
        <Row label="行 × 列" value={`${manifest.rowCount} × ${manifest.columnCount ?? '?'}`} />
      )}
      {checksum && (
        <Row
          label="校验和"
          value={`${checksum.algorithm}: schema ${checksum.schemaHash} · sql ${checksum.sqlHash}`}
          title={`规模 ${checksum.rowCount} 行 × ${checksum.columnCount} 列；结构哈希含列名与 dtype，不含数据内容`}
        />
      )}
      <Row label="生成模型" value={manifestModelLabel(manifest)} />
      <Row label="会话" value={manifest.sessionId || '—'} />
      <Row label="权限决策" value={manifest.permissionDecisionId ?? '未关联'} />
      {manifest.sourceDataFrames && manifest.sourceDataFrames.length > 0 && (
        <Row label="上游 DF" value={manifest.sourceDataFrames.join(', ')} />
      )}
      <div className="pt-1">
        <div className="text-[10px] font-mono text-text-dim mb-1">SQL 全文</div>
        {manifest.sql ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-primary/60 px-2 py-1.5 text-[10px] font-mono leading-relaxed text-text-secondary">
            {manifest.sql}
          </pre>
        ) : (
          <div className="text-[10px] font-mono text-text-dim italic">
            无 SQL 上下文（该节点不可一键复跑）
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ManifestDetails);
