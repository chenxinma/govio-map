/**
 * pending-ack 回执闸门（① 竞态修复的最小单元）：
 * track → resolve 立即放行；同类型重发只等最新一次；回执缺失走超时兜底。
 */
import { describe, it, expect } from "vitest";
import { createPendingAck } from "../../src/utils/pending-ack.js";

describe("createPendingAck", () => {
  it("resolve 放行对应 track", async () => {
    const acks = createPendingAck(5000);
    const p = acks.track("model");
    acks.resolve("model");
    await expect(p).resolves.toBeUndefined();
  });

  it("pending() 等待全部未决回执；无未决立即返回", async () => {
    const acks = createPendingAck(5000);
    await expect(acks.pending()).resolves.toBeUndefined();

    const model = acks.track("model");
    const thinking = acks.track("thinking");
    const waiter = acks.pending();
    acks.resolve("thinking");
    await expect(thinking).resolves.toBeUndefined();
    acks.resolve("model");
    await expect(model).resolves.toBeUndefined();
    await expect(waiter).resolves.toBeUndefined();
  });

  it("同类型重发：旧请求先行放行，pending 只等最新一次", async () => {
    const acks = createPendingAck(5000);
    const first = acks.track("model");
    await expect(first).resolves.toBeUndefined(); // 第二次 track 立即放行旧请求

    const second = acks.track("model");
    acks.resolve("model");
    await expect(second).resolves.toBeUndefined();
  });

  it("回执缺失时超时兜底放行，不卡发送方", async () => {
    const acks = createPendingAck(20);
    await expect(acks.track("model")).resolves.toBeUndefined();
    await expect(acks.pending()).resolves.toBeUndefined();
  });
});
