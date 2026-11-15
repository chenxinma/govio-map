/**
 * 分享链接与 API 基址的构造（X25 BUGFIX：src/utils/share-link.ts）。
 *
 * 回归来源（2026-11-15 用户实测）：点「生成只读分享链接」复制到的是
 * `http://localhost:5174/share/<token>`（**后端端口**）→ `404 {"error":"Not found"}`；
 * 同一 token 在前端端口 `http://localhost:5173/share/<token>` → 200。
 * 根因：ChatPanel 用「页面端口 +1」的 API 基址拼了前端路由链接，
 * 而后端只提供 /api/*、/ws、/canvas，不托管 SPA。
 * 详见 docs/tasks/BUGFIX-share-link-port.md。
 */
import { describe, expect, it } from "vitest";
import { apiBaseFrom, shareLink } from "../../src/utils/share-link.js";

/** main.tsx 的分享路由正则——链接路径必须能被它匹配，否则渲染的是主应用而不是 ShareView */
const SHARE_ROUTE = /^\/share\/([a-f0-9]{32})\/?$/;
const TOKEN = "6d6aa27396782536ecad2be1a3ac5597"; // 真实落盘过的 shareId 形状

describe("apiBaseFrom：后端 API 基址（页面端口 +1 约定）", () => {
  it("dev：5173 → 5174（与 useChat/canvas-service/ShareView 同约定）", () => {
    expect(apiBaseFrom("http://localhost:5173")).toBe("http://localhost:5174");
  });

  it("https 与自定义端口同样 +1", () => {
    expect(apiBaseFrom("https://dev.example.com:8080")).toBe("https://dev.example.com:8081");
  });

  it("生产同源托管（origin 无端口）→ null，调用方退回同源相对路径而不是猜一个端口", () => {
    expect(apiBaseFrom("https://govio.example.com")).toBeNull();
    expect(apiBaseFrom("http://127.0.0.1")).toBeNull();
  });

  it("退化输入：空串 / 非字符串 / 不可解析 → null（不抛错）", () => {
    expect(apiBaseFrom("")).toBeNull();
    expect(apiBaseFrom("   ")).toBeNull();
    expect(apiBaseFrom("not a url")).toBeNull();
    expect(apiBaseFrom(undefined as unknown as string)).toBeNull();
  });
});

describe("shareLink：分享链接必须用页面 origin（X25 回归主案例）", () => {
  it("dev：链接落在前端端口 5173，不是后端 5174", () => {
    const link = shareLink(`/share/${TOKEN}`, "http://localhost:5173");
    expect(link).toBe(`http://localhost:5173/share/${TOKEN}`);
    // 反向断言：锁死「不得用 API 基址拼链接」这个 bug
    expect(link).not.toContain(":5174");
    expect(link).not.toBe(`${apiBaseFrom("http://localhost:5173")}/share/${TOKEN}`);
  });

  it("链接路径能被 main.tsx 的分享路由匹配（否则渲染主应用而非 ShareView）", () => {
    const link = shareLink(`/share/${TOKEN}`, "http://localhost:5173");
    expect(SHARE_ROUTE.exec(new URL(link).pathname)?.[1]).toBe(TOKEN);
  });

  it("生产单端口同源托管：链接与页面同 origin，不做任何端口运算", () => {
    expect(shareLink(`/share/${TOKEN}`, "https://govio.example.com")).toBe(
      `https://govio.example.com/share/${TOKEN}`,
    );
  });

  it("归一化：origin 尾斜杠被吃掉、path 缺前导斜杠会补上", () => {
    expect(shareLink(`/share/${TOKEN}`, "http://localhost:5173/")).toBe(`http://localhost:5173/share/${TOKEN}`);
    expect(shareLink(`share/${TOKEN}`, "http://localhost:5173///")).toBe(`http://localhost:5173/share/${TOKEN}`);
  });

  it("origin 缺失/不可解析 → 退回相对路径（同源点开仍可用），绝不猜端口", () => {
    expect(shareLink(`/share/${TOKEN}`, "")).toBe(`/share/${TOKEN}`);
    expect(shareLink(`/share/${TOKEN}`, "not a url")).toBe(`/share/${TOKEN}`);
    expect(shareLink(`/share/${TOKEN}`, undefined as unknown as string)).toBe(`/share/${TOKEN}`);
  });

  it("退化输入：空/空白/非字符串 path → 空串（不产出 `origin/` 这种半截链接）", () => {
    expect(shareLink("", "http://localhost:5173")).toBe("");
    expect(shareLink("   ", "http://localhost:5173")).toBe("");
    expect(shareLink(undefined as unknown as string, "http://localhost:5173")).toBe("");
  });

  it("query/hash 原样保留（fork 回跳等场景可能带参数）", () => {
    expect(shareLink(`/share/${TOKEN}?from=chat`, "http://localhost:5173")).toBe(
      `http://localhost:5173/share/${TOKEN}?from=chat`,
    );
  });
});
