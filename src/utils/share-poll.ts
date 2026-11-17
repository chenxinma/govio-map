/**
 * T3.5 活视图轮询（纯逻辑 + 可注入定时器/可见性，便于在 Node 侧断言，不需要 jsdom）。
 *
 * 契约（用户裁决 ③）：
 *  - 基准间隔 **3s**，走 HTTP（不新增 WS 消息类型，`PROTOCOL_VERSION` 保持 1）；
 *  - 带 `If-None-Match`，命中 **304 / 指纹未变则不回调 `onPayload`**——这是「不重渲染」
 *    的唯一契约点：`onPayload` 是只读视图唯一的渲染触发源；
 *  - 页面隐藏（`document.visibilitychange`）**暂停**轮询，恢复可见时**立即拉一次**并重启计时；
 *  - 失败**指数退避 3→6→12→30s 封顶**，退避期间报「与源画布同步中断」，恢复后清除并复位。
 */
import type { LiveSharePayload } from "../types/share";

/** 轮询基准间隔（毫秒）。 */
export const SHARE_POLL_INTERVAL_MS = 3000;

/**
 * 失败退避阶梯：3→6→12→30s 封顶（与裁决 ③ 字面一致）。
 * 超出阶梯长度后恒为最后一档，不再增长。
 */
export const SHARE_POLL_BACKOFF_MS: readonly number[] = [3000, 6000, 12000, 30000];

/** 「与源画布同步中断」提示文案（裁决 ③）。 */
export const SHARE_SYNC_LOST_MESSAGE = "与源画布同步中断";

/** 下一次轮询的延迟：无失败 = 基准间隔；第 n 次失败 = 阶梯第 n 档（封顶 30s）。 */
export function sharePollDelayMs(failureCount: number): number {
  if (!Number.isFinite(failureCount) || failureCount <= 0) return SHARE_POLL_INTERVAL_MS;
  const index = Math.min(Math.floor(failureCount), SHARE_POLL_BACKOFF_MS.length) - 1;
  return SHARE_POLL_BACKOFF_MS[Math.max(0, index)];
}

/** 一次拉取的结果分类。`unchanged` = 304/指纹未变，**不得**触发渲染。 */
export type SharePollResult =
  | { status: "ok"; payload: LiveSharePayload }
  | { status: "unchanged" }
  | { status: "not-found" }
  | { status: "error"; message?: string };

/** 页面可见性抽象（默认绑定 document；测试注入替身）。 */
export interface SharePollVisibility {
  hidden: () => boolean;
  subscribe: (onChange: () => void) => () => void;
}

export interface SharePollerDeps {
  /** 拉一次活视图；`etag` 为上一次拿到的值（首次为 null），实现方负责放进 `If-None-Match`。 */
  fetchView: (etag: string | null) => Promise<SharePollResult>;
  /** 拿到新载荷时调用（唯一的渲染触发源）；`unchanged` 绝不回调。 */
  onPayload: (payload: LiveSharePayload) => void;
  /** 同步中断（true）/ 恢复（false）。 */
  onSyncLost?: (lost: boolean) => void;
  /** token 失效（404：分享已撤销或从未开启）——终止轮询。 */
  onGone?: () => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  visibility?: SharePollVisibility;
}

export interface SharePoller {
  /** 立即拉一次并开始计时。 */
  start: () => void;
  /** 停止轮询并解绑可见性监听（组件卸载时调用）。 */
  stop: () => void;
  /** 当前连续失败次数（0 = 健康）。 */
  failures: () => number;
  /** 当前是否已排定下一次轮询（页面隐藏暂停 / 已停止时为 false）。 */
  armed: () => boolean;
}

function documentVisibility(): SharePollVisibility {
  return {
    hidden: () => (typeof document === "undefined" ? false : document.hidden),
    subscribe: (onChange) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  };
}

export function createSharePoller(deps: SharePollerDeps): SharePoller {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const visibility = deps.visibility ?? documentVisibility();

  let etag: string | null = null;
  let failures = 0;
  let timer: unknown = null;
  let inflight = false;
  let stopped = true;
  let lost = false;

  function reportLost(next: boolean): void {
    if (next === lost) return;
    lost = next;
    deps.onSyncLost?.(next);
  }

  function arm(): void {
    if (stopped) return;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    // 页面隐藏：不排下一次（暂停）。恢复可见由 visibility 订阅回调重新 tick。
    if (visibility.hidden()) return;
    timer = schedule(() => {
      timer = null;
      void tick();
    }, sharePollDelayMs(failures));
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (inflight) return; // 已有一次在飞：由那一次的收尾负责 arm()
    inflight = true;
    let result: SharePollResult;
    try {
      result = await deps.fetchView(etag);
    } catch (err) {
      result = { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
    inflight = false;
    if (stopped) return;

    if (result.status === "not-found") {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      deps.onGone?.();
      return;
    }
    if (result.status === "error") {
      failures += 1;
      reportLost(true);
    } else {
      failures = 0;
      reportLost(false);
      if (result.status === "ok") {
        etag = result.payload.etag;
        deps.onPayload(result.payload);
      }
      // unchanged：不动 etag、不回调 onPayload（不重渲染）
    }
    arm();
  }

  const unsubscribeVisibility = visibility.subscribe(() => {
    if (stopped) return;
    if (visibility.hidden()) {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      return;
    }
    void tick(); // 恢复可见：立即拉一次（tick 收尾会重新 arm）
  });

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      unsubscribeVisibility();
    },
    failures: () => failures,
    armed: () => timer !== null,
  };
}
