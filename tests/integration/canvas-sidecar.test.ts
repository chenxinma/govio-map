/**
 * X4 链路④集成测试：canvas sidecar（.canvas.json）持久化往返 —— save/load 无丢失。
 *
 * 驱动方式：真实 `server/session-history.ts` 的 saveCanvas/loadCanvas/canvasPathFor，
 * tmp 目录一次性会话文件，不触碰真实会话。
 *
 * 覆盖：
 *  - save → load 往返：节点/边/manifest/列结构 深度相等
 *  - 含中文 / 引号 / 换行的 SQL 与标题往返无损
 *  - store → saveCanvas → loadCanvas → hydrateSession 全链路（模拟 canvas_save + canvas_restore）
 *  - 失败/边界：文件不存在返回 null；损坏 JSON 返回 null；形状不合法（nodes 非数组）返回 null
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasPathFor, saveCanvas, loadCanvas } from "../../server/session-history.js";

const tmpDirs: string[] = [];

function tmpSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "govio-x4-sidecar-"));
  tmpDirs.push(dir);
  return join(dir, "2026-11-05T00-00-00-000Z_sess-x4.jsonl");
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SQL = `SELECT o.order_id, o.amount, c."备注"
FROM orders o
JOIN cust c ON c.id = o.cid
WHERE o.amount > 100 AND c.name = '张"三'`;

function sampleNodes(): unknown[] {
  return [
    {
      id: "gov-1",
      type: "sqlQuery",
      position: { x: 100, y: 100 },
      sourcePosition: "right",
      targetPosition: "left",
      data: {
        type: "sqlQuery",
        title: "Q: 订单/客户 '双引号' 汇总",
        createdAt: "2026-11-05T00:00:00.000Z",
        sql: SQL,
        outputColumns: ["order_id", "amount", "备注"],
        manifest: {
          schemaVersion: 1,
          origin: "assistant-sql",
          sql: SQL,
          datasource: "",
          executedAt: "2026-11-05T00:00:00.000Z",
          checksum: { algorithm: "schema-v1", schemaHash: "abcdef0123456789", sqlHash: "0123456789abcdef" },
        },
      },
    },
    {
      id: "gov-2",
      type: "dataFrame",
      position: { x: 500, y: 100 },
      data: {
        type: "dataFrame",
        title: "DF: df_orders",
        dfName: "df_orders",
        sourceName: "sales",
        totalRows: 1200,
        totalColumns: 3,
        memoryUsage: "28.1 KB",
        columns: [
          { name: "order_id", dtype: "BIGINT", nonNull: 1200 },
          { name: "amount", dtype: "DOUBLE", nonNull: 1200 },
          { name: "备注", dtype: "VARCHAR", nonNull: 1200 },
        ],
        previewData: [],
      },
    },
  ];
}

function sampleEdges(): unknown[] {
  return [
    {
      id: "e-gov-1-gov-2",
      source: "gov-1",
      target: "gov-2",
      type: "smoothstep",
      animated: true,
      style: { stroke: "#1db954", strokeWidth: 2 },
    },
  ];
}

describe("canvas sidecar 持久化往返", () => {
  it("save → load 往返：节点/边/manifest/列结构深度相等", () => {
    const sessionFile = tmpSession();
    const nodes = sampleNodes();
    const edges = sampleEdges();
    saveCanvas(sessionFile, nodes, edges);

    expect(existsSync(canvasPathFor(sessionFile))).toBe(true);
    const loaded = loadCanvas(sessionFile);
    expect(loaded).not.toBeNull();
    expect(JSON.stringify(loaded!.nodes)).toBe(JSON.stringify(nodes));
    expect(JSON.stringify(loaded!.edges)).toBe(JSON.stringify(edges));
  });

  it("中文/引号/换行 SQL 往返无损", () => {
    const sessionFile = tmpSession();
    saveCanvas(sessionFile, sampleNodes(), []);
    const loaded = loadCanvas(sessionFile);
    const data = (loaded!.nodes[0] as { data: { sql: string; title: string } }).data;
    expect(data.sql).toBe(SQL);
    expect(data.sql).toContain('\n');
    expect(data.title).toContain("双引号");
  });

  it("sidecar 路径 = <session-file>.canvas.json", () => {
    const sessionFile = tmpSession();
    expect(canvasPathFor(sessionFile)).toBe(`${sessionFile}.canvas.json`);
  });

  it("store → saveCanvas → loadCanvas → hydrateSession 全链路往返（模拟 canvas_save/canvas_restore）", async () => {
    vi2stubLocalStorage();
    const { useCanvasStore } = await import("../../src/store/canvas-store.js");
    const st = useCanvasStore.getState();
    st.clearCanvas();
    st.createGovioNode({
      type: "govio_node_create",
      nodeType: "sqlQuery",
      title: "Q: 汇总",
      sql: SQL,
      outputColumns: ["order_id"],
    } as never);
    st.createGovioNode({
      type: "govio_node_create",
      nodeType: "dataFrame",
      title: "DF: df_orders",
      dfName: "df_orders",
      totalRows: 1200,
      totalColumns: 1,
    } as never);
    const saved = useCanvasStore.getState();

    const sessionFile = tmpSession();
    saveCanvas(sessionFile, saved.nodes, saved.edges);
    const loaded = loadCanvas(sessionFile);
    expect(loaded).not.toBeNull();

    // 模拟会话重开：清空画布后按 canvas_restore 恢复
    useCanvasStore.getState().clearCanvas();
    useCanvasStore.getState().hydrateSession(loaded!.nodes as never, loaded!.edges as never);
    const restored = useCanvasStore.getState();
    expect(restored.nodes).toHaveLength(2);
    expect(JSON.stringify(restored.nodes)).toBe(JSON.stringify(saved.nodes));
    expect((restored.nodes[0].data as unknown as { sql: string }).sql).toBe(SQL);
  });

  it("失败/边界：文件不存在返回 null", () => {
    const sessionFile = tmpSession();
    expect(loadCanvas(sessionFile)).toBeNull();
  });

  it("失败/边界：损坏 JSON 返回 null", () => {
    const sessionFile = tmpSession();
    writeFileSync(canvasPathFor(sessionFile), "{not json!!");
    expect(loadCanvas(sessionFile)).toBeNull();
  });

  it("失败/边界：形状不合法（nodes 非数组）返回 null", () => {
    const sessionFile = tmpSession();
    writeFileSync(canvasPathFor(sessionFile), JSON.stringify({ nodes: {}, edges: [] }));
    expect(loadCanvas(sessionFile)).toBeNull();

    writeFileSync(canvasPathFor(sessionFile), JSON.stringify({ nodes: [], edges: "oops" }));
    expect(loadCanvas(sessionFile)).toBeNull();
  });
});

// canvas-store persist 读 window.localStorage；node 环境按需注入内存 stub
function vi2stubLocalStorage(): void {
  const g = globalThis as { localStorage?: unknown };
  if (!g.localStorage) {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  }
}
