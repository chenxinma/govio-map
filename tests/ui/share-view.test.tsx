// @vitest-environment jsdom
/**
 * T3.5 只读分享「活视图」UI 测试（src/components/Share/ShareView.tsx）。
 *
 * 锁的是任务书 §3 的四个陷阱与只读纪律：
 *  - 陷阱 1：全流程结束后 `localStorage['govio-canvas-state']` **字节未被改写**
 *    （远端画布绝不能被 persist 写进本机，否则用户下次打开主界面 rehydrate 成别人的画布）；
 *  - 陷阱 2：远端数据到达前只渲染 loading，**任何时刻不渲染本机 localStorage 里的节点**；
 *  - 陷阱 3：只读页不存在任何写回源 session 的路径（枚举 mutating 端点，点遍画布内按钮断言不触达），
 *    且五类节点卡片上的副作用入口（引用/删除/预览/复跑/编辑）全部不渲染；
 *  - 陷阱 4：API 基址走 X25 的 `apiBaseFrom(window.location.origin)`，不再有自带的「端口 +1」硬编码；
 *  - 高保真渲染：复用主画布 nodeTypes，chart 节点真渲染出 Plotly（懒加载模块被调用）。
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// plotly 替身：只读页要真渲染图表，但 jsdom 里没有 WebGL/canvas，
// 用替身断言「懒加载模块被调用 + 传入了节点的 config」即等价于「真渲染出 Plotly」。
const plotlyStub = vi.hoisted(() => ({
  react: vi.fn(),
  purge: vi.fn(),
  newPlot: vi.fn(),
}));
vi.mock("plotly.js-dist-min", () => ({ default: plotlyStub }));

// 陷阱 1/2 的前置条件：store 在**模块导入时**就从 localStorage 同步 rehydrate，
// 所以本机画布必须在 import ShareView 之前种进 localStorage（vi.hoisted 早于 import 求值）。
const LOCAL = vi.hoisted(() => {
  const key = "govio-canvas-state";
  const localNode = {
    id: "local-1",
    type: "dataFrame",
    position: { x: 0, y: 0 },
    data: {
      type: "dataFrame",
      title: "本机私有画布_LOCAL_SECRET",
      dfName: "local_secret_df",
      createdAt: "2026-11-15T00:00:00.000Z",
      sourceName: "",
      totalRows: 1,
      totalColumns: 1,
      memoryUsage: "0 B",
      columns: [{ name: "c", nonNull: 1, dtype: "int64" }],
      previewData: [],
    },
  };
  const value = JSON.stringify({ state: { nodes: [localNode], edges: [], referencedNodes: [] }, version: 0 });
  localStorage.setItem(key, value);
  return { key, value, localNode, title: "本机私有画布_LOCAL_SECRET" };
});

import ShareView from "../../src/components/Share/ShareView.js";
import { isCanvasPersistenceNeutralized } from "../../src/components/Share/canvas-persistence.js";
import { useCanvasStore } from "../../src/store/canvas-store.js";
import { nodeTypes } from "../../src/components/Nodes/index.js";
import { apiBaseFrom } from "../../src/utils/share-link.js";
import type { LiveSharePayload } from "../../src/types/share.js";

const TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const API = apiBaseFrom(window.location.origin) ?? "";
const SHARE_URL = `${API}/api/shares/${TOKEN}`;

/** 只读页**不得**触达的端点（会对源 session 产生写/执行副作用，或属于主界面专属写入口）。 */
const MUTATING_ENDPOINTS = [
  /\/api\/execute-sql/,
  /\/api\/rerun-dataframe/,
  /\/api\/preview/,
  /\/api\/canvas-storage/,
  /\/api\/shares\/[^/]+\/rerun/,
];
/** 只读页允许的写：fork（暂存副本，不碰源画布）。POST/DELETE /api/shares 属主界面开关，不在只读页。 */
const SHARE_TOGGLE_ENDPOINT = /\/api\/shares(?:\?|$)/;

