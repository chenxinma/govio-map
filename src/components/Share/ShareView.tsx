/**
 * T3.5 只读分享「画布活视图」（`/share/<token>`，静态页面、无 /ws 连接）。
 *
 * 与 T3.2 的快照视图相比，三处根本变化：
 *  1. **活视图**：`GET /api/shares/<token>` 每次返回源会话**当前**画布，本页按 3s 轮询
 *     （`If-None-Match` → 304 不重渲染；页面隐藏暂停；失败退避 3→6→12→30s 并提示
 *     「与源画布同步中断」）——见 `src/utils/share-poll.ts`；
 *  2. **与主画布同渲染**：直接复用 `src/components/Nodes` 的五类节点组件与同一套边样式
 *     （语义边、X13/X15 关系详情、X18 口径徽标、Plotly 懒加载 chunk），图表真渲染出 Plotly；
 *  3. **只读纪律靠上下文而不是自觉**：`ReadOnlyCanvasContext` 让节点组件隐藏一切会产生副作用的
 *     入口（引用/删除/预览/复跑/编辑 SQL），ReactFlow 关死拖动/连线/选择修改，本页不存在
 *     任何写回源 session 的请求路径（复跑入口与其后端路由已一并删除，动手一律走 Fork）。
 *
 * 仍继承 T3.2 的三层只读实现：视图层（本文件）/ 连接层（main.tsx 不建 /ws）/ API 层（无写入口）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCanvasStore } from '../../store/canvas-store';
import { nodeTypes } from '../Nodes';
import LineageLegend from '../Canvas/LineageLegend';
import { lineageEdgeDefaults } from '../../utils/lineage';
import { ReadOnlyCanvasContext } from '../../hooks/useReadOnlyCanvas';
import { neutralizeCanvasPersistence } from './canvas-persistence';
import { apiBaseFrom } from '../../utils/share-link';
import {
  createSharePoller,
  SHARE_SYNC_LOST_MESSAGE,
  type SharePollResult,
} from '../../utils/share-poll';
import type { LiveSharePayload } from '../../types/share';

/**
 * **陷阱 1（数据损坏级）**：`useCanvasStore` 带 persist（localStorage `govio-canvas-state`），
 * 而 `/share/<token>` 与主界面**同源共享**这份 localStorage——灌远端画布前必须先中和持久化，
 * 否则远端画布会顶掉本机画布。实现与理由见 `./canvas-persistence.ts`；必须在任何 `set()`
 * 之前调用，所以放在组件体首行（早于所有 effect 与事件回调）。
 */
