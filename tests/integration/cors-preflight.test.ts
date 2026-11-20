/**
 * X26：CORS 预检的**单一来源**。
 *
 * 修复前：预检由 `parquet-api.ts` 的首位 `OPTIONS` 分支兑现——它在任何路径判断之前，所以替
 * **整个服务器**应答了所有预检。后果是 T3.5「撤销分享」（`DELETE /api/shares`）与 T3.7「导入」
 * （`POST /api/session-import` + `application/json`）这两个必须预检的路由，其可用性取决于一个
 * 无关模块的全局分支与 `backend.ts` 的挂载顺序；`bundle-api.ts` 自带的 `OPTIONS` 分支因此在真实
 * 服务器上不可达（死代码），而它的隔离测试照样绿 ⇒ 虚假安全感。
 *
 * 修复后：预检由 `backend.ts` 的 `handleBackendRequest` 在所有 `handle*Api` **之前**统一应答
 * （`security.ts` 的 `respondToCorsPreflight`），且只认 `/api/*`。
 *
 * 本文件的断言分三层，合起来把「与挂载顺序无关」钉死：
 *  1. 纯函数层：`isCorsPreflight` 的真值表 + `respondToCorsPreflight` 的状态码与 CORS 头；
 *  2. 真实链路层：`handleBackendRequest`（生产用的同一个函数）对七个会触发预检的端点全回 204；
 *     同时证明**任何 handler 单独都不再兑现预检**——去掉 backend 的预检步骤后，无论 handler
 *     怎么排都拿不到 204；
 *  3. 真 HTTP 层：`createServer(handleBackendRequest)` 打 `127.0.0.1` + 端口 0，用真 `fetch`
 *     验证浏览器实际看到的预检响应（跨平台，不依赖任何 Windows 特有行为）。
 *
 * 三个 `handle*Api` 全部是**真实实现**；只 mock 掉与本测试无关的进程引导依赖（agent 单例、WS）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// backend.ts 的进程引导依赖（pi agent 单例、WebSocket 挂载）与预检无关，mock 掉以免拉入
// pi 运行时；三个 API handler 与 security.ts 保持真实。
vi.mock("../../server/agent.js", () => ({
  agentSetup: vi.fn(),
  getSession: () => null,
  runGovioCli: vi.fn(),
  getLoadedSkills: () => [],
}));
vi.mock("../../server/ws-handler.js", () => ({ setupWebSocket: vi.fn() }));

import { handleBackendRequest } from "../../server/backend.js";
import { handleParquetApi } from "../../server/parquet-api.js";
import { handleShareApi } from "../../server/share-api.js";
import { handleBundleApi } from "../../server/bundle-api.js";
import { isCorsPreflight, respondToCorsPreflight } from "../../server/security.js";

const ALLOWED_ORIGIN = "http://localhost:5173";

/** 会触发跨源预检的端点全集：非安全方法（DELETE/POST+JSON）或带自定义请求头（If-None-Match）。 */
const PREFLIGHTED_ENDPOINTS = [
  "/api/shares", // T3.5 DELETE（撤销分享）
  "/api/share-state", // T3.5 GET（安全方法，但同一份白名单必须覆盖）
  "/api/session-import", // T3.7 POST + application/json
  "/api/session-bundle", // T3.6 GET
  "/api/preview", // 预览 POST 侧同源，GET 走 parquet
  "/api/rerun-dataframe", // T1.2 复跑 POST
  "/api/execute-sql", // SQL 执行 POST
];

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (code: number, headers?: Record<string, unknown>) => void;
  end: (body?: string) => void;
}

function fakeRes(): FakeRes {
  const res = { statusCode: 0, headers: {}, body: "" } as FakeRes;
  res.writeHead = (code: number, h?: Record<string, unknown>) => {
    res.statusCode = code;
    Object.assign(res.headers, h ?? {});
  };
  res.end = (b?: string) => {
    if (b) res.body += b;
  };
  return res;
}

function fakeReq(method: string, url: string, headers: Record<string, string> = {}) {
  return { method, url, headers } as unknown as IncomingMessage;
}

/** 走生产用的同一条链路（backend.ts 的 handleBackendRequest）。 */
async function callChain(method: string, url: string, headers: Record<string, string> = {}) {
  const res = fakeRes();
  await handleBackendRequest(fakeReq(method, url, headers), res as unknown as ServerResponse);
  return res;
}

/** 只调单个 handler，用于证明「预检不再由任何模块自己兑现」。 */
async function callHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  method: string,
  url: string,
  headers: Record<string, string> = {},
) {
  const res = fakeRes();
  const handled = await handler(fakeReq(method, url, headers), res as unknown as ServerResponse);
  return { handled, res };
}

