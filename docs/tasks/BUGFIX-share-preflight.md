# BUGFIX-share-preflight：CORS 预检靠无关模块的全局分支兑现（挂载顺序隐性依赖 + 死代码）

- **日期**：2026-11-17（X26）
- **报告人**：T3.7 worker 在交付物里报为「范围外真实缺陷」，**主会话实测更正为误诊**，随后按结构性问题立项修复（用户 2026-11-17 指示「安排 bugfix 执行」）
- **现象（worker 的原始报告）**：「dev 跨源下 T3.5 的撤销分享（`DELETE /api/shares`）会被 CORS 预检拦死，`ShareToggle` 的撤销按钮在 `http://localhost:5173` 上会失败」
- **结论**：**没有现行故障**——预检实际上是通的，但通的理由很脆：它由一个**无关模块**（`parquet-api.ts`）位于任何路径判断之前的全局 `OPTIONS` 分支兑现，因此取决于 `backend.ts` 的挂载顺序。同时 `bundle-api.ts` 自带的 `OPTIONS` 分支在真实服务器上**不可达**（死代码），而它的隔离测试照样绿 ⇒ 虚假安全感。已按「预检单一来源」修复。

## 取证

### 1. worker 的误诊从哪来（单 handler 隔离探测）

worker 直接调 `handleShareApi` 探预检，得到 `handled=false`：

```
handleShareApi OPTIONS /api/shares      → handled=false status=0
handleShareApi OPTIONS /api/share-state → handled=false status=0
```

据此推断「预检落到 backend.ts 的 404 兜底且不带 CORS 头 ⇒ 浏览器预检失败」。**这一步推断跳过了真实挂载顺序。**

### 2. 主会话实测：按 `backend.ts` 真实顺序起临时 server（2026-11-17）

`server/backend.ts` 的链路是 `handleParquetApi`(35 行) → `handleShareApi`(36) → `handleBundleApi`(38)，而
`parquet-api.ts:88` 的 `OPTIONS` 分支**在任何路径判断之前**，对所有预检一律回 `204 + corsHeadersFor(req)`：

```
OPTIONS /api/shares         → 204 allow-methods=GET, POST, DELETE, OPTIONS allow-origin=http://localhost:5173
OPTIONS /api/session-import → 204 allow-methods=GET, POST, DELETE, OPTIONS allow-origin=http://localhost:5173
```

⇒ 撤销分享（DELETE 必预检）与导入（POST + `application/json` 必预检）**都是通的**；T3.5 `verification.md §5.1`
记的「OPTIONS 预检 204」也成立（它按同一真实顺序挂载 handler）。worker 的报告已在其交付物里更正
（`docs/tasks/T3.7-import-session-bundle/design.md` 遗留 6、`verification.md §5.2`）。

### 3. 真正的问题（结构性）

| # | 问题 | 后果 |
|---|---|---|
| 1 | 预检的兑现点在 `parquet-api.ts` 首位分支，**位于任何路径判断之前** | 一个「parquet/预览/复跑」模块事实上替整个服务器管 CORS 预检；语义错位，读者无法从 `share-api.ts` / `bundle-api.ts` 看出自己的预检由谁应答 |
| 2 | 可用性依赖 `backend.ts` 的**挂载顺序** | 把 `handleParquetApi` 往后挪，或把它的 `OPTIONS` 合理收窄到 `/api/preview`，会**静默**破坏撤销分享与导入（两者都必预检），且没有任何断言会红 |
| 3 | `bundle-api.ts:163` 自带 `OPTIONS` 分支**不可达** | 死代码；其隔离测试（`session-import.test.ts` 的「跨源预检 OPTIONS → 204」）在真实服务器上验的是不存在的路径 ⇒ 虚假安全感 |
| 4 | `parquet-api.ts:299` 另有一个在 `/api/preview` 判断**之内**的 `OPTIONS` 分支 | 同样不可达（被 88 行提前吃掉），重复代码 |
| 5 | 全局分支对**任意路径**回 204（含 `/ws`、`/canvas`、不存在的路径） | 掩盖 404；`/ws`、`/canvas` 是 WebSocket 升级，浏览器根本不会为它们发预检 |

## 根因

预检没有单一来源：它被放在「碰巧第一个挂载、且分支位置在所有路径判断之前」的那个 API 模块里。
后续任务（T3.5 的 DELETE、T3.7 的 POST+JSON）各自需要预检时，一个模块补了自己的分支（不可达），
另一个模块根本没补（靠别人的分支兜住）——两种写法都能「测试通过」，因为测试都是**单 handler 隔离**驱动，
从不经过真实链路。

