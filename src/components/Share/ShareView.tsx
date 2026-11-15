/**
 * T3.2 只读分享视图（/share/<token>，静态页面、无 /ws 连接）。
 *
 * 只读纪律在 UI 层的体现：
 *  - ReactFlow 关死拖动/连线/选择修改；不存在任何写回源画布的操作入口；
 *  - 「复跑」走 POST /api/shares/<token>/rerun——按 T1.2 语义从分享快照的
 *    Manifest 固化 SQL 重跑并判漂移，结果只追加到本视图内存态（新副本卡片），
 *    不触碰源画布；
 *  - 「Fork 续写」先 POST fork 拿 forkId，再跳转 /?fork=<forkId> 由主界面
 *    canvas_fork_apply 应用到本地新会话（派生血缘 forkFrom 随快照继承）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, type Node, type Edge, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { AnalysisManifest } from '../../types/manifest';
import type { RerunRecord } from '../../types/rerun';

/** 后端 API 基址：与 useChat/canvas-service 同约定（页面端口 +1 = 5174）。 */
function apiBase(): string {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const port = parseInt(window.location.port, 10) + 1;
  return `${protocol}//${window.location.hostname}:${port}`;
}

interface ShareManifestEntry {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  manifest: AnalysisManifest;
}

interface ForkFrom {
  kind: string;
  shareId: string;
  canvasId: string;
  sessionName: string | null;
  sharedAt: string;
  forkedAt: string;
}

interface SharePayload {
  readonly: true;
  shareId: string;
  canvasId: string;
  sessionName: string | null;
  createdAt: string;
  canvas: { nodes: unknown[]; edges: unknown[] };
  manifests: ShareManifestEntry[];
  forkFrom?: ForkFrom;
}

type Badge = { label: string; cls: string };

const TYPE_BADGES: Record<string, Badge> = {
  sourceTable: { label: 'Table', cls: 'bg-purple-100 text-purple-700' },
  sqlQuery: { label: 'SQL', cls: 'bg-green-100 text-green-700' },
  dataFrame: { label: 'DataFrame', cls: 'bg-orange-100 text-orange-700' },
  report: { label: 'Report', cls: 'bg-amber-100 text-amber-700' },
  chart: { label: 'Chart', cls: 'bg-blue-100 text-blue-700' },
};

function ShareNodeCard({ id, data }: NodeProps) {
  const d = data as { type?: string; title?: string; sql?: string; dfName?: string; hasManifest?: boolean };
  const badge = TYPE_BADGES[d.type ?? ''] ?? { label: d.type ?? 'Node', cls: 'bg-bg-surface text-text-secondary' };
  return (
    <div className="w-56 rounded-lg border border-border-default bg-white shadow-sm p-3">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
        <span className="text-xs font-medium text-text-primary truncate">{d.title || d.dfName || id}</span>
      </div>
      {d.sql && (
        <p className="mt-2 text-[10px] font-mono text-text-secondary line-clamp-3 whitespace-pre-wrap break-all">
          {d.sql}
        </p>
      )}
      {d.hasManifest && (
        <p className="mt-2 text-[10px] text-brand">含分析留痕（Manifest）</p>
      )}
    </div>
  );
}

