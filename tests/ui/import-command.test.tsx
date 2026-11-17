// @vitest-environment jsdom

/**
 * T3.7 `/import` 命令接线 UI 测试：参数通道、触发链路、进度/结果反馈、既有命令零回归。
 *
 * 导入的服务端逻辑与 HTTP 契约在 `tests/integration/session-import.test.ts`；这里只锁
 * 「用户在聊天框里输入 `/import <路径>` 会发生什么」：
 *  - 命令**参数通道**（T3.7 新增）只对声明了 `args` 的命令生效 ⇒ `/export foo` 这类既有输入
 *    仍原样发给 agent，行为逐字不变
 *  - 下拉里选中 `/import` 是**预填**而不是执行（等用户补路径）
 *  - 成功反馈给会话名 + 节点数，并触发会话列表刷新（走既有 WS `session_list`）
 *  - 失败给人话原因；缺参数给用法提示；导入中不并发第二次
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const importMock = vi.hoisted(() => ({ importSessionBundle: vi.fn() }));
vi.mock("../../src/commands/import-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/import-session")>();
  return { ...actual, importSessionBundle: importMock.importSessionBundle };
});

const exportMock = vi.hoisted(() => ({ exportSessionBundle: vi.fn() }));
vi.mock("../../src/commands/export-session", () => exportMock);

import ChatInput from "../../src/components/Chat/ChatInput.js";
import { parseSlashCommand } from "../../src/commands/registry";
import { getBuiltInCommands } from "../../src/commands/built-in";
import { SessionImportError } from "../../src/commands/import-session";

const OK_RESULT = {
  ok: true,
  sessionId: "01a1ffff-4444-4444-8444-444444444444",
  sessionFile: "/tmp/x/.govio/sessions/2026-11-17T05-06-07-000Z_01a1ffff.jsonl",
  sessionName: "第四季度治理会话",
  messageCount: 12,
  nodeCount: 7,
  edgeCount: 6,
  manifestCount: 4,
  importedFrom: {
    token: "c".repeat(32),
    exportedAt: "2026-11-17T05:00:00.000Z",
    originalSessionId: "2026-11-16T01-00-00-000Z_src",
    originSessionName: "第四季度治理会话",
    bundleFileName: "c.govio-bundle.zip",
    importedAt: "2026-11-17T05:06:07.000Z",
  },
  filesWritten: ["session.jsonl", "canvas.json"],
  missing: [],
  excludedParquet: { count: 0, bytes: 0, names: [], absent: [] },
};

/** ChatInput 挂载时会拉 /api/skills（失败静默）；给个替身避免 jsdom 下 fetch 缺失。 */
function stubSkillsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ skills: [] }) })) as unknown as typeof fetch,
  );
}

