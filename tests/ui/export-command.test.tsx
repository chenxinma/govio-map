// @vitest-environment jsdom

/**
 * T3.6 `/export` 命令接线 UI 测试：命令文案、触发链路、进度/结果反馈。
 *
 * 打包逻辑本身在 `tests/integration/export-bundle.test.ts`（node 环境，产物反解逐条核对）；
 * 这里只锁「用户在聊天框里选 /export 会发生什么」：
 *  - 命令描述已是打包语义（不再是「导出会话保存成json」）
 *  - 选中命令 → 调 `exportSessionBundle`，并把**页面 origin** 交给它（基址由 X25 模块推导）
 *  - 成功/失败都在输入框上方给一句话反馈，不静默失败
 *  - 导出进行中重复触发不会并发第二次（防重复打包）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const exportMock = vi.hoisted(() => ({ exportSessionBundle: vi.fn() }));
vi.mock("../../src/commands/export-session", () => exportMock);

import ChatInput from "../../src/components/Chat/ChatInput.js";

function renderInput() {
  return render(
    <ChatInput
      onSend={() => {}}
      onAbort={() => {}}
      isStreaming={false}
      isConnected={true}
    />,
  );
}

/** 输入 `/export` 让建议下拉出现，并返回那个命令按钮。 */
function openExportSuggestion(): HTMLButtonElement {
  const textarea = screen.getByRole("textbox");
  fireEvent.change(textarea, { target: { value: "/export" } });
  return screen.getByRole("button", { name: /^\/export/ }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** ChatInput 挂载时会拉 /api/skills（失败静默）；给个替身避免 jsdom 下 fetch 缺失。 */
function stubSkillsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ skills: [] }) })) as unknown as typeof fetch,
  );
}

describe("/export 命令接线", () => {
  it("命令描述已是「打包导出为 zip」语义", () => {
    stubSkillsFetch();
    renderInput();
    const btn = openExportSuggestion();
    expect(btn.textContent).toContain("打包导出当前会话为 zip");
    expect(btn.textContent).not.toContain("保存成json");
  });

  it("选中命令即调 exportSessionBundle，并交出页面 origin（基址推导交给 X25 模块）", async () => {
    stubSkillsFetch();
    exportMock.exportSessionBundle.mockResolvedValue({
      fileName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.govio-bundle.zip",
      bytes: 2048,
      fileCount: 6,
      token: "a".repeat(32),
      sessionId: "s-1",
      reportIncluded: true,
      excludedParquet: { count: 0, bytes: 0 },
    });
    renderInput();
    fireEvent.click(openExportSuggestion());

    await waitFor(() => expect(exportMock.exportSessionBundle).toHaveBeenCalledTimes(1));
    const arg = exportMock.exportSessionBundle.mock.calls[0][0] as { pageOrigin: string };
    expect(arg.pageOrigin).toBe(window.location.origin);
    // 反馈文案：文件名 + 体积 + 文件数 + 含交付报告
    expect(await screen.findByText(/已导出 a{32}\.govio-bundle\.zip/)).toBeTruthy();
    expect(screen.getByText(/2 KB/)).toBeTruthy();
    expect(screen.getByText(/6 个文件/)).toBeTruthy();
    expect(screen.getByText(/含交付报告/)).toBeTruthy();
  });

  it("排除了 parquet 时，反馈里如实说明（清单已记账）", async () => {
    stubSkillsFetch();
    exportMock.exportSessionBundle.mockResolvedValue({
      fileName: "b".repeat(32) + ".govio-bundle.zip",
      bytes: 4096,
      fileCount: 5,
      token: "b".repeat(32),
      sessionId: "s-2",
      reportIncluded: false,
      excludedParquet: { count: 3, bytes: 1234 },
    });
    renderInput();
    fireEvent.click(openExportSuggestion());
    expect(await screen.findByText(/未含 3 个 parquet/)).toBeTruthy();
    expect(screen.getByText(/无交付报告（画布为空）/)).toBeTruthy();
  });

  it("失败给明确提示，不静默", async () => {
    stubSkillsFetch();
    exportMock.exportSessionBundle.mockRejectedValue(new Error("当前没有活动会话，无法打包导出（先发一条消息或打开一个历史会话）。"));
    renderInput();
    fireEvent.click(openExportSuggestion());
    expect(await screen.findByText(/导出失败：当前没有活动会话/)).toBeTruthy();
  });

  it("打包进行中再次触发不并发第二次", async () => {
    stubSkillsFetch();
    let release: (v: unknown) => void = () => {};
    exportMock.exportSessionBundle.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderInput();
    fireEvent.click(openExportSuggestion());
    expect(await screen.findByText(/正在打包会话/)).toBeTruthy();

    // 第一次还没结束就再选一次命令：不应发起第二个打包
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/export" } });
    fireEvent.click(screen.getByRole("button", { name: /^\/export/ }));
    expect(exportMock.exportSessionBundle).toHaveBeenCalledTimes(1);

    release({
      fileName: "c".repeat(32) + ".govio-bundle.zip",
      bytes: 1024,
      fileCount: 4,
      token: "c".repeat(32),
      sessionId: "s-3",
      reportIncluded: true,
      excludedParquet: { count: 0, bytes: 0 },
    });
    expect(await screen.findByText(/已导出 c{32}\.govio-bundle\.zip/)).toBeTruthy();
  });
});