## 修法

**选 A：把预检上提到 `backend.ts`，成为单一来源**（B 方案「给 `share-api.ts` 也补一个 `OPTIONS` 分支、
各模块自管」被否：它把问题从 1 处不可达死代码变成 N 处重复代码，且「顺序无关」依旧无法保证——
只要有任何一个模块忘了补，那条路由就静默坏掉）。

| 文件 | 变更 |
|---|---|
| `server/security.ts` | 新增 `isCorsPreflight(req)`（`OPTIONS` + 路径为 `/api` 或 `/api/*`）与 `respondToCorsPreflight(req, res)`（`204 + corsHeadersFor(req)`，返回是否已应答）。放在 `security.ts` 而非新建模块：CORS 面（白名单、放行方法/请求头、暴露头、预检）应集中在一处，且只有 ~15 行，不值得新开文件。**`corsHeadersFor` 的白名单语义一字未改** |
| `server/backend.ts` | 把原先内联在 `createServer(async …)` 里的链路提取为具名导出 `handleBackendRequest(req, res)`，并在**所有 `handle*Api` 之前**调用 `respondToCorsPreflight`。提取的目的正是让「真实挂载顺序」可被测试直接断言，而不是在测试里另搭一条链 |
| `server/parquet-api.ts` | 删除 88 行的全局 `OPTIONS` 分支与 299 行 `/api/preview` 内的 `OPTIONS` 分支（各留一段说明「预检不在本模块应答」的注释） |
| `server/bundle-api.ts` | 删除 163 行不可达的 `OPTIONS` 分支；文件头 CORS 段改写为「预检由 `backend.ts` 统一应答」 |

**是否收窄到 `/api/*`：是。** 理由：`/ws`、`/canvas` 是 WebSocket 升级（浏览器不为其发预检），
其余路径没有跨源消费者，对它们回 204 只会掩盖本该返回的 404。收窄是行为变化，已加断言钉住
（`OPTIONS /ws`、`/canvas`、`/nonexistent`、`/share/<token>` → 404 兜底），并确认全仓无任何消费者
依赖「任意路径 OPTIONS → 204」：`grep -rn "OPTIONS" src/` 为空，`grep -rn "OPTIONS" tests/ scripts/`
只命中本次改写的两处隔离断言。

## 验证

### 命令与结果（主会话与 worker 各跑一遍，均全绿）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run build` | **0** | `tsc -b` 无错误 |
| `npm run lint` | **0** | 无 error 无 warning |
| `npm run verify` | **0** | 9 脚本全绿 + `vitest run` **31 文件 469 例** + `vitest run tests/ui` **9 文件 84 例** |
| `git status --porcelain`（verify 全跑后） | — | 只含本任务改动 |

### 断言数对账（改前 → 改后）

| 组 | 改前（main `decbbbd`） | 改后 | 差 |
|---|---|---|---|
| 脚本断言 | 671（92/71/119/148/39/54/77/13/58） | **671**（逐项同） | **0** |
| vitest integration | 30 文件 / 452 例 | **31 文件 / 469 例** | **+1 文件 / +17 例** |
| UI | 9 文件 / 84 例 | **9 文件 / 84 例** | **0** |

`+17` 的构成：

| 动作 | 文件 | 例数 | 说明 |
|---|---|---|---|
| 新增 | `tests/integration/cors-preflight.test.ts` | **+18** | 见下表 |
| 改写 | `tests/integration/session-import.test.ts` | **−1**（53 → 52） | 原「跨源预检 OPTIONS → 204…」与「非白名单 Origin 不回显」**两例合并改写为一例**「X26：模块自身不再应答跨源预检（隔离调用 OPTIONS → 405），预检统一由 backend.ts 兑现」。**删除 0 例**；两例的原断言（204 / Allow-Methods 含 POST / Allow-Headers 含 Content-Type / ACAO 回显 / 非白名单不回显）全部迁到新文件的真实链路层与真 HTTP 层，且**加强**（改为对生产链路断言，并新增 `Expose-Headers`、`Vary`、七个端点全覆盖）；本例新增断言：隔离调用返回 405 + `{error:"method not allowed"}` + 非预检响应仍带 CORS 头 + 非白名单 Origin 不回显 |

新增 `cors-preflight.test.ts` 的 18 例分三层（三层合起来把「与挂载顺序无关」钉死）：