const manifest = {
  schemaVersion: 1 as const,
  origin: "sql-editor" as const,
  sql: "SELECT channel, SUM(amount) FROM sales GROUP BY 1",
  datasource: "duck",
  executedAt: "2026-11-15T09:30:00.000Z",
  rowCount: 3,
  columnCount: 2,
  checksum: { algorithm: "schema-v1" as const, rowCount: 3, columnCount: 2, schemaHash: "aa11", sqlHash: "bb22" },
  sessionId: "s1",
};

/** 远端（源实例）当前画布：覆盖五类节点，用于验证与主画布同渲染。 */
function remotePayload(etag = "e1", nodes?: unknown[]): LiveSharePayload {
  const five = [
    {
      id: "gov-1",
      type: "sourceTable",
      position: { x: 0, y: 0 },
      data: {
        type: "sourceTable",
        title: "REMOTE_TABLE_orders",
        createdAt: "2026-11-15T09:00:00.000Z",
        // SourceTableNode 头部渲染的是 tableName（不是 title），故用同一个可辨识值
        tableName: "REMOTE_TABLE_orders",
        database: "sales",
        rowCount: 1200,
        qualifiedName: "sales.main.REMOTE_TABLE_orders",
        fields: [
          { name: "id", type: "BIGINT", nullable: false, isPrimaryKey: true },
          { name: "channel_id", type: "BIGINT", nullable: true, isForeignKey: true, references: { table: "channels", field: "id" } },
        ],
      },
    },
    {
      id: "gov-2",
      type: "sqlQuery",
      position: { x: 300, y: 0 },
      data: {
        type: "sqlQuery",
        title: "REMOTE_SQL_汇总",
        createdAt: "2026-11-15T09:10:00.000Z",
        sql: "SELECT channel, SUM(amount) FROM sales GROUP BY 1",
        outputColumns: ["channel", "sum_amount"],
        manifest,
      },
    },
    {
      id: "gov-3",
      type: "dataFrame",
      position: { x: 600, y: 0 },
      data: {
        type: "dataFrame",
        title: "DF: REMOTE_DF_sales",
        createdAt: "2026-11-15T09:20:00.000Z",
        // DataFrameNode 头部渲染的是 dfName
        dfName: "REMOTE_DF_sales",
        sourceName: "duck",
        totalRows: 3,
        totalColumns: 2,
        memoryUsage: "1 KB",
        columns: [
          { name: "channel", nonNull: 3, dtype: "object" },
          { name: "sum_amount", nonNull: 3, dtype: "float64" },
        ],
        previewData: [],
        manifest,
      },
    },
    {
      id: "gov-4",
      type: "report",
      position: { x: 900, y: 0 },
      data: {
        type: "report",
        title: "REMOTE_REPORT_差异",
        createdAt: "2026-11-15T09:25:00.000Z",
        reportType: "diff",
        sourceRefs: [{ label: "REMOTE_DF_sales" }],
        content: "## 结论\n两次取数一致",
      },
    },
    {
      id: "gov-5",
      type: "chart",
      position: { x: 1200, y: 0 },
      data: {
        type: "chart",
        title: "REMOTE_CHART_销售额趋势",
        createdAt: "2026-11-15T09:30:00.000Z",
        sourceDf: "REMOTE_DF_sales",
        config: {
          type: "bar",
          data: [{ type: "bar", x: ["线上", "线下"], y: [10, 20] }],
          layout: { title: "销售额" },
        },
      },
    },
  ];
  return {
    readonly: true,
    version: 1,
    etag,
    token: TOKEN,
    canvasId: "2026-11-15T09-00-00-000Z_sess-remote",
    sessionName: "2026-11-15T09-00-00-000Z_sess-remote",
    updatedAt: "2026-11-15T09:30:00.000Z",
    canvas: {
      nodes: (nodes ?? five) as unknown[],
      edges: [{ id: "e1", source: "gov-2", target: "gov-3", data: { lineageKind: "data" } }],
    },
    manifests: [
      { nodeId: "gov-2", nodeTitle: "REMOTE_SQL_汇总", nodeType: "sqlQuery", manifest },
      { nodeId: "gov-3", nodeTitle: "REMOTE_DF_sales", nodeType: "dataFrame", manifest },
    ],
  };
}

