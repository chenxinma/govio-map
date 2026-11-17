/**
 * T3.5 活视图轮询逻辑测试（src/utils/share-poll.ts，纯逻辑 + 注入替身，node 环境无需 jsdom）。
 *
 * 锁的是用户裁决 ③ 的四条契约：
 *  - 基准间隔 3s；失败指数退避 3→6→12→30s 封顶；
 *  - 304 / 指纹未变 **不回调 onPayload**（onPayload 是只读视图唯一的渲染触发源 ⇒ 不重渲染）；
 *  - 页面隐藏暂停轮询、恢复可见立即拉一次并重启计时；
 *  - 退避期间报「与源画布同步中断」，恢复后清除并复位；token 失效（404）终止轮询。
 */
import { describe, it, expect } from "vitest";
import {
  SHARE_POLL_BACKOFF_MS,
  SHARE_POLL_INTERVAL_MS,
  SHARE_SYNC_LOST_MESSAGE,
  createSharePoller,
  sharePollDelayMs,
  type SharePollResult,
} from "../../src/utils/share-poll.js";
import type { LiveSharePayload } from "../../src/types/share.js";

/** 让所有已 settle 的 promise/微任务跑完（tick 是 async 的）。 */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function payload(etag: string, nodeCount = 1): LiveSharePayload {
  return {
    readonly: true,
    version: 1,
    etag,
    token: "a".repeat(32),
    canvasId: "sess-1",
    sessionName: "sess-1",
    updatedAt: "2026-11-15T09:30:00.000Z",
    canvas: { nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `gov-${i}` })), edges: [] },
    manifests: [],
  };
}

/** 假时钟：记录每次排定的延迟，手动推进。 */
function fakeClock() {
  const scheduled: Array<{ id: number; ms: number; fn: () => void }> = [];
  const cancelled: number[] = [];
  let seq = 0;
  return {
    delays: [] as number[],
    schedule(fn: () => void, ms: number) {
      const id = ++seq;
      scheduled.push({ id, ms, fn });
      this.delays.push(ms);
      return id;
    },
    cancel(handle: unknown) {
      const id = handle as number;
      cancelled.push(id);
      const i = scheduled.findIndex((t) => t.id === id);
      if (i >= 0) scheduled.splice(i, 1);
    },
    pending: () => scheduled.length,
    cancelledCount: () => cancelled.length,
    async runNext() {
      const next = scheduled.shift();
      if (!next) throw new Error("没有已排定的轮询（当前处于暂停/停止状态）");
      next.fn();
      await settle();
    },
  };
}

/** 假可见性：可手动切换 hidden 并触发订阅回调。 */
function fakeVisibility(initialHidden = false) {
  let hidden = initialHidden;
  const listeners = new Set<() => void>();
  return {
    hidden: () => hidden,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setHidden(next: boolean) {
      hidden = next;
      listeners.forEach((cb) => cb());
    },
    listeners: () => listeners.size,
  };
}

interface HarnessOptions {
  responses: SharePollResult[];
  onPayload?: (p: LiveSharePayload) => void;
  hidden?: boolean;
}

function harness({ responses, onPayload, hidden = false }: HarnessOptions) {
  const clock = fakeClock();
  const visibility = fakeVisibility(hidden);
  const queue = [...responses];
  const calls: Array<string | null> = [];
  const lost: boolean[] = [];
  const payloads: LiveSharePayload[] = [];
  let fetchCount = 0;
  let goneCount = 0;

  const poller = createSharePoller({
    fetchView: async (etag) => {
      fetchCount += 1;
      calls.push(etag);
      const next = queue.shift();
      if (next) return next;
      // 脚本用尽后默认「内容未变」——真实轮询的常态
      return { status: "unchanged" };
    },
    onPayload: (p) => {
      payloads.push(p);
      onPayload?.(p);
    },
    onSyncLost: (v) => lost.push(v),
    onGone: () => {
      goneCount += 1;
    },
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (h) => clock.cancel(h),
    visibility,
  });

  return {
    poller,
    clock,
    visibility,
    calls,
    lost,
    payloads,
    fetches: () => fetchCount,
    gones: () => goneCount,
  };
}

describe("退避阶梯（裁决 ③：3→6→12→30s 封顶）", () => {
  it("无失败 = 3s 基准间隔；第 n 次失败取阶梯第 n 档，30s 封顶", () => {
    expect(SHARE_POLL_INTERVAL_MS).toBe(3000);
    expect(SHARE_POLL_BACKOFF_MS).toEqual([3000, 6000, 12000, 30000]);
    expect([0, 1, 2, 3, 4, 5, 99].map(sharePollDelayMs)).toEqual([3000, 3000, 6000, 12000, 30000, 30000, 30000]);
    expect(sharePollDelayMs(-1)).toBe(3000);
    expect(sharePollDelayMs(Number.NaN)).toBe(3000);
    expect(sharePollDelayMs(2.7)).toBe(6000);
  });

  it("同步中断文案就是「与源画布同步中断」", () => {
    expect(SHARE_SYNC_LOST_MESSAGE).toBe("与源画布同步中断");
  });
});