| 层 | 例数 | 覆盖 |
|---|---|---|
| ① 纯函数 `isCorsPreflight` | 4 | `/api/*` + OPTIONS → true（含 `/api` 本身、含带 query）；非 OPTIONS 方法 → false；OPTIONS 但非 `/api/*`（`/ws`、`/canvas`、`/`、`/nonexistent`、`/share/<token>`、`/apix/shares`）→ false；`url` 缺失/空串/`//api/...` 畸形 → false 且不抛 |
| ① 纯函数 `respondToCorsPreflight` | 5 | 白名单 Origin → 204 + ACAO 回显 + `Allow-Methods: GET, POST, DELETE, OPTIONS` + `Allow-Headers: Content-Type, If-None-Match` + `Expose-Headers: ETag` + `Vary: Origin` + **无 body**；非白名单 Origin → 204 但不回显 ACAO；无 Origin → 204 无 ACAO；`127.0.0.1` / `[::1]` / `https://localhost:8443` 任意端口回显；非预检请求 → 返回 false 且**不写任何响应**（`statusCode` 仍为 0、headers 为空） |
| ② 真实链路 `handleBackendRequest`（生产用的同一个函数） | 5 | **七个端点**（`/api/shares`、`/api/share-state`、`/api/session-import`、`/api/session-bundle`、`/api/preview`、`/api/rerun-dataframe`、`/api/execute-sql`）OPTIONS 全 204 且头齐备；**任何 handler 单独都不再兑现预检**（`handleShareApi` → `handled=false`、`handleParquetApi` → `handled=false`、`handleBundleApi` → 405）；**顺序无关**（把三个 handler 反向组装且不含预检步骤 ⇒ 拿不到 204，同顺序加上 backend 的预检步骤 ⇒ 204）；收窄生效（非 `/api/*` 的 OPTIONS → 404 兜底 + `Not found`）；链路兜底未受影响（未知路径 GET → 404 JSON） |
| ③ 真 HTTP（`createServer(handleBackendRequest)` + `127.0.0.1` + 端口 0 + 真 `fetch`） | 4 | `OPTIONS /api/shares` → 204 + 放行 DELETE + `Expose-Headers: ETag` + **body 为空**；`OPTIONS /api/session-import` → 204 + 放行 POST 与 Content-Type；非白名单 Origin → 204 且 ACAO 为 `null`；`OPTIONS /ws` → 404 |

### 跨平台纪律（PR #48 的教训）

- 全部断言**不依赖任何 Windows 特有行为**（无 symlink、无盘符、无大小写不敏感、无路径分隔符假设）
- 真 server 用 `127.0.0.1` + 端口 `0`，`afterAll` 里 `server.close()`
- 只 mock 与本测试无关的进程引导依赖（`server/agent.js` 的 pi 运行时、`server/ws-handler.js` 的 WS 挂载）；
  **三个 `handle*Api` 与 `security.ts` 全是真实实现**
- `npm run verify` 是 `&&` 串接（integration 失败会掩盖 `verify:ui`），本地逐组确认了三组数字

### 测试夹具凭据纪律（PR #46 的教训）

本任务不引入任何凭据夹具；Origin 反例用 `https://evil.example.com`（非凭据形态）。

## 影响面与遗留

1. **行为变化（唯一一处，且是收窄）**：非 `/api/*` 路径的 `OPTIONS` 不再回 204，改为落到 404 兜底。
   全仓无消费者依赖旧行为（`grep -rn "OPTIONS" src/` 为空）。浏览器不会为 `/ws`、`/canvas`
   发预检（WebSocket 升级不走 CORS 预检），故 dev 与生产均无感。
2. **`res.writeHead(404, …)` 兜底不带 CORS 头**（既有行为，本次未改）：跨源页面读不到 404 的响应体。
   现状无消费者依赖它（前端只对已知 `/api/*` 路由发请求），收紧/放开都属 X1 安全基线的取舍，未动。
3. **`handleBackendRequest` 现在是具名导出**，`startBackend` 与测试共用同一条链。若将来新增 API 模块，
   预检**不需要**也**不应该**再自带 `OPTIONS` 分支——请在 code review 里守住这条（`cors-preflight.test.ts`
   的「任何 handler 单独都不再兑现预检」会在有人重新加回去时给出信号，但只在被加回的模块被该用例覆盖时）。
4. **`docs/specs/06-backend.md`** 的 CORS 段与 `/api/session-import` 路由表已同步；`/api/session-bundle` 段
   原文「只用 GET ⇒ 无需预检」仍成立，未改。
5. **未做**（超范围）：`corsHeadersFor` 的白名单本身（放行方法/请求头/暴露头）没有重新评估；
   `Allow-Origin` 仍回显任意端口的本地 Origin。这两项属 X1 安全基线与 T3.3（SSO/多用户）范围。
