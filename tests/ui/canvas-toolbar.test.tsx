// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import CanvasToolbar from "../../src/components/Canvas/CanvasToolbar.js";

const storeMocks = vi.hoisted(() => ({
  createManualSQLNode: vi.fn(),
  autoLayout: vi.fn(),
  nodes: [] as unknown[],
}));

vi.mock("../../src/store/canvas-store", () => ({
  useCanvasStore: (selector: (state: typeof storeMocks) => unknown) => selector(storeMocks),
}));

function renderToolbar(nodeCount: number) {
  storeMocks.nodes = new Array(nodeCount);
  return render(
    <ReactFlowProvider>
      <CanvasToolbar />
    </ReactFlowProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CanvasToolbar 整理画布按钮", () => {
  it("点击调用 store.autoLayout", () => {
    renderToolbar(3);
    fireEvent.click(screen.getByRole("button", { name: /整理画布/ }));
    expect(storeMocks.autoLayout).toHaveBeenCalledTimes(1);
  });

  it("节点不足 2 个时禁用", () => {
    renderToolbar(1);
    const btn = screen.getByRole("button", { name: /整理画布/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(storeMocks.autoLayout).not.toHaveBeenCalled();
  });
});