describe("轮询节奏与 304 不重渲染", () => {
  it("start 立即拉一次，成功后按 3s 排下一次；304 不回调 onPayload（不重渲染）", async () => {
    const h = harness({ responses: [{ status: "ok", payload: payload("e1") }, { status: "unchanged" }] });
    h.poller.start();
    await settle();

    expect(h.fetches()).toBe(1);
    expect(h.payloads).toHaveLength(1);
    expect(h.clock.delays).toEqual([3000]);
    expect(h.poller.armed()).toBe(true);

    await h.clock.runNext(); // 第二次：304
    expect(h.fetches()).toBe(2);
    expect(h.payloads).toHaveLength(1); // 渲染触发源没有被调用
    expect(h.clock.delays).toEqual([3000, 3000]); // 健康 → 仍是基准间隔
  });

  it("上一次拿到的 etag 作为下一次 If-None-Match 的来源；内容变了才回调", async () => {
    const h = harness({
      responses: [
        { status: "ok", payload: payload("e1", 1) },
        { status: "ok", payload: payload("e2", 2) },
      ],
    });
    h.poller.start();
    await settle();
    expect(h.calls).toEqual([null]); // 首次无条件拉全量

    await h.clock.runNext();
    expect(h.calls).toEqual([null, "e1"]);
    expect(h.payloads.map((p) => p.etag)).toEqual(["e1", "e2"]);
    expect(h.payloads[1].canvas.nodes).toHaveLength(2); // 源画布长了新节点

    await h.clock.runNext(); // 脚本用尽 → unchanged，etag 保持 e2
    expect(h.calls).toEqual([null, "e1", "e2"]);
    expect(h.payloads).toHaveLength(2);
  });

  it("连续失败按 3→6→12→30→30 退避，且只报一次「同步中断」；恢复后复位并清除提示", async () => {
    const err: SharePollResult = { status: "error", message: "network" };
    const h = harness({ responses: [err, err, err, err, err, { status: "ok", payload: payload("e1") }] });
    h.poller.start();
    await settle();
    expect(h.clock.delays).toEqual([3000]);
    expect(h.lost).toEqual([true]); // 第一次失败就报中断，后续失败不重复报

    await h.clock.runNext();
    expect(h.clock.delays).toEqual([3000, 6000]);
    await h.clock.runNext();
    expect(h.clock.delays).toEqual([3000, 6000, 12000]);
    await h.clock.runNext();
    expect(h.clock.delays).toEqual([3000, 6000, 12000, 30000]);
    await h.clock.runNext();
    expect(h.clock.delays).toEqual([3000, 6000, 12000, 30000, 30000]); // 封顶
    expect(h.lost).toEqual([true]);

    await h.clock.runNext(); // 恢复
    expect(h.lost).toEqual([true, false]); // 清除提示
    expect(h.payloads).toHaveLength(1);
    expect(h.clock.delays).toEqual([3000, 6000, 12000, 30000, 30000, 3000]); // 退避复位
  });

  it("fetchView 抛异常按失败处理（进退避），不会把轮询炸掉", async () => {
    const clock = fakeClock();
    let threw = true;
    const poller = createSharePoller({
      fetchView: async () => {
        if (threw) throw new Error("boom");
        return { status: "unchanged" };
      },
      onPayload: () => {},
      schedule: (fn, ms) => clock.schedule(fn, ms),
      cancel: (h) => clock.cancel(h),
      visibility: fakeVisibility(),
    });
    poller.start();
    await settle();
    expect(clock.delays).toEqual([3000]); // 第一次失败：阶梯第 1 档
    threw = false;
    await clock.runNext();
    expect(clock.delays).toEqual([3000, 3000]); // 成功后回到基准间隔
    expect(poller.armed()).toBe(true);
  });

  it("token 失效（404）→ onGone 一次并终止轮询，不再排下一次", async () => {
    const h = harness({ responses: [{ status: "not-found" }] });
    h.poller.start();
    await settle();
    expect(h.gones()).toBe(1);
    expect(h.poller.armed()).toBe(false);
    expect(h.clock.pending()).toBe(0);
  });
});

describe("页面可见性：隐藏暂停 / 恢复立即拉一次", () => {
  it("隐藏时不排下一次（暂停），恢复可见立即拉一次并重启计时", async () => {
    const h = harness({ responses: [{ status: "ok", payload: payload("e1") }] });
    h.poller.start();
    await settle();
    expect(h.clock.delays).toEqual([3000]);

    h.visibility.setHidden(true); // 排定的那次仍在，但被取消
    expect(h.poller.armed()).toBe(false);
    expect(h.clock.pending()).toBe(0);
    const fetchesWhileHidden = h.fetches();

    h.visibility.setHidden(false); // 恢复：立即拉一次
    await settle();
    expect(h.fetches()).toBe(fetchesWhileHidden + 1);
    expect(h.clock.delays).toEqual([3000, 3000]); // 并重启计时
    expect(h.poller.armed()).toBe(true);
  });

  it("隐藏期间到点也不发请求：arm 时页面不可见就不排定", async () => {
    const h = harness({ responses: [{ status: "ok", payload: payload("e1") }], hidden: true });
    h.poller.start();
    await settle();
    expect(h.fetches()).toBe(1); // start 的那次照发（用户刚打开页面）
    expect(h.clock.delays).toEqual([]); // 但不再排下一次
    expect(h.poller.armed()).toBe(false);
  });

  it("stop 清理定时器并解绑可见性监听（组件卸载不留尾巴）", async () => {
    const h = harness({ responses: [{ status: "ok", payload: payload("e1") }] });
    h.poller.start();
    await settle();
    expect(h.visibility.listeners()).toBe(1);
    expect(h.poller.armed()).toBe(true);

    h.poller.stop();
    expect(h.poller.armed()).toBe(false);
    expect(h.clock.pending()).toBe(0);
    expect(h.visibility.listeners()).toBe(0);

    const before = h.fetches();
    h.visibility.setHidden(false); // 解绑后即使可见性变化也不再发请求
    await settle();
    expect(h.fetches()).toBe(before);
  });
});