describe("isCorsPreflight：只认 /api/* 的 OPTIONS", () => {
  it("OPTIONS + /api/* → true（含 /api 本身与带 query 的路径）", () => {
    for (const url of ["/api/shares", "/api/session-import", "/api", "/api/preview?df=x&rows=10"]) {
      expect(isCorsPreflight({ method: "OPTIONS", url }), `${url} 应是预检`).toBe(true);
    }
  });

  it("非 OPTIONS 方法 → false（GET/POST/DELETE 都不是预检）", () => {
    for (const method of ["GET", "POST", "DELETE", "PUT", "HEAD"]) {
      expect(isCorsPreflight({ method, url: "/api/shares" }), `${method} 不是预检`).toBe(false);
    }
  });

  it("OPTIONS 但非 /api/* → false（/ws、/canvas 是 WS 升级，其余路径没有跨源消费者）", () => {
    for (const url of ["/ws", "/canvas", "/", "/nonexistent", "/share/0123456789abcdef0123456789abcdef", "/apix/shares"]) {
      expect(isCorsPreflight({ method: "OPTIONS", url }), `${url} 不应被当成 API 预检`).toBe(false);
    }
  });

  it("url 缺失或畸形 → false，且不抛异常", () => {
    expect(isCorsPreflight({ method: "OPTIONS" })).toBe(false);
    expect(isCorsPreflight({ method: "OPTIONS", url: "" })).toBe(false);
    expect(isCorsPreflight({})).toBe(false);
    expect(isCorsPreflight({ method: "OPTIONS", url: "//api/shares" })).toBe(false);
  });
});