type FetchCall = { url: string; method: string; headers: Record<string, string> };

let calls: FetchCall[] = [];
let responder: (call: FetchCall) => Promise<Response> | Response;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeAll(() => {
  // ReactFlow 需要 ResizeObserver（jsdom 没有）；替身不回调，节点尺寸变更不会写 store
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const call: FetchCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;

  // 预热：先渲染一次让 ShareView 中和 persist，之后测试里的 setState 才不会写进 localStorage
  // （真实场景同序：/share 分支的任何 set() 都发生在 ShareView 首次渲染之后）。
  responder = () => new Promise<Response>(() => {});
  const warm = render(<ShareView token={TOKEN} />);
  warm.unmount();
});

beforeEach(() => {
  calls = [];
  plotlyStub.react.mockClear();
  // 每个用例都从「store 里是本机画布」这个真实起点开始（陷阱 2 的前提）
  useCanvasStore.setState({ nodes: [LOCAL.localNode], edges: [], referencedNodes: [], previewPanels: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("陷阱 1：persist 中和——远端画布不得写进本机 localStorage", () => {
  it("全流程（加载 + 渲染 + 点击 + 轮询）后 govio-canvas-state 字节未被改写", async () => {
    expect(isCanvasPersistenceNeutralized()).toBe(true);
    const seeded = localStorage.getItem(LOCAL.key);
    expect(seeded).toBe(LOCAL.value);

    responder = () => jsonResponse(200, remotePayload());
    render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_CHART_销售额趋势");

    // 远端画布已在 store 里（渲染出来了），但 localStorage 必须还是本机那份
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toContain("gov-5");
    expect(localStorage.getItem(LOCAL.key)).toBe(LOCAL.value);

    // 再点几个只读页上存在的按钮，确认没有别的路径写回
    fireEvent.click(screen.getByText("复制链接"));
    expect(localStorage.getItem(LOCAL.key)).toBe(LOCAL.value);
  });
});

describe("陷阱 2：远端数据到达前不闪现本机画布", () => {
  it("请求未回来时只有 loading 态；本机 localStorage 里的节点标题从不出现", async () => {
    let release: (r: Response) => void = () => {};
    responder = () => new Promise<Response>((resolve) => { release = resolve; });

    render(<ShareView token={TOKEN} />);
    expect(screen.getByText("加载分享画布…")).toBeTruthy();
    expect(screen.queryByText(LOCAL.title)).toBeNull();
    expect(document.body.textContent).not.toContain(LOCAL.title);

    release(jsonResponse(200, remotePayload()));
    await screen.findByText("REMOTE_TABLE_orders");
    expect(screen.queryByText(LOCAL.title)).toBeNull(); // 到达后整体替换，本机节点被顶掉
    expect(useCanvasStore.getState().nodes.some((n) => n.id === "local-1")).toBe(false);
  });

  it("请求失败（首拉）→ 显示「与源画布同步中断」而不是本机画布", async () => {
    responder = () => jsonResponse(500, { error: "boom" });
    render(<ShareView token={TOKEN} />);
    await waitFor(() => expect(screen.getByText(/与源画布同步中断/)).toBeTruthy());
    expect(screen.queryByText(LOCAL.title)).toBeNull();
  });

  it("token 失效（404）→ 明确的失效文案，且不渲染任何画布", async () => {
    responder = () => jsonResponse(404, { error: "share-not-found" });
    render(<ShareView token={TOKEN} />);
    await screen.findByText("分享链接已失效");
    expect(screen.queryByText(LOCAL.title)).toBeNull();
    expect(document.body.textContent).toContain("旧版快照链接一律失效");
  });
});

describe("高保真渲染：复用主画布五类节点组件", () => {
  it("五类节点全部渲染出主画布组件的内容（表结构字段 / 输出列 / 报告正文 / 口径留痕）", async () => {
    responder = () => jsonResponse(200, remotePayload());
    render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_TABLE_orders");

    const body = () => document.body.textContent ?? "";
    // sourceTable：表名、表结构字段名与全限定名（简化卡片时代完全没有这些）
    expect(screen.getByText("REMOTE_TABLE_orders")).toBeTruthy();
    expect(body()).toContain("channel_id");
    expect(body()).toContain("sales.main.REMOTE_TABLE_orders");
    // sqlQuery：标题（节点卡片 + 右栏 Manifest 各一份）、SQL 全文（X21 高亮 span）、输出列
    expect(screen.getAllByText("REMOTE_SQL_汇总")).toHaveLength(2);
    expect(document.querySelectorAll("[data-sqltok]").length).toBeGreaterThan(0);
    expect(body()).toContain("sum_amount");
    // dataFrame：df 名 + entries/columns 摘要 + 列结构表
    expect(body()).toContain("REMOTE_DF_sales");
    expect(body()).toContain("3 entries");
    expect(body()).toContain("2 columns");
    expect(body()).toContain("float64");
    // report：正文 markdown 渲染
    expect(screen.getByText("REMOTE_REPORT_差异")).toBeTruthy();
    expect(body()).toContain("两次取数一致");
    // chart：标题 + 来源 df + 图表类型
    expect(screen.getByText("REMOTE_CHART_销售额趋势")).toBeTruthy();
    expect(body()).toContain("bar");
    // 右栏 Manifest 留痕
    expect(document.body.textContent).toContain("分析留痕（Manifest · 2）");
  });

  it("chart 节点真渲染出 Plotly：懒加载模块被调用且收到节点的 config", async () => {
    responder = () => jsonResponse(200, remotePayload());
    render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_CHART_销售额趋势");
    await waitFor(() => expect(plotlyStub.react).toHaveBeenCalled());

    const args = plotlyStub.react.mock.calls[0];
    expect(args[1]).toEqual([{ type: "bar", x: ["线上", "线下"], y: [10, 20] }]);
    expect(args[2]).toEqual({ title: "销售额" });
    // 图表容器（ChartNode 的 plotRef div）在 DOM 里，且没有降级成「图表配置错误」
    expect(args[0]).toBeInstanceOf(HTMLElement);
    expect(screen.queryByText("图表配置错误")).toBeNull();
  });

  it("nodeTypes 就是主画布那份注册表；ShareView 不再自带简化卡片", () => {
    const source = readFileSync("src/components/Share/ShareView.tsx", "utf-8");
    expect(Object.keys(nodeTypes).sort()).toEqual(["chart", "dataFrame", "report", "sourceTable", "sqlQuery"]);
    expect(source).toContain("import { nodeTypes } from '../Nodes'");
    expect(source).not.toContain("ShareNodeCard");
    expect(source).not.toContain("shareCard");
    // 陷阱 4：API 基址统一走 X25 模块，不再有自带的「页面端口 +1」硬编码
    expect(source).toContain("apiBaseFrom(window.location.origin)");
    expect(source).not.toMatch(/parseInt\(window\.location\.port/);
    expect(source).not.toContain("fetch(`/api/shares/");
  });
});

describe("陷阱 3：只读纪律——没有任何写回源 session 的路径", () => {
  it("五类节点卡片上的副作用入口（引用/删除/预览/复跑/编辑）一律不渲染", async () => {
    responder = () => jsonResponse(200, remotePayload());
    render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_TABLE_orders");

    const labels = ["引用", "删除", "预览", "复跑", "编辑"];
    const texts = Array.from(document.querySelectorAll(".react-flow__node button"))
      .map((b) => b.textContent ?? "")
      .join("|");
    for (const label of labels) expect(texts).not.toContain(label);
    // 只读页整体也不提供复跑（后端路由已删）
    expect(document.body.textContent).not.toContain("复跑中");
    expect(document.body.textContent).toContain("只读页不提供复跑");
    // 纯展示入口保留：SQL/DF 节点的「详情」（Manifest）与 chart 的「放大」
    expect(texts).toContain("详情");
    expect(texts).toContain("放大");
  });

  it("点遍画布内所有按钮：只发出 GET /api/shares/<token>，不触达任何 mutating 端点", async () => {
    responder = (call) => {
      if (call.url.includes(`/api/shares/${TOKEN}`) && call.method === "GET") return jsonResponse(200, remotePayload());
      return jsonResponse(500, { error: `unexpected ${call.method} ${call.url}` });
    };
    render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_TABLE_orders");
    calls = []; // 只统计用户交互产生的请求

    const buttons = Array.from(document.querySelectorAll(".react-flow__node button"));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) await act(async () => { fireEvent.click(button); });

    // 只读页上剩下的按钮全是纯本地展示态（展开字段/口径/Manifest、图表放大），
    // 所以正确的期望是「一个请求都不发」；下面的逐条断言再把这条规则钉死。
    expect(calls).toEqual([]);
    for (const call of calls) {
      for (const re of MUTATING_ENDPOINTS) expect(call.url).not.toMatch(re);
      expect(call.url).not.toMatch(SHARE_TOGGLE_ENDPOINT);
      expect(call.method).toBe("GET");
      expect(call.url).toBe(SHARE_URL);
    }
    // store 也没被写坏：节点仍是远端那 5 个（引用/删除都没生效）
    expect(useCanvasStore.getState().nodes.map((n) => n.id).sort()).toEqual(["gov-1", "gov-2", "gov-3", "gov-4", "gov-5"]);
    expect(useCanvasStore.getState().referencedNodes).toEqual([]);
  });

  it("只读页不建 /ws 连接（连接层只读，继承 T3.2）", () => {
    const main = readFileSync("src/main.tsx", "utf-8");
    expect(main).toContain("shareMatch ? (");
    expect(main).toMatch(/\/\^\\\/share\\\/\(\[a-f0-9\]\{32\}\)/);
    const source = readFileSync("src/components/Share/ShareView.tsx", "utf-8");
    expect(source).not.toContain("WebSocket");
    expect(source).not.toContain("canvas-service");
    expect(source).not.toContain("useChat");
  });
});

describe("轮询：304 不重渲染 + ETag 协商", () => {
  it("第二次轮询带 If-None-Match；命中 304 时不再 hydrate（渲染触发源未被调用）", async () => {
    vi.useFakeTimers();
    let etag = "e1";
    responder = (call) => {
      if (call.headers["If-None-Match"] === `"${etag}"`) return new Response(null, { status: 304 });
      return jsonResponse(200, remotePayload(etag));
    };
    // 首次渲染前把 hydrateSession 换成 spy：它是 onPayload 唯一的渲染触发源
    const hydrateSpy = vi.fn(useCanvasStore.getState().hydrateSession);
    useCanvasStore.setState({ hydrateSession: hydrateSpy });

    render(<ShareView token={TOKEN} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["If-None-Match"]).toBeUndefined(); // 首拉无条件取全量

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // 3s 后轮询
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["If-None-Match"]).toBe('"e1"');
    expect(hydrateSpy).toHaveBeenCalledTimes(1); // 304 → 不重渲染

    // 源画布变了：etag 换掉 → 200 + 新内容，hydrate 再次被调用（活视图确实会更新）
    etag = "e2";
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(calls).toHaveLength(3);
    expect(calls[2].headers["If-None-Match"]).toBe('"e1"');
    expect(hydrateSpy).toHaveBeenCalledTimes(2);
    expect(useCanvasStore.getState().nodes).toHaveLength(5);
  });

  it("组件卸载即停止轮询（定时器被清理，不再发请求）", async () => {
    vi.useFakeTimers();
    responder = () => jsonResponse(200, remotePayload());
    const view = render(<ShareView token={TOKEN} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toHaveLength(1);

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(calls).toHaveLength(1);
  });
});

describe("只读视图的 ReactFlow 交互被关死", () => {
  it("节点不可拖拽/不可连线/不可选中（ReactFlow 按 props 落地到 DOM class）", async () => {
    responder = () => jsonResponse(200, remotePayload());
    const { container } = render(<ShareView token={TOKEN} />);
    await screen.findByText("REMOTE_TABLE_orders");
    const nodes = Array.from(container.querySelectorAll(".react-flow__node"));
    expect(nodes.length).toBe(5);
    for (const node of nodes) {
      expect(node.className).not.toContain("selectable");
      expect(node.className).not.toContain("draggable");
    }
  });
});
