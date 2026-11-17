import { useCallback, useEffect, useRef, useState } from "react";
import { Share2 } from "lucide-react";
import { apiBaseFrom, shareLink } from "../../utils/share-link";
import type { ShareStatePayload, ShareTogglePayload } from "../../types/share";

/**
 * 分享开关（T3.5）：ChatPanel 头部的只读分享入口。
 *
 * 与 T3.2 的「生成分享链接」按钮相比，语义整体换成**开关**：
 *  - 默认**关**——状态来自 `GET /api/share-state`，没有开关 sidecar 就是未开启；
 *  - 开启 = `POST /api/shares`（**幂等**，token 由会话指纹派生 ⇒ 同一会话的链接恒定，
 *    从根上消除 T3.2「加完节点再点分享只复制旧链接」的陈旧短路缺陷：链接不变，但内容
 *    是活视图，源画布的新节点会自动出现在同一个链接里）；
 *  - 撤销 = `DELETE /api/shares`（删掉开关 sidecar，链接立即失效）；
 *  - 开启时**必须**显著告知「链接内容随源画布实时变化」——活视图意味着源画布后续新增
 *    内容会实时暴露给任何持链接的人（用户裁决 ①，隐私影响已确认接受）。
 *
 * 基址纪律（X25）：链接一律 `shareLink(path, window.location.origin)`（页面 origin，dev=5173），
 * API 一律 `apiBaseFrom(origin) ?? ''`（dev=5174，生产单端口同源退回相对路径）。
 */

/** 隐私告知文案（开启后立即展示，USER-MANUAL 同步说明）。 */
export const SHARE_LIVE_NOTICE = "链接内容随源画布实时变化";

interface ShareToggleProps {
  /** 后端未连接时禁用（与既有分享按钮一致）。 */
  disabled?: boolean;
}

export default function ShareToggle({ disabled = false }: ShareToggleProps) {
  const [state, setState] = useState<ShareStatePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // X25：API 基址（dev = 页面端口 +1）与分享链接（页面 origin）必须分开构造
  const pageOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const apiBase = apiBaseFrom(pageOrigin) ?? "";

  // 挂载时拉一次开关状态（异步回调里才 setState，不在 effect 体内同步写）
  useEffect(() => {
    let alive = true;
    fetch(`${apiBase}/api/share-state`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        // 无活动会话（409）/ 后端不可达：保持「未开启」渲染，不打扰用户
        if (alive && body) setState(body as ShareStatePayload);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [apiBase]);

  // 点开关外部即收起浮层
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const link = state?.token ? shareLink(`/share/${state.token}`, pageOrigin) : "";

  const copyLink = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // 剪贴板不可用（非安全上下文等）：链接已在浮层里可选中复制
    }
  }, [link]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/shares`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as (ShareTogglePayload & { error?: string }) | null;
      if (!res.ok || !body?.token) {
        throw new Error(body?.error || `开启分享失败（HTTP ${res.status}）`);
      }
      setState({ enabled: true, token: body.token, enabledAt: body.enabledAt ?? null });
      setOpen(true); // 开启后立刻展示链接 + 隐私告知
      try {
        // 用刚拿到的 token 复制（state 尚未提交，link 还是旧值）
        await navigator.clipboard.writeText(shareLink(`/share/${body.token}`, pageOrigin));
      } catch {
        /* 剪贴板不可用（非安全上下文等）：链接已在浮层里可选中复制 */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [apiBase, pageOrigin]);

  const handleDisable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/shares`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `撤销分享失败（HTTP ${res.status}）`);
      }
      setState((prev) => (prev ? { ...prev, enabled: false, enabledAt: null } : prev));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [apiBase]);

  const enabled = state?.enabled === true;

  const handleClick = useCallback(() => {
    if (enabled) {
      setOpen((v) => !v); // 已开启：展开/收起链接与撤销入口
      return;
    }
    void handleEnable();
  }, [enabled, handleEnable]);

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={handleClick}
        className={`p-1 rounded hover:bg-bg-primary ${enabled ? "text-brand" : "text-text-muted hover:text-text-primary"}`}
        title={
          enabled
            ? "只读分享已开启（内容随源画布实时变化）：复制链接 / 撤销"
            : busy
              ? "开启中…"
              : "开启只读分享（链接内容随源画布实时变化）"
        }
        aria-label={enabled ? "只读分享已开启" : "开启只读分享"}
        aria-expanded={open}
        disabled={disabled || busy}
      >
        <Share2 size={14} />
      </button>

      {open && enabled && (
        <div className="absolute top-full right-0 mt-1 w-80 bg-bg-surface border border-border-default rounded-lg shadow-lg z-50 p-3">
          <p className="text-[11px] font-medium text-text-primary">只读分享已开启</p>
          <p className="mt-1 text-[11px] text-warning leading-relaxed">
            {SHARE_LIVE_NOTICE}：持链接者会看到源画布**后续新增**的全部内容（不是分享时点的快照）。
            不需要时请撤销。
          </p>
          <code className="mt-2 block text-[10px] font-mono text-text-secondary break-all bg-bg-primary border border-border-subtle rounded px-2 py-1.5 select-all">
            {link}
          </code>
          <div className="mt-2 flex items-center gap-2">
            <button
              className="text-[11px] px-2 py-1 rounded border border-border-default text-text-secondary hover:bg-bg-primary"
              onClick={() => void copyLink()}
            >
              复制链接
            </button>
            <button
              className="ml-auto text-[11px] px-2 py-1 rounded border border-error/40 text-error hover:bg-error/10 disabled:opacity-50"
              onClick={() => void handleDisable()}
              disabled={busy}
              title="删除分享开关，链接立即失效"
            >
              {busy ? "处理中…" : "撤销分享"}
            </button>
          </div>
          {error && <p className="mt-2 text-[11px] text-error break-all">{error}</p>}
        </div>
      )}

      {!open && error && (
        <p className="absolute top-full right-0 mt-1 w-64 text-[11px] text-error bg-bg-surface border border-error/40 rounded-lg shadow-lg p-2 z-50 break-all">
          {error}
        </p>
      )}
    </div>
  );
}
