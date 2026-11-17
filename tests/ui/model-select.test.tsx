// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ModelSelect from "../../src/components/Chat/ModelSelect.js";
import type { ModelOption } from "../../src/hooks/useChat.js";

function makeOptions(count: number): ModelOption[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `provider-${i % 3}/model-${i}`,
    provider: `provider-${i % 3}`,
    modelId: `model-${i}`,
    label: `provider-${i % 3} / model-${i}`,
    thinkingLevels: ["off", "low", "medium", "high"],
  }));
}

afterEach(() => {
  cleanup();
});

describe("ModelSelect 模型下拉（大量模型场景）", () => {
  it("搜索过滤：输入关键词只显示匹配项", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelSelect options={makeOptions(60)} value={null} onChange={onChange} />);

    await user.click(screen.getByRole("button"));
    expect(screen.getAllByRole("button").length).toBeGreaterThan(60); // 触发钮 + 60 选项

    await user.type(screen.getByPlaceholderText("搜索模型"), "model-59");
    expect(screen.getByText("provider-2 / model-59")).toBeTruthy();
    expect(screen.queryByText("provider-0 / model-0")).toBeNull();
  });

  it("无匹配项时给出提示", async () => {
    const user = userEvent.setup();
    render(<ModelSelect options={makeOptions(5)} value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button"));
    await user.type(screen.getByPlaceholderText("搜索模型"), "zzz-no-such-model");
    expect(screen.getByText("无匹配模型")).toBeTruthy();
  });

  it("点选回调 onChange 并关闭弹层；Esc 关闭", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const options = makeOptions(3);
    render(<ModelSelect options={options} value={options[0]} onChange={onChange} />);

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByText("provider-1 / model-1"));
    expect(onChange).toHaveBeenCalledWith(options[1]);
    expect(screen.queryByPlaceholderText("搜索模型")).toBeNull(); // 弹层已关

    await user.click(screen.getByRole("button"));
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("搜索模型")).toBeNull();
  });
});