describe("respondToCorsPreflight：204 + 与真实响应同一份 CORS 头", () => {
  it("白名单 Origin → 204，ACAO 回显，方法/请求头白名单与 Expose-Headers 齐备", () => {
    const res = fakeRes();
    const handled = respondToCorsPreflight(
      fakeReq("OPTIONS", "/api/shares", { origin: ALLOWED_ORIGIN }),
      res as unknown as ServerResponse,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe(""); // 预检不带 body
    expect(res.headers["Access-Control-Allow-Origin"]).toBe(ALLOWED_ORIGIN);
    expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, DELETE, OPTIONS");
    expect(res.headers["Access-Control-Allow-Headers"]).toBe("Content-Type, If-None-Match");
    expect(res.headers["Access-Control-Expose-Headers"]).toBe("ETag");
    expect(res.headers["Vary"]).toBe("Origin");
  });

  it("非白名单 Origin → 仍 204 但不回显 ACAO（反向断言：CORS 面没有因本修复扩大）", () => {
    const res = fakeRes();
    expect(respondToCorsPreflight(fakeReq("OPTIONS", "/api/shares", { origin: "https://evil.example.com" }), res as unknown as ServerResponse)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers["Vary"]).toBe("Origin");
  });

  it("无 Origin（curl / 本机非浏览器客户端）→ 204 且无 ACAO", () => {
    const res = fakeRes();
    expect(respondToCorsPreflight(fakeReq("OPTIONS", "/api/session-import"), res as unknown as ServerResponse)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("127.0.0.1 与 [::1] 的任意端口也在白名单内（沿用 security.ts 既有规则）", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://[::1]:5173", "https://localhost:8443"]) {
      const res = fakeRes();
      respondToCorsPreflight(fakeReq("OPTIONS", "/api/shares", { origin }), res as unknown as ServerResponse);
      expect(res.headers["Access-Control-Allow-Origin"], `${origin} 应被回显`).toBe(origin);
    }
  });

  it("非预检请求 → 返回 false 且不写任何响应（不干扰后续路由）", () => {
    const res = fakeRes();
    expect(respondToCorsPreflight(fakeReq("GET", "/api/shares", { origin: ALLOWED_ORIGIN }), res as unknown as ServerResponse)).toBe(false);
    expect(respondToCorsPreflight(fakeReq("OPTIONS", "/ws", { origin: ALLOWED_ORIGIN }), res as unknown as ServerResponse)).toBe(false);
    expect(res.statusCode).toBe(0);
    expect(res.headers).toEqual({});
  });
});

describe("真实请求链（backend.ts handleBackendRequest）：预检单一来源", () => {
  it("七个会触发预检的端点全部 204 且 CORS 头齐备", async () => {
    for (const url of PREFLIGHTED_ENDPOINTS) {
      const res = await callChain("OPTIONS", url, { origin: ALLOWED_ORIGIN });
      expect(res.statusCode, `OPTIONS ${url} 应 204`).toBe(204);
      expect(res.headers["Access-Control-Allow-Origin"], `${url} 应回显白名单 Origin`).toBe(ALLOWED_ORIGIN);
      expect(String(res.headers["Access-Control-Allow-Methods"]), `${url} 应放行 DELETE`).toContain("DELETE");
      expect(String(res.headers["Access-Control-Allow-Headers"]), `${url} 应放行 If-None-Match`).toContain("If-None-Match");
      expect(res.headers["Access-Control-Expose-Headers"], `${url} 应暴露 ETag`).toBe("ETag");
    }
  });

  it("任何 handler 单独都不再兑现预检（模块内 OPTIONS 分支已删）", async () => {
    // share-api：从来没有 OPTIONS 分支 ⇒ 不接管，交给链路兜底
    const share = await callHandler(handleShareApi, "OPTIONS", "/api/shares", { origin: ALLOWED_ORIGIN });
    expect(share.handled).toBe(false);
    expect(share.res.statusCode).toBe(0);

    // parquet-api：修复前它的首位分支会把**所有** OPTIONS 吞成 204，现在不再接管
    const parquet = await callHandler(handleParquetApi, "OPTIONS", "/api/sql-editor-init", { origin: ALLOWED_ORIGIN });
    expect(parquet.handled).toBe(false);
    expect(parquet.res.statusCode).toBe(0);

    // bundle-api：修复前自带的 OPTIONS 分支在真实服务器上不可达（死代码），现已删除 ⇒ 落到方法白名单 405
    const bundle = await callHandler(handleBundleApi, "OPTIONS", "/api/session-import", { origin: ALLOWED_ORIGIN });
    expect(bundle.handled).toBe(true);
    expect(bundle.res.statusCode).toBe(405);
  });

  it("顺序无关：204 只来自 backend 的预检步骤——把它拿掉后，无论 handler 怎么排都拿不到 204", async () => {
    // 反向组装（bundle → share → parquet，与生产顺序相反），且**不含**预检步骤
    const chainWithoutPreflight = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (await handleBundleApi(req, res)) return;
      if (await handleShareApi(req, res)) return;
      if (await handleParquetApi(req, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    };
    for (const url of ["/api/shares", "/api/session-import", "/api/preview"]) {
      const res = fakeRes();
      await chainWithoutPreflight(fakeReq("OPTIONS", url, { origin: ALLOWED_ORIGIN }), res as unknown as ServerResponse);
      expect(res.statusCode, `没有预检步骤时 OPTIONS ${url} 不该是 204`).not.toBe(204);
      // 同一条链、同一个顺序，加上 backend 的预检步骤后就是 204 ⇒ 204 与 handler 顺序无关
      expect((await callChain("OPTIONS", url, { origin: ALLOWED_ORIGIN })).statusCode).toBe(204);
    }
  });

  it("收窄到 /api/*：非 API 路径的 OPTIONS 不再被 204 掩盖，落到 404 兜底", async () => {
    for (const url of ["/ws", "/canvas", "/nonexistent", "/share/0123456789abcdef0123456789abcdef"]) {
      const res = await callChain("OPTIONS", url, { origin: ALLOWED_ORIGIN });
      expect(res.statusCode, `OPTIONS ${url} 应落到 404 兜底`).toBe(404);
      expect(res.body).toContain("Not found");
    }
  });

  it("链路兜底与非预检请求不受影响：未知路径 GET → 404 JSON", async () => {
    const res = await callChain("GET", "/api/definitely-not-a-route", { origin: ALLOWED_ORIGIN });
    expect(res.statusCode).toBe(404);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ error: "Not found" }));
  });
});

describe("真 HTTP server（127.0.0.1 + 端口 0）：浏览器实际看到的预检响应", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleBackendRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("OPTIONS /api/shares（撤销分享的预检）→ 204 + 放行 DELETE + 回显白名单 Origin", async () => {
    const res = await fetch(`${base}/api/shares`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(res.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(await res.text()).toBe("");
  });

  it("OPTIONS /api/session-import（导入的预检）→ 204 + 放行 POST 与 Content-Type", async () => {
    const res = await fetch(`${base}/api/session-import`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(204);
    expect(String(res.headers.get("access-control-allow-methods"))).toContain("POST");
    expect(String(res.headers.get("access-control-allow-headers"))).toContain("Content-Type");
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("非白名单 Origin → 204 但不回显 ACAO（真 HTTP 层反向断言）", async () => {
    const res = await fetch(`${base}/api/shares`, { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("非 /api/* 的 OPTIONS → 404（收窄后不再一律 204）", async () => {
    const res = await fetch(`${base}/ws`, { method: "OPTIONS", headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(404);
  });
});
