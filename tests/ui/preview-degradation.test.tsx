// @vitest-environment jsdom

/**
 * T3.7 降级语义 UI 测试：预览面板在「数据不在本机」时必须**说出来**，不能静默渲染成空表。
 *
 * 背景：导入的会话包按设计不含 parquet（T3.6 用户裁决 ③），所以导入会话里点「预览」必然
 * 404。改动前 `openPreviewPanel` 的 `.catch()` 只 `console.error`，面板照旧渲染成
 * 「0 rows」的空表 —— 用户看到的是「没数据」而不是「数据不在本机，需要重新加载」，
 * 属 T3.7 scope 4 点名的静默失败。这里用**真实 store + 真实面板组件**锁住修复后的行为。
 *
 * 注意：本文件刻意**不碰** `openPreviewPanel` 里的「页面端口 +1」基址（X25 遗留 2，归口 T3.4）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useCanvasStore } from "../../src/store/canvas-store";
import FloatingPreviewPanel from "../../src/components/Canvas/FloatingPreviewPanel.js";
import type { DataFrameNodeData } from "../../src/types/index.js";

const DF_NODE_ID = "gov-df-1";
const DF_NAME = "df_sales_amount_by_channel";

function dfData(overrides: Partial<DataFrameNodeData> = {}): DataFrameNodeData {
  return {
    type: "dataFrame",
    title: DF_NAME,
    createdAt: "2026-11-17T00:00:00.000Z",
    dfName: DF_NAME,
    sourceName: "duckdb://TEST-ONLY",
    totalRows: 3,
    totalColumns: 1,
    memoryUsage: "1 KB",
    columns: [{ name: "amount", dtype: "float64", nonNull: 3 }],
    previewData: [],
    ...overrides,
  } as DataFrameNodeData;
}

function seedStore(data: DataFrameNodeData = dfData()) {
  useCanvasStore.setState({
    nodes: [{ id: DF_NODE_ID, type: "dataFrame", position: { x: 0, y: 0 }, data } as never],
    edges: [],
    previewPanels: [],
  });
}

/** 预览接口的替身：status + JSON body（后端 404 会带 `{error}`）。 */
function stubPreview(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? "Not Found" : "Error",
      json: async () => body,
    })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  seedStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useCanvasStore.setState({ nodes: [], edges: [], previewPanels: [] });
});

function firstPanel() {
  const panels = useCanvasStore.getState().previewPanels;
  expect(panels.length, "应打开一个预览面板").toBe(1);
  return panels[0];
}

describe("预览取数失败的降级提示（store 层）", () => {
  it("404（parquet 不在本机）→ previewError 说明原因与下一步，不再是空表", async () => {
    stubPreview(404, { error: `DataFrame '${DF_NAME}' not found` });
    useCanvasStore.getState().openPreviewPanel(DF_NODE_ID);
    await waitFor(() => expect(firstPanel().previewError).toBeTruthy());

    const msg = firstPanel().previewError!;
    expect(msg).toContain("数据不在本机");
    expect(msg).toContain(DF_NAME);
    expect(msg).toContain("导入的会话包不含数据文件");
    expect(msg).toContain("重新加载");
    expect(msg).toContain(`DataFrame '${DF_NAME}' not found`); // 后端原因如实附上
    expect(firstPanel().data.previewData).toEqual([]);
  });

  it("其它 HTTP 失败 → previewError 带状态码与后端原因", async () => {
    stubPreview(500, { error: "parquet 解析失败" });
    useCanvasStore.getState().openPreviewPanel(DF_NODE_ID);
    await waitFor(() => expect(firstPanel().previewError).toBeTruthy());
    expect(firstPanel().previewError).toContain("预览失败：HTTP 500");
    expect(firstPanel().previewError).toContain("parquet 解析失败");
  });

  it("网络异常（fetch reject）→ 有提示且不抛未捕获异常", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    useCanvasStore.getState().openPreviewPanel(DF_NODE_ID);
    await waitFor(() => expect(firstPanel().previewError).toBeTruthy());
    expect(firstPanel().previewError).toContain("ECONNREFUSED");
    expect(unhandled).not.toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
  });

  it("成功取数 → previewData 落地且 previewError 为空", async () => {
    stubPreview(200, [{ amount: 1 }, { amount: 2 }]);
    useCanvasStore.getState().openPreviewPanel(DF_NODE_ID);
    await waitFor(() => expect(firstPanel().data.previewData.length).toBe(2));
    expect(firstPanel().previewError).toBeUndefined();
  });

  it("先失败后成功：updatePreviewPanelData 会清掉旧的错误提示", async () => {
    stubPreview(404, { error: "not found" });
    useCanvasStore.getState().openPreviewPanel(DF_NODE_ID);
    await waitFor(() => expect(firstPanel().previewError).toBeTruthy());

    useCanvasStore.getState().updatePreviewPanelData(firstPanel().id, [{ amount: 9 }]);
    expect(firstPanel().previewError).toBeUndefined();
    expect(firstPanel().data.previewData).toEqual([{ amount: 9 }]);
  });

  it("setPreviewPanelError 只影响目标面板", () => {
    useCanvasStore.setState({
      previewPanels: [
        { id: "p1", nodeId: "n1", data: dfData(), x: 0, y: 0 },
        { id: "p2", nodeId: "n2", data: dfData({ dfName: "df_other" }), x: 0, y: 0 },
      ],
    });
    useCanvasStore.getState().setPreviewPanelError("p1", "TEST-ONLY 错误");
    const panels = useCanvasStore.getState().previewPanels;
    expect(panels.find((p) => p.id === "p1")!.previewError).toBe("TEST-ONLY 错误");
    expect(panels.find((p) => p.id === "p2")!.previewError).toBeUndefined();
  });
});

describe("预览面板渲染（组件层）", () => {
  it("有 previewError 时渲染告警块，不渲染空表与分页页脚", () => {
    render(
      <FloatingPreviewPanel
        panel={{
          id: "p1",
          nodeId: DF_NODE_ID,
          data: dfData(),
          x: 0,
          y: 0,
          previewError: `数据不在本机：DataFrame「${DF_NAME}」的 parquet 不存在。`,
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("数据不在本机");
    expect(alert.textContent).toContain(DF_NAME);
    expect(screen.queryByRole("table")).toBeNull(); // 不再是「0 rows」空表
    expect(screen.queryByText(/rows ·/)).toBeNull(); // 页脚统计与分页一并隐藏
    expect(screen.getByText(DF_NAME)).toBeTruthy(); // 头部仍显示是哪个 DataFrame
  });

  it("无 previewError 时照常渲染表格（既有行为零回归）", () => {
    render(
      <FloatingPreviewPanel
        panel={{
          id: "p1",
          nodeId: DF_NODE_ID,
          data: dfData({ previewData: [{ amount: 1 }], totalRows: 1 }),
          x: 0,
          y: 0,
        }}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("amount")).toBeTruthy();
    expect(screen.getByText(/1 rows ·/)).toBeTruthy();
  });
});