export default function ShareView({ token }: { token: string }) {
  neutralizeCanvasPersistence();

  const [payload, setPayload] = useState<LiveSharePayload | null>(null);
  const [syncLost, setSyncLost] = useState(false);
  const [gone, setGone] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const hydrateSession = useCanvasStore((s) => s.hydrateSession);

  // X25 遗留 2：本页曾自带一份「页面端口 +1」硬编码 apiBase()。统一走 share-link.ts——
  // dev（5173）得到 5174，生产单端口同源托管退回相对路径（''）。
  const apiBase = useMemo(() => apiBaseFrom(window.location.origin) ?? '', []);

  const fetchView = useCallback(
    async (etag: string | null): Promise<SharePollResult> => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = `"${etag}"`;
      const res = await fetch(`${apiBase}/api/shares/${encodeURIComponent(token)}`, {
        headers,
        cache: 'no-store',
      });
      if (res.status === 304) return { status: 'unchanged' };
      if (res.status === 404) return { status: 'not-found' };
      if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
      return { status: 'ok', payload: (await res.json()) as LiveSharePayload };
    },
    [apiBase, token],
  );

  useEffect(() => {
    const poller = createSharePoller({
      fetchView,
      onPayload: (next) => {
        // **陷阱 2**：store 在模块导入时已同步 rehydrate 了**本机**画布。远端数据到达前
        // 一律渲染 loading（`payload === null`），到达后整体替换（hydrateSession 是替换不是
        // merge）——任何时刻都不会把本机 localStorage 里的节点渲染到只读页上。
        hydrateSession(next.canvas.nodes as Node[], next.canvas.edges as Edge[]);
        setPayload(next);
        setActionError(null);
      },
      onSyncLost: setSyncLost,
      onGone: () => setGone(true),
    });
    poller.start();
    return () => poller.stop(); // 卸载清理定时器 + 解绑 visibilitychange
  }, [fetchView, hydrateSession]);

  const handleFork = useCallback(async () => {
    setForkBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/shares/${encodeURIComponent(token)}/fork`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { forkId?: string; error?: string } | null;
      if (!res.ok || !body?.forkId) throw new Error(body?.error || `fork 失败（HTTP ${res.status}）`);
      window.location.href = `/?fork=${encodeURIComponent(body.forkId)}`;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setForkBusy(false);
    }
  }, [apiBase, token]);

  // token 失效（源画布关闭了分享）优先于一切：不再渲染任何内容
  if (gone) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-canvas px-6">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-text-primary">分享链接已失效</p>
          <p className="mt-2 text-xs text-text-muted leading-relaxed">
            源画布的只读分享已关闭（或从未开启）。请让分享者重新开启分享后再访问；旧版快照链接一律失效。
          </p>
        </div>
      </div>
    );
  }

  // 远端画布到达前：只渲染显式状态，绝不渲染 store 里 rehydrate 出来的本机画布
  if (!payload) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-canvas">
        <div className="text-sm text-text-muted">
          {syncLost ? `${SHARE_SYNC_LOST_MESSAGE}，正在重试…` : '加载分享画布…'}
        </div>
      </div>
    );
  }

  const manifests = payload.manifests;

  return (
    <div className="h-screen flex flex-col bg-bg-canvas">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-border-subtle">
        <span className="text-sm font-medium text-text-primary">{payload.sessionName || payload.canvasId}</span>
        <span
          className="text-[10px] px-2 py-0.5 rounded bg-brand/10 text-brand border border-brand/30"
          title="内容随源画布实时变化（3s 轮询），不是分享时点的快照"
        >
          只读 · 活视图
        </span>
        <span className="text-xs text-text-dim" title="源画布最后更新时间">
          源画布更新于 {new Date(payload.updatedAt).toLocaleString()}
        </span>
        {payload.forkFrom && (
          <span className="text-xs text-text-muted" title={`源画布 ${payload.forkFrom.canvasId}`}>
            派生自分享 {payload.forkFrom.shareId.slice(0, 8)}…
          </span>
        )}
        <div className="flex-1" />
        {syncLost && (
          <span className="text-[11px] px-2 py-1 rounded bg-warning/10 text-warning border border-warning/30">
            {SHARE_SYNC_LOST_MESSAGE}
          </span>
        )}
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
          title="fork 出可写副本并保留派生血缘（只读页不能改源画布，动手一律先 fork）"
        >
          {forkBusy ? '准备中…' : 'Fork 续写'}
        </button>
      </header>
      {actionError && (
        <div className="px-4 py-2 bg-error/10 border-b border-error/30 text-xs text-error">{actionError}</div>
      )}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          {/* 只读上下文：五类节点组件据此隐藏引用/删除/预览/复跑/编辑等一切副作用入口 */}
          <ReadOnlyCanvasContext.Provider value={true}>
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.1}
                maxZoom={2}
                defaultEdgeOptions={lineageEdgeDefaults('data')}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag
                zoomOnScroll
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e0e0e0" />
                <Controls showInteractive={false} className="!bg-bg-surface !border-border-default !rounded-lg" />
                <MiniMap
                  nodeColor={(node) => {
                    switch (node.type) {
                      case 'sourceTable': return 'hsl(270, 60%, 60%)';
                      case 'sqlQuery': return 'hsl(152, 58%, 52%)';
                      case 'dataFrame': return 'hsl(25, 75%, 55%)';
                      case 'report': return 'hsl(270, 60%, 70%)';
                      case 'chart': return 'hsl(200, 70%, 55%)';
                      default: return '#a7a7a7';
                    }
                  }}
                  maskColor="rgba(0, 0, 0, 0.08)"
                  className="!bg-bg-primary !border-border-default !rounded-lg"
                />
                <LineageLegend />
              </ReactFlow>
            </ReactFlowProvider>
          </ReadOnlyCanvasContext.Provider>
        </div>
        <aside className="w-80 flex-shrink-0 border-l border-border-subtle bg-white overflow-y-auto p-3">
          <h2 className="text-xs font-medium text-text-primary mb-2">分析留痕（Manifest · {manifests.length}）</h2>
          {manifests.length === 0 && (
            <p className="text-[11px] text-text-dim">本源画布暂无带分析留痕的节点。</p>
          )}
          {manifests.map((m) => (
            <div key={m.nodeId} className="mb-3 rounded-lg border border-border-subtle p-2.5">
              <p className="text-[11px] font-medium text-text-primary truncate">{m.nodeTitle || m.nodeId}</p>
              <p className="text-[10px] text-text-muted mt-0.5">
                {m.manifest.datasource}
                {typeof m.manifest.rowCount === 'number' ? ` · ${m.manifest.rowCount} 行 × ${m.manifest.columnCount} 列` : ''}
              </p>
              <p className="mt-1 text-[10px] font-mono text-text-secondary line-clamp-4 whitespace-pre-wrap break-all">
                {m.manifest.sql}
              </p>
              {m.manifest.model?.id && (
                <p className="mt-2 text-[10px] text-text-dim truncate">{m.manifest.model.id}</p>
              )}
            </div>
          ))}
          <p className="mt-4 text-[10px] text-text-dim leading-relaxed">
            只读页不提供复跑：需要对数据动手请先「Fork 续写」，在副本里复跑与编辑。
          </p>
        </aside>
      </div>
    </div>
  );
}
