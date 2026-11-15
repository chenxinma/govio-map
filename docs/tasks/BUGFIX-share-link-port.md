# BUGFIX-share-link-port：分享链接指向后端端口 → 404 Not found

- **日期**：2026-11-15（X25）
- **报告人**：用户实测（T3.2 只读分享功能，PR #38 合并后首次真机使用）
- **现象**：点 ChatPanel 的「生成只读分享链接」（`Share2` 按钮）后，复制到剪贴板的链接打开是
  **404 Not found**，用户判断「分享功能不可用」并要求先禁用按钮。
- **结论**：分享功能**后端与路由都正常**，坏的只是**链接拼错了端口**——一行 bug，已修，无需禁用按钮
  （用户裁决 2026-11-15：选方案 A「直接修 + 回归断言，按钮保持可用」）。

## 取证（主会话实测，非推断）

用真 token `6d6aa27396782536ecad2be1a3ac5597`（用户 17:06 那次点击落盘的 `.govio/shares/*.json`）：

| 请求 | 结果 | 说明 |
|---|---|---|
| `GET http://localhost:5174/share/<token>` | **404** `{"error":"Not found"}` | ← 用户复制到的链接（后端端口） |
| `GET http://localhost:5173/share/<token>` | **200**（index.html，963B） | 前端端口，Vite SPA fallback 正常 |
| `GET http://localhost:5174/api/shares/<token>` | **200**（完整分享记录 JSON） | 后端 API 正常 |
| `GET http://localhost:5173/api/shares/<token>` | **200** | Vite `/api` 代理正常 |
| `GET http://localhost:5174/api/shares/<假 token>` | 404 `{"error":"share not found"}` | 未命中时的正确语义 |

磁盘侧：`.govio/shares/` 有两条记录（16:52、17:06，即用户两次点击），
顶层键 `version, shareId, canvasId, sessionName, createdAt, originBackend, canvas, manifests` 齐全
→ **POST 创建与持久化都成功**，只是链接打不开。

## 根因

`src/components/Chat/ChatPanel.tsx`（T3.2 引入）把「API 基址」当成了「页面基址」：

```js
const apiPort = parseInt(window.location.port, 10) + 1;                      // 5173 → 5174
const base = `${window.location.protocol}//${window.location.hostname}:${apiPort}`;
await fetch(`${base}/api/shares`, { method: "POST" });                        // ✅ 正确：API 在后端端口
await navigator.clipboard.writeText(`${base}${url}`);                         // ❌ 错误：链接也被拼到 5174
```

两个基址的职责不同：

- **API 基址**（页面端口 +1）：本仓既有约定，`useChat` / `canvas-service` / `canvas-store` / `ShareView`
  都这么调后端（dev 下 Vite 5173、后端 5174）。
- **分享链接** `/share/<token>`：是**前端路由**——`src/main.tsx` 按 `window.location.pathname` 匹配
  `/^\/share\/([a-f0-9]{32})\/?$/` 后渲染 `ShareView`，必须由**托管 SPA 的一侧**提供
  （dev = Vite 5173 的 history fallback；生产 = 单端口静态托管）。后端 5174 只挂
  `/api/*`、`/ws`、`/canvas`、`/api/preview`，**不托管 SPA**，故 404。

`ShareView` 自身没有这个问题：它的 fork 回跳用相对路径 `window.location.href = '/?fork=…'`（同源），
只有 `apiBase()` 用于调 API，职责分得是对的。

## 修复

1. **新增 `src/utils/share-link.ts`**（纯函数，node 环境可测，沿用 X18/X21 的「展示/构造逻辑下沉到 utils」范式）：
   - `shareLink(path, pageOrigin)`：分享链接**只接受页面 origin**；origin 带尾斜杠会归一、path 缺前导斜杠会补；
     origin 为空或不可解析 → 退回**相对路径**（同源点开仍可用），绝不猜端口、也不把垃圾 origin 拼进链接；
   - `apiBaseFrom(pageOrigin)`：保留「页面端口 +1」约定；**origin 无端口时返回 `null`**
     （生产单端口同源托管时 API 与页面同端口，此时应走同源相对路径而不是 +1）。
2. **`ChatPanel.tsx`**：两处复制（首次生成 + 再次复制）改用 `shareLink(url, window.location.origin)`；
   API 调用改用 `apiBaseFrom(origin) ?? ""`——dev 行为不变（仍打 5174），生产单端口自动退回同源相对路径
   （顺带修掉「生产环境 API 也会 +1 打空」的潜在问题）。
3. **回归断言**：`tests/integration/share-link.test.ts` 11 例，含
   - 主案例：dev origin 下链接为 `http://localhost:5173/share/<token>`，并**反向断言不含 `:5174`**、
     且不等于 `apiBaseFrom(origin) + path`（锁死这个 bug 不会回来）；
   - 契约一致性：链接 pathname 能被 `main.tsx` 的分享路由正则匹配（否则会渲染主应用而非 ShareView）；
   - 生产同源（无端口）：`apiBaseFrom` 返回 null、链接不做端口运算；
   - 归一化、退化输入（空/空白/非字符串 path、空/不可解析 origin）、query 保留。

## 验证

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/integration/share-link.test.ts` | **11 例通过** |
| `npm run build` / `lint` / `verify` | 退出 **0 / 0 / 0** |
| 断言数 | 脚本 **671 不变**；vitest **20 文件 278 例 → 21 文件 289 例**（+11）；UI 4 文件 37 例不变 |
| `verificationBaseline` | 已按 X23 约定同步更新（vitest 21·289），CI 看板不产漂移告警 |

## 影响面与遗留

1. **已生成的旧链接不会自愈**：用户剪贴板/聊天记录里的 `:5174/share/<token>` 仍然 404；
   重新点一次分享按钮即可拿到正确链接（分享记录本身没坏，`.govio/shares/` 里两条都可用）。
2. **全仓 `port + 1` 约定在生产单端口托管下都不成立**（`useChat`、`canvas-service`、`canvas-store`
   的 rerun/preview、`ShareView` 的 apiBase）。本次只修了分享链路（用户报的范围），
   其余留待「生产部署形态」相关任务（T3.4 Docker 服务化）一并处理——已记入 task-plan X25 遗留。
3. **分享链接无过期/撤销**（T3.2 既有遗留，非本 bug）：链接一旦给出即长期有效，
   禁用按钮并不能撤销已发出的链接；若要「先关掉」需服务端拒绝，属产品决策。
4. 本次未做 UI 层（jsdom 渲染 ChatPanel）断言：该组件依赖 `useChatContext` + WS，渲染成本高；
   按 X18 同款取舍，把可测逻辑下沉到 `src/utils/` 做纯函数断言。
