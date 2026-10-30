import { memo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Loader2, XCircle } from 'lucide-react';
import type { DataFrameNodeData, RerunOutcome, RerunRecord } from '../../types';
import { formatRerunTime } from '../../utils/rerun';

/**
 * DataFrame 复跑状态条（Phase 1 KR2）：三态展示 + 复跑记录。
 *
 * 状态来源分两类：
 *  - 临时态（`running` / `requestError`）：复跑进行中、请求本身失败（后端未启动等），
 *    不落盘，刷新即消失
 *  - 留痕态（`data.rerunHistory`）：服务端真实执行过的一次复跑结论，随 canvas sidecar 持久化。
 *    漂移时原 Manifest 不被覆盖，旧值/新值/时间都在记录里。
 */

const OUTCOME_META: Record<RerunOutcome, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  identical: { label: '复现一致', className: 'text-brand', Icon: CheckCircle2 },
  drift: { label: '漂移', className: 'text-warning', Icon: AlertTriangle },
  error: { label: '复跑失败', className: 'text-error', Icon: XCircle },
};

function snapshotLabel(record: RerunRecord): string {
  const after = record.after;
  if (!after) return '';
  return `${after.rowCount ?? '?'} 行 × ${after.columnCount ?? '?'} 列`;
}

function RecordRow({ record, index }: { record: RerunRecord; index: number }) {
  const meta = OUTCOME_META[record.outcome];
  const detail = record.outcome === 'drift'
    ? record.diff?.summary ?? '结果与原留痕不一致'
    : record.outcome === 'error'
      ? record.error ?? '未知原因'
      : snapshotLabel(record);
  return (
    <div
      className="border-b border-border-subtle/50 py-1 last:border-b-0 text-[10px] font-mono leading-relaxed"
      title={[
        `结论：${meta.label}`,
        `复跑时间：${record.rerunAt}`,
        `原留痕：${record.before.rowCount ?? '?'} 行 × ${record.before.columnCount ?? '?'} 列（执行于 ${record.before.executedAt ?? '?'}）`,
        record.after ? `本次结果：${snapshotLabel(record)}` : '',
        record.diff ? `差异：${record.diff.summary}` : '',
        record.error ? `原因：${record.error}` : '',
        typeof record.durationMs === 'number' ? `耗时：${(record.durationMs / 1000).toFixed(1)}s` : '',
        record.tempDfName ? `临时 DataFrame：${record.tempDfName}（比对后已释放）` : '',
        record.sessionId ? `会话：${record.sessionId}` : '',
      ].filter(Boolean).join('\n')}
    >
      <div className="flex items-center gap-1.5">
        <meta.Icon size={10} className={`shrink-0 ${meta.className}`} />
        {/* 列表最新在前，#1 = 最近一次复跑 */}
        <span className="text-text-dim">#{index + 1}</span>
        <span className="text-text-muted">{formatRerunTime(record.rerunAt)}</span>
        <span className={meta.className}>{meta.label}</span>
        {typeof record.durationMs === 'number' && (
          <span className="ml-auto text-text-dim">{(record.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      {detail && <div className="pl-[16px] text-text-secondary break-all">{detail}</div>}
    </div>
  );
}

function RerunStatus({ data, running, requestError }: { data: DataFrameNodeData; running: boolean; requestError?: string }) {
  const [expanded, setExpanded] = useState(false);
  const history = data.rerunHistory ?? [];
  const latest = history[0];

  if (!running && !requestError && history.length === 0) return null;

  const headline = running
    ? { className: 'text-text-muted', Icon: Loader2, text: '复跑中…（按留痕固化的 SQL 重新执行）', spin: true }
    : requestError
      ? { className: 'text-error', Icon: XCircle, text: `复跑失败：${requestError}`, spin: false }
      : latest!.outcome === 'identical'
        ? {
          className: OUTCOME_META.identical.className,
          Icon: OUTCOME_META.identical.Icon,
          text: `复现一致 · ${formatRerunTime(latest!.rerunAt)}${latest!.after ? ` · ${snapshotLabel(latest!)}` : ''}`,
          spin: false,
        }
        : latest!.outcome === 'drift'
          ? {
            className: OUTCOME_META.drift.className,
            Icon: OUTCOME_META.drift.Icon,
            text: `漂移 · ${latest!.diff?.summary ?? '结果与原留痕不一致'}`,
            spin: false,
          }
          : {
            className: OUTCOME_META.error.className,
            Icon: OUTCOME_META.error.Icon,
            text: `复跑失败 · ${latest!.error ?? '未知原因'}`,
            spin: false,
          };

  return (
    <div className="border-t border-border-subtle px-4 py-2">
      <div className="flex items-start gap-1.5 text-[11px]">
        <headline.Icon size={12} className={`shrink-0 mt-[2px] ${headline.className} ${headline.spin ? 'animate-spin' : ''}`} />
        <span className={`${headline.className} font-mono break-all`} title={headline.text}>{headline.text}</span>
        {history.length > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-text-dim hover:text-brand transition-colors"
            title="展开/收起复跑记录"
          >
            <span>{history.length} 次</span>
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="max-h-32 overflow-auto mt-1.5 rounded bg-bg-primary/60 px-2 py-1">
          {history.map((record, i) => (
            <RecordRow key={`${record.rerunAt}-${i}`} record={record} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(RerunStatus);