export default function ShareView({ token }: { token: string }) {
  const [share, setShare] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [reruns, setReruns] = useState<Array<{ nodeId: string; record: RerunRecord }>>([]);
  const [forkBusy, setForkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${apiBase()}/api/shares/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error || `分享加载失败（HTTP ${res.status}）`);
        if (alive) setShare(body as SharePayload);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [token]);

  const { rfNodes, rfEdges } = useMemo(() => {
    const rawNodes = (share?.canvas.nodes ?? []) as Array<{ id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>;
    const manifestIds = new Set((share?.manifests ?? []).map((m) => m.nodeId));
    const rfNodes: Node[] = rawNodes.map((n) => ({
      id: n.id,
      position: n.position ?? { x: 0, y: 0 },
      type: 'shareCard',
      data: {
        ...(n.data ?? {}),
        type: n.type,
        hasManifest: manifestIds.has(n.id),
      },
    }));
    const rfEdges = (share?.canvas.edges ?? []) as Edge[];
    return { rfNodes, rfEdges };
  }, [share]);

  const nodeTypes = useMemo(() => ({ shareCard: ShareNodeCard }), []);

  const handleRerun = useCallback(async (nodeId: string) => {
    setRerunning(nodeId);
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(token)}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `复跑失败（HTTP ${res.status}）`);
      const record = (body as { record: RerunRecord }).record;
      setReruns((prev) => [...prev, { nodeId, record }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(null);
    }
  }, [token]);

  const handleFork = useCallback(async () => {
    setForkBusy(true);
    try {
      const res = await fetch(`${apiBase()}/api/shares/${encodeURIComponent(token)}/fork`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `fork 失败（HTTP ${res.status}）`);
      const forkId = (body as { forkId: string }).forkId;
      window.location.href = `/?fork=${encodeURIComponent(forkId)}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setForkBusy(false);
    }
  }, [token]);

  if (error && !share) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-canvas">
        <div className="text-sm text-error">{error}</div>
      </div>
    );
  }
  if (!share) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-canvas">
        <div className="text-sm text-text-muted">加载分享画布…</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-bg-canvas">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-border-subtle">
        <span className="text-sm font-medium text-text-primary">{share.sessionName || share.canvasId}</span>
        <span className="text-[10px] px-2 py-0.5 rounded bg-brand/10 text-brand border border-brand/30">只读分享</span>
        <span className="text-xs text-text-dim">{new Date(share.createdAt).toLocaleString()}</span>
        {share.forkFrom && (
          <span className="text-xs text-text-muted" title={`源画布 ${share.forkFrom.canvasId}`}>
            派生自分享 {share.forkFrom.shareId.slice(0, 8)}…
          </span>
        )}
        <div className="flex-1" />
        <button
          className="text-xs px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-surface"
          onClick={() => {
            void navigator.clipboard?.writeText(window.location.href).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? '已复制' : '复制链接'}
        </button>
        <button
          className="text-xs px-3 py-1 rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
          onClick={() => void handleFork()}
          disabled={forkBusy}
          title="fork 出可写副本并保留派生血缘"
        >
          {forkBusy ? '准备中…' : 'Fork 续写'}
        </button>
      </header>
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#ececec" gap={24} />
          </ReactFlow>
        </div>
        <aside className="w-80 flex-shrink-0 border-l border-border-subtle bg-white overflow-y-auto p-3">
          <h2 className="text-xs font-medium text-text-primary mb-2">分析留痕（Manifest · {share.manifests.length}）</h2>
          {share.manifests.length === 0 && (
            <p className="text-[11px] text-text-dim">本分享画布没有可复跑的 Manifest。</p>
          )}
          {share.manifests.map((m) => (
            <div key={m.nodeId} className="mb-3 rounded-lg border border-border-subtle p-2.5">
              <p className="text-[11px] font-medium text-text-primary truncate">{m.nodeTitle || m.nodeId}</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                {m.manifest.datasource}
                {typeof m.manifest.rowCount === 'number' ? ` · ${m.manifest.rowCount} 行 × ${m.manifest.columnCount} 列` : ''}
              </p>
              <p className="mt-1 text-[10px] font-mono text-text-secondary line-clamp-4 whitespace-pre-wrap break-all">
                {m.manifest.sql}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="text-[10px] px-2 py-0.5 rounded border border-brand-border text-brand hover:bg-brand/10 disabled:opacity-50"
                  onClick={() => void handleRerun(m.nodeId)}
                  disabled={rerunning !== null}
                  title="按 Manifest 固化 SQL 复跑并对比漂移（结果不回写源画布）"
                >
                  {rerunning === m.nodeId ? '复跑中…' : '复跑'}
                </button>
                {m.manifest.model?.id && (
                  <span className="text-[10px] text-text-dim truncate">{m.manifest.model.id}</span>
                )}
              </div>
            </div>
          ))}
          {reruns.length > 0 && (
            <>
              <h2 className="text-xs font-medium text-text-primary mt-4 mb-2">复跑结果（本视图新副本）</h2>
              {reruns.map(({ nodeId, record }, i) => (
                <div key={`${nodeId}-${i}`} className="mb-2 rounded-lg border border-border-subtle p-2.5 text-[10px]">
                  <p className="font-medium text-text-primary truncate">{nodeId}</p>
                  <p className="mt-0.5 text-text-secondary">
                    结论：
                    <span className={record.outcome === 'identical' ? 'text-brand' : record.outcome === 'drift' ? 'text-[#F59B23]' : 'text-error'}>
                      {record.outcome === 'identical' ? '一致' : record.outcome === 'drift' ? '漂移' : '失败'}
                    </span>
                    {record.after && ` · ${record.after.rowCount} 行 × ${record.after.columnCount} 列`}
                  </p>
                  {record.error && <p className="mt-1 text-error break-all">{record.error}</p>}
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