function renderInput(opts: { onSend?: (s: string) => void; onSessionsChanged?: () => void } = {}) {
  const onSend = vi.fn(opts.onSend);
  const onSessionsChanged = vi.fn(opts.onSessionsChanged);
  render(
    <ChatInput
      onSend={onSend}
      onAbort={() => {}}
      isStreaming={false}
      isConnected={true}
      onSessionsChanged={onSessionsChanged}
    />,
  );
  return { onSend, onSessionsChanged, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

/** 输入文本并回车（走 handleSend 路径；建议下拉此时因不匹配而不显示）。 */
function typeAndEnter(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("命令参数通道（parseSlashCommand）", () => {
  const commands = getBuiltInCommands();

  it("/import 声明了参数，既有命令没有", () => {
    const importCmd = commands.find((c) => c.name === "import");
    expect(importCmd?.args).toEqual({ placeholder: "bundle 路径", required: true });
    expect(importCmd?.description).toContain("/import <bundle 路径>");
    for (const name of ["export", "clear", "clear-canvas"]) {
      expect(commands.find((c) => c.name === name)?.args, `${name} 不应声明参数`).toBeUndefined();
    }
  });

  it("只截获声明了 args 的命令：/export foo 仍原样发给 agent（零行为变化）", () => {
    expect(parseSlashCommand("/export D:/x.zip", commands)).toBeNull();
    expect(parseSlashCommand("/clear now", commands)).toBeNull();
    expect(parseSlashCommand("/skill:govio do it", commands)).toBeNull();
  });

  it("命令名全等匹配（大小写不敏感），前缀相似不误判", () => {
    expect(parseSlashCommand("/important D:/x.zip", commands)).toBeNull();
    expect(parseSlashCommand("/imports D:/x.zip", commands)).toBeNull();
    expect(parseSlashCommand("/IMPORT D:/x.zip", commands)?.args).toBe("D:/x.zip");
  });

  it("余串整体作为单个参数（含空格路径），首尾空白去掉", () => {
    expect(parseSlashCommand("/import D:/my downloads/x.govio-bundle.zip", commands)?.args).toBe(
      "D:/my downloads/x.govio-bundle.zip",
    );
    expect(parseSlashCommand("  /import   /a/b.zip  ", commands)?.args).toBe("/a/b.zip");
    expect(parseSlashCommand("/import", commands)?.args).toBe("");
    expect(parseSlashCommand("/import   ", commands)?.args).toBe("");
  });

  it("非斜杠输入与空输入不解析", () => {
    expect(parseSlashCommand("import /a/b.zip", commands)).toBeNull();
    expect(parseSlashCommand("", commands)).toBeNull();
    expect(parseSlashCommand("/", commands)).toBeNull();
    expect(parseSlashCommand(undefined as unknown as string, commands)).toBeNull();
  });
});

describe("/import 命令接线", () => {
  it("下拉里选中 /import 是预填命令而不是立即执行（等用户补路径）", async () => {
    stubSkillsFetch();
    importMock.importSessionBundle.mockResolvedValue(OK_RESULT);
    const { textarea } = renderInput();
    fireEvent.change(textarea, { target: { value: "/import" } });
    const btn = screen.getByRole("button", { name: /^\/import/ }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(textarea.value).toBe("/import "));
    expect(importMock.importSessionBundle).not.toHaveBeenCalled();
  });

  it("输入 /import <路径> 回车即导入，并交出页面 origin 与路径", async () => {
    stubSkillsFetch();
    importMock.importSessionBundle.mockResolvedValue(OK_RESULT);
    const { onSend, textarea } = renderInput();
    typeAndEnter(textarea, "/import D:/downloads/c.govio-bundle.zip");
    await waitFor(() => expect(importMock.importSessionBundle).toHaveBeenCalledTimes(1));
    expect(importMock.importSessionBundle.mock.calls[0][0]).toMatchObject({
      pageOrigin: window.location.origin,
      bundlePath: "D:/downloads/c.govio-bundle.zip",
    });
    expect(onSend, "命令不该被发给 agent").not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("成功反馈给会话名与节点数，并刷新会话列表（既有 WS 通道）", async () => {
    stubSkillsFetch();
    importMock.importSessionBundle.mockResolvedValue(OK_RESULT);
    const { onSessionsChanged, textarea } = renderInput();
    typeAndEnter(textarea, "/import /a/b.zip");
    await waitFor(() => expect(onSessionsChanged).toHaveBeenCalledTimes(1));
    const note = await screen.findByText(/已导入为历史会话/);
    expect(note.textContent).toContain("第四季度治理会话");
    expect(note.textContent).toContain("7 节点");
    expect(note.textContent).toContain("12 条对话");
  });

  it("失败给具体原因，不静默失败；列表不刷新", async () => {
    stubSkillsFetch();
    importMock.importSessionBundle.mockRejectedValue(new SessionImportError("文件校验和不符，包可能已损坏或被改动，已拒绝导入。", "checksum-mismatch"));
    const { onSessionsChanged, textarea } = renderInput();
    typeAndEnter(textarea, "/import /a/bad.zip");
    const note = await screen.findByText(/导入失败/);
    expect(note.textContent).toContain("校验和不符");
    expect(onSessionsChanged).not.toHaveBeenCalled();
  });

  it("缺参数时给用法提示，不打后端", async () => {
    stubSkillsFetch();
    const { textarea } = renderInput();
    // 尾随空格 ⇒ 建议下拉不显示 ⇒ 回车走 handleSend 的解析分支
    typeAndEnter(textarea, "/import   ");
    await waitFor(() => expect(screen.getByText(/用法：\/import <bundle 路径>/)).toBeTruthy());
    expect(importMock.importSessionBundle).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/import "); // 预填好等用户补路径
  });

  it("导入进行中重复触发不会并发第二次", async () => {
    stubSkillsFetch();
    let release: (v: unknown) => void = () => {};
    importMock.importSessionBundle.mockReturnValue(new Promise((r) => { release = r; }));
    const { textarea } = renderInput();
    typeAndEnter(textarea, "/import /a/b.zip");
    await waitFor(() => expect(importMock.importSessionBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/正在校验并导入/)).toBeTruthy();
    // 第二次触发（输入框已清空，重新输入同一条命令）
    typeAndEnter(textarea, "/import /a/b.zip");
    expect(importMock.importSessionBundle).toHaveBeenCalledTimes(1);
    release(OK_RESULT);
    await waitFor(() => expect(screen.getByText(/已导入为历史会话/)).toBeTruthy());
  });
});

describe("既有命令零回归", () => {
  it("/export 从下拉选中仍立即执行（不预填）", async () => {
    stubSkillsFetch();
    exportMock.exportSessionBundle.mockResolvedValue({
      fileName: "a.govio-bundle.zip",
      bytes: 2048,
      fileCount: 6,
      token: "a".repeat(32),
      sessionId: "s-1",
      reportIncluded: true,
      excludedParquet: { count: 0, bytes: 0 },
    });
    const { textarea } = renderInput();
    fireEvent.change(textarea, { target: { value: "/export" } });
    fireEvent.click(screen.getByRole("button", { name: /^\/export/ }));
    await waitFor(() => expect(exportMock.exportSessionBundle).toHaveBeenCalledTimes(1));
    expect(textarea.value).toBe("");
  });

  it("/export <多余参数> 仍原样发给 agent（不被参数通道截走）", () => {
    stubSkillsFetch();
    const { onSend, textarea } = renderInput();
    typeAndEnter(textarea, "/export 帮我导出一下");
    expect(onSend).toHaveBeenCalledWith("/export 帮我导出一下");
    expect(exportMock.exportSessionBundle).not.toHaveBeenCalled();
    expect(importMock.importSessionBundle).not.toHaveBeenCalled();
  });

  it("普通消息照常发给 agent", () => {
    stubSkillsFetch();
    const { onSend, textarea } = renderInput();
    typeAndEnter(textarea, "帮我查一下销售数据");
    expect(onSend).toHaveBeenCalledWith("帮我查一下销售数据");
  });
});
