// @vitest-environment jsdom
/**
 * T3.5 分享开关（src/components/Chat/ShareToggle.tsx）UI 测试。
 *
 * 锁的是任务书 §1(b) 根因与 X25 纪律：
 *  - 开关默认**关**，状态来自 `GET /api/share-state`；
 *  - 开启 = `POST /api/shares`（幂等），链接由**当前** token 现算 ⇒ 不存在 T3.2
 *    `if (shareUrl) { copy; return; }` 那种「复制陈旧链接」的短路；
 *  - 撤销 = `DELETE /api/shares`，撤销后重新开启得到同一 token（链接恒定、可恢复）；
 *  - 链接一律用页面 origin 构造（X25），绝不由 API 基址拼出；
 *  - 开启时显著告知「链接内容随源画布实时变化」（用户裁决 ① 的隐私告知）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ShareToggle, { SHARE_LIVE_NOTICE } from "../../src/components/Chat/ShareToggle.js";
import { apiBaseFrom, shareLink } from "../../src/utils/share-link.js";

/** 与 main.tsx 分享路由正则同形状的 token（由会话指纹派生，同一会话恒定） */
const TOKEN = "3f2a9c1d4e5b6a7980112233445566aa";
const PAGE_ORIGIN = window.location.origin; // jsdom: http://localhost:3000
const API = apiBaseFrom(PAGE_ORIGIN) ?? "";
const EXPECTED_LINK = shareLink(`/share/${TOKEN}`, PAGE_ORIGIN);

let enabledOnServer = false;
let postCount = 0;
let deleteCount = 0;
let stateCount = 0;

beforeEach(() => {
  enabledOnServer = false;
  postCount = 0;
  deleteCount = 0;
  stateCount = 0;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url === `${API}/api/share-state` && method === "GET") {
      stateCount += 1;
      return json(200, { enabled: enabledOnServer, token: TOKEN, enabledAt: enabledOnServer ? "2026-11-15T09:00:00.000Z" : null });
    }
    if (url === `${API}/api/shares` && method === "POST") {
      postCount += 1;
      enabledOnServer = true; // 幂等：重复开启返回同一 token
      return json(200, { enabled: true, token: TOKEN, enabledAt: "2026-11-15T09:00:00.000Z", url: `/share/${TOKEN}` });
    }
    if (url === `${API}/api/shares` && method === "DELETE") {
      deleteCount += 1;
      enabledOnServer = false;
      return json(200, { enabled: false, token: TOKEN });
    }
    return json(404, { error: `unexpected ${method} ${url}` });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("分享开关：默认关，状态来自 GET /api/share-state", () => {
  it("挂载即查状态；未开启时按钮语义是「开启只读分享」", async () => {
    render(<ShareToggle />);
    await waitFor(() => expect(stateCount).toBe(1));
    expect(screen.getByLabelText("开启只读分享")).toBeTruthy();
    expect(screen.queryByText("撤销分享")).toBeNull();
    expect(postCount).toBe(0);
  });

  it("服务端已开启 → 初始即「已开启」态（开关状态不靠组件内 state 记忆）", async () => {
    enabledOnServer = true;
    render(<ShareToggle />);
    await screen.findByLabelText("只读分享已开启");
    expect(screen.queryByLabelText("开启只读分享")).toBeNull();
  });

  it("后端未连接时禁用（与既有分享按钮一致）", async () => {
    render(<ShareToggle disabled />);
    await waitFor(() => expect(stateCount).toBe(1));
    expect((screen.getByLabelText("开启只读分享") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("开启 / 撤销 / 链接恒定性", () => {
  it("点击开启 → POST /api/shares，浮层给出页面 origin 的链接 + 隐私告知", async () => {
    render(<ShareToggle />);
    fireEvent.click(await screen.findByLabelText("开启只读分享"));

    await screen.findByText("只读分享已开启");
    expect(postCount).toBe(1);
    expect(screen.getByText(EXPECTED_LINK)).toBeTruthy();
    // X25 反向断言：链接绝不由 API 基址拼出
    expect(EXPECTED_LINK).not.toContain(`${API}/`);
    expect(screen.getByText(EXPECTED_LINK).textContent).not.toBe(`${API}/share/${TOKEN}`);
    // 裁决 ①：隐私告知必须显著可见
    expect(document.body.textContent).toContain(SHARE_LIVE_NOTICE);
    expect(document.body.textContent).toContain("后续新增");
  });

  it("已开启时再点只展开浮层（不再 POST）；链接由当前 token 现算，不是缓存的旧链接", async () => {
    enabledOnServer = true;
    render(<ShareToggle />);
    fireEvent.click(await screen.findByLabelText("只读分享已开启"));

    await screen.findByText("只读分享已开启");
    expect(postCount).toBe(0); // T3.2 的短路复制路径已不存在
    expect(screen.getByText(EXPECTED_LINK)).toBeTruthy();
    // 再点一次收起，仍然不发请求
    fireEvent.click(screen.getByLabelText("只读分享已开启"));
    await waitFor(() => expect(screen.queryByText("只读分享已开启")).toBeNull());
    expect(postCount).toBe(0);
  });

  it("撤销 → DELETE /api/shares 并回到未开启态；重新开启得到同一 token（链接恒定）", async () => {
    render(<ShareToggle />);
    fireEvent.click(await screen.findByLabelText("开启只读分享"));
    const firstLink = (await screen.findByText(EXPECTED_LINK)).textContent;

    fireEvent.click(screen.getByText("撤销分享"));
    await waitFor(() => expect(deleteCount).toBe(1));
    await screen.findByLabelText("开启只读分享");
    expect(screen.queryByText("撤销分享")).toBeNull();

    // 再开启：服务端派生的 token 不变 ⇒ 链接完全一致（同一会话链接恒定）
    fireEvent.click(screen.getByLabelText("开启只读分享"));
    const secondLink = (await screen.findByText(EXPECTED_LINK)).textContent;
    expect(secondLink).toBe(firstLink);
    expect(postCount).toBe(2);
  });

  it("开启失败（无活动会话 409）时给出错误提示，不假装已开启", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "share requires an active session" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    render(<ShareToggle />);
    fireEvent.click(await screen.findByLabelText("开启只读分享"));
    await screen.findByText("share requires an active session");
    expect(screen.queryByText("只读分享已开启")).toBeNull();
  });
});
