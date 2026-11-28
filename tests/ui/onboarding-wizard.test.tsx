// @vitest-environment jsdom

/**
 * X34 前端首启向导 / 数据源表单 / secret_redirect 收尾卡片的 UI 回归。
 *
 * 覆盖：
 *  - OnboardingWizard：Step0 环境自检状态展示；Step1 无默认供应商（R7，必须主动选预置）
 *  - DatasourceForm：密码掩码显隐 + 信任徽标（凭据仅加密存本机）
 *  - SecretRedirectCard：可读引导 + 脱敏摘要 + 「打开数据源表单」按钮（govio:open-datasources）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OnboardingWizard from "../../src/components/OnboardingWizard.js";
import DatasourceForm from "../../src/components/DatasourceForm.js";
import { SecretRedirectCard } from "../../src/components/Chat/ChatMessage.js";
import { ChatContext } from "../../src/hooks/useChatContext.js";
import type { useChat } from "../../src/hooks/useChat.js";

function mockChat() {
  return {
    onboardingAction: vi.fn(async (payload: { action: string }) => {
      if (payload.action === "status") {
        return {
          ok: true,
          data: {
            cli: { installed: true, version: "0.8.0" },
            graph: { initialized: false, backend: null },
            datasources: [],
            skillsReady: true,
            modelsConfigured: false,
          },
        };
      }
      return { ok: true, data: { cliVersion: "0.8.0", skillsReady: true } };
    }),
    fetchModelsConfig: vi.fn(async () => ({ providers: {} })),
    saveModelsConfig: vi.fn(async () => {}),
  };
}

function renderWizard() {
  const chat = mockChat();
  const onClose = vi.fn();
  render(
    <ChatContext.Provider value={chat as unknown as ReturnType<typeof useChat>}>
      <OnboardingWizard onClose={onClose} />
    </ChatContext.Provider>
  );
  return { chat, onClose };
}

afterEach(() => {
  cleanup();
});

describe("OnboardingWizard 首启向导", () => {
  it("进入默认在 Step0 环境自检，展示 govio-cli 版本达标状态与信任徽标", async () => {
    renderWizard();

    expect(await screen.findByText(/已满足最低版本要求/)).toBeTruthy();
    expect(screen.getAllByText(/govio-cli v0\.8\.0/).length).toBeGreaterThan(0);
    expect(screen.getByText("凭据仅加密存本机、不发往大模型")).toBeTruthy();
  });

  it("Step1 无默认供应商：未选预置不出现表单，选中 DeepSeek 后按预置填充且 apiKey 为空", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole("button", { name: "LLM 配置" }));
    expect(screen.getByText("选择供应商（无默认，需主动选择）")).toBeTruthy();
    // 未选预置 → 无表单字段（R7：必须主动选一个）
    expect(screen.queryByPlaceholderText("sk-...")).toBeNull();

    await user.click(screen.getByRole("button", { name: "DeepSeek" }));
    expect((screen.getByPlaceholderText("https://api.example.com") as HTMLInputElement).value).toBe(
      "https://api.deepseek.com"
    );
    expect((screen.getByPlaceholderText("sk-...") as HTMLInputElement).value).toBe("");
    // 未填 apiKey / 模型 ID 前「保存并测试」禁用
    expect((screen.getByRole("button", { name: /保存并测试/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DatasourceForm 数据源凭据表单", () => {
  it("密码掩码显隐 + 落盘位置信任徽标", async () => {
    const user = userEvent.setup();
    render(<DatasourceForm submitLabel="保存数据源" onSubmit={vi.fn()} />);

    expect(screen.getByText(/凭据仅加密存于本机 ~\/\.govio\/config\.yaml/)).toBeTruthy();
    const password = screen.getByPlaceholderText("仅加密存本机，不发往大模型") as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.click(screen.getByTitle("显示密码"));
    expect((screen.getByPlaceholderText("仅加密存本机，不发往大模型") as HTMLInputElement).type).toBe("text");
  });

  it("名称/URL 为空时禁用提交", () => {
    render(<DatasourceForm submitLabel="保存数据源" onSubmit={vi.fn()} />);
    expect((screen.getByRole("button", { name: "保存数据源" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SecretRedirectCard 秘密拦截收尾（X34 design.md 遗留 8）", () => {
  it("渲染可读引导 + 脱敏摘要，按钮派发 govio:open-datasources", () => {
    const listener = vi.fn();
    window.addEventListener("govio:open-datasources", listener);
    render(
      <SecretRedirectCard
        info={{
          message: "这条消息里包含明文密码，已经拦下，没有发给大模型。",
          categories: ["password"],
          redactedSnippets: ["password=[REDACTED]"],
        }}
      />
    );

    expect(screen.getByText("凭据拦截（未发送给大模型）")).toBeTruthy();
    expect(screen.getByText("password=[REDACTED]")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /打开数据源表单/ }));
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("govio:open-datasources", listener);
  });
});
