// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsModal from "../../src/components/SettingsModal.js";
import type { ModelsConfig } from "../../src/types/models-config.js";

function configWith(names: string[]): ModelsConfig {
  return {
    providers: Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          baseUrl: `https://${index}.example.com`,
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: `model-${index}`, name: `Model ${index}` }],
        },
      ])
    ),
  };
}

function renderModal(config: ModelsConfig | null = configWith(["alpha"])) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const result = render(
    <SettingsModal initialConfig={config} onSave={onSave} onClose={onClose} />
  );
  return { ...result, onSave, onClose };
}

afterEach(() => {
  cleanup();
});

describe("SettingsModal 交互回归", () => {
  it("initialConfig=null 时渲染加载骨架", () => {
    renderModal(null);

    expect(screen.getByText("正在加载配置...")).toBeTruthy();
    expect(screen.queryByPlaceholderText("provider name")).toBeNull();
  });

  it("连续输入时值累积、焦点留在同一 DOM 节点、选区推进到末尾", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha"]));
    const input = screen.getByPlaceholderText("provider name") as HTMLInputElement;

    await user.click(input);
    await user.type(input, "-beta");

    expect(input.value).toBe("alpha-beta");
    expect(screen.getByPlaceholderText("provider name")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("添加 Provider 后既有 provider 卡片与输入节点不被重挂载", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha"]));
    const firstInput = screen.getByPlaceholderText("provider name");

    await user.click(screen.getByRole("button", { name: "添加 Provider" }));

    expect(screen.getAllByPlaceholderText("provider name")).toHaveLength(2);
    expect(screen.getAllByPlaceholderText("provider name")[0]).toBe(firstInput);
  });

  it("清空名称后就地提示、页脚提示并禁用保存", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha"]));
    const input = screen.getByPlaceholderText("provider name");

    await user.clear(input);

    expect(screen.getAllByText("Provider 名称不能为空")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("改成另一个 provider 同名后就地提示、页脚提示并禁用保存", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha", "beta"]));
    const firstInput = screen.getAllByPlaceholderText("provider name")[0];

    await user.clear(firstInput);
    await user.type(firstInput, "beta");

    expect(screen.getAllByText('Provider 名称重复："beta"')).toHaveLength(3);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("可增删模型行，删除后其余行值随之更新", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha"]));

    await user.click(screen.getByRole("button", { name: "添加模型" }));
    const ids = screen.getAllByPlaceholderText("模型 ID") as HTMLInputElement[];
    await user.type(ids[1], "second");
    expect(screen.getAllByPlaceholderText("模型 ID")).toHaveLength(2);

    await user.click(screen.getAllByTitle("删除模型")[0]);

    expect(screen.getAllByPlaceholderText("模型 ID")).toHaveLength(1);
    expect((screen.getByPlaceholderText("模型 ID") as HTMLInputElement).value).toBe("second");
  });

  it("删除 provider 后只保留其余卡片", async () => {
    const user = userEvent.setup();
    renderModal(configWith(["alpha", "beta"]));

    await user.click(screen.getAllByTitle("删除 provider")[0]);

    const names = screen.getAllByPlaceholderText("provider name") as HTMLInputElement[];
    expect(names).toHaveLength(1);
    expect(names[0].value).toBe("beta");
  });

  it("取消按钮调用 onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 调用 onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点遮罩关闭，点对话框内容不冒泡关闭", () => {
    const { onClose } = renderModal();
    const overlay = screen.getByText("LLM 设置").closest(".fixed.inset-0");
    expect(overlay).not.toBeNull();

    fireEvent.click(overlay!.firstElementChild!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("保存时提交 onSave：名称与模型 ID trim、空模型被过滤", async () => {
    const user = userEvent.setup();
    const config: ModelsConfig = {
      providers: {
        " alpha ": {
          baseUrl: "https://api.example.com",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: " primary ", name: "Primary" }, { id: "   " }],
        },
      },
    };
    const { onSave } = renderModal(config);

    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      providers: {
        alpha: {
          baseUrl: "https://api.example.com",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "primary", name: "Primary" }],
        },
      },
    });
  });
});
