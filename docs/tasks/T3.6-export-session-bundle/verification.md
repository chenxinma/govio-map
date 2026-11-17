# T3.6 验证

## 1. 验证命令与结果（全绿）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run build` | **0** | `tsc -b` 无错误；`vite build` ✓；`compile:server` → `dist-server/cli.mjs 205.4kb` |
| `npm run lint` | **0** | `eslint .` 无 error 无 warning |
| `npm run verify` | **0** | 九个脚本全绿 + `vitest run` **27 文件 377 例** + `vitest run tests/ui` **7 文件 62 例** |
| `git status --porcelain`（verify 全跑后） | — | 只含本任务改动（20 个文件），**无 verify 残留物** |

`npm run verify` 展开：`verify:manifest` → `verify:rerun` → `verify:audit` → `verify:export` → `verify:source-table`
→ `verify:semantic-lineage` → `verify:caliber-conflict` → `verify:cwd` → `verify:prompt-injection`
→ `verify:integration` → `verify:ui`。

## 2. 断言数对账（改前 → 改后逐项）

### 2.1 脚本断言：**671 → 671（零变化，零回归）**

| 脚本 | 基线（main `4c0af31`） | 本任务后 | 差 |
|---|---|---|---|
| `verify:manifest` | 92 | 92 | 0 |
| `verify:rerun` | 71 | 71 | 0 |
| `verify:audit` | 119 | 119 | 0 |
| `verify:export` | **148** | **148** | **0** —— 硬要求达成：`scripts/verify-export-report.ts` 与 `src/utils/export-report.ts`、`CanvasToolbar.tsx` 三者**零改动**（`git diff --stat main..HEAD` 里没有它们） |
| `verify:source-table` | 39 | 39 | 0 |
| `verify:semantic-lineage` | 54 | 54 | 0 |
| `verify:caliber-conflict` | 77 | 77 | 0 |
| `verify:cwd` | 13 | 13 | 0 |
| `verify:prompt-injection` | 58 | 58 | 0 |
| **合计** | **671** | **671** | **0** |

### 2.2 vitest（`npm run verify:integration` = `vitest run`，含 tests/ui）：**24 文件 333 例 → 27 文件 377 例（净 +44）**

**删除：0 例**（本任务不删任何既有用例；旧 `/export` 实现从来没有测试覆盖 —— `grep -rln "export-session\|exportSession" tests/ scripts/` 在改动前为空）。

**新增：3 个文件，44 例**

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/integration/session-bundle.test.ts` | **23** | 服务端收集器与 HTTP 路由：清单齐全性、sha256/base64 与磁盘原字节逐条对账、`manifests.json` 派生一致性、包内路径白名单（8 个非法样本）、`missing` 如实记账、token 恒定性/唯一性/不要求开启分享、载荷形状与固定时钟可复现、凭据不入包（含区域与桶名反向断言）、`.share.json` 与孤儿 `.injection.zip` 不入包、parquet 排除记账（存在/缺失/去重/非法 dfName 不触盘）、目录穿越与越界路径被拒、幽灵会话、超总量上限、路由 409/200/400/404/405/不接管/`no-store`/CORS 回显与非白名单不回显/畸形 URL |
| `tests/integration/export-bundle.test.ts` | **16** | 前端组装（载荷取自**真实** `collectSessionBundle`）：zip 反解后条目集合与包名、`bundle.json` 全字段、逐文件校验和可独立复核且不列自身、服务端 sha256 原样透传 + `report.html` 前端补算、报告数据源是**包内 canvas.json**（含 `exportedAt` 与基址透传）、两次打包字节一致、空画布/无画布两条 `reportOmitted` 分支、parquet 记账透传、整包凭据反向断言、dev 端口 +1 与生产同源相对路径、409/404/400/413/500 五种人话提示且零下载、载荷形状与非法包内路径 8 种全拒、无 `crypto.subtle` 明确报错、`fetchAuditForBundle` 基址纪律与三种降级 |
| `tests/ui/export-command.test.tsx` | **5** | `/export` 命令文案已是打包语义、选中即调 `exportSessionBundle` 且交出页面 origin、成功反馈（文件名/体积/文件数/含交付报告）、排除 parquet 与无报告时如实说明、失败提示、并发保护 |

### 2.3 UI（`npm run verify:ui` = `vitest run tests/ui`）：**6 文件 57 例 → 7 文件 62 例（净 +5）**

新增 `export-command.test.tsx`（5）；既有 6 个 UI 文件 57 例**零改动零回归**
（`canvas-toolbar` 2 / `settings-modal` 11 / `source-table-node` 16 / `sql-query-node` 8 / `share-view` 13 / `share-toggle` 7）。

### 2.4 汇总（供主会话更新 `verificationBaseline`）

| 组 | 基线（main `4c0af31`） | 本任务后 |
|---|---|---|
| 脚本断言 | 671 | **671**（9 脚本逐项零变化） |
| vitest integration（`vitest run`） | 24 文件 / 333 例 | **27 文件 / 377 例** |
| UI（`vitest run tests/ui`） | 6 文件 / 57 例 | **7 文件 / 62 例** |

## 3. bundle 体积对比（X3 拆分纪律：fflate 与报告模板不得进主 chunk）

第一次实现时 `ChatInput` **静态**引入 `commands/export-session.ts`，主 chunk 从 1457.38 涨到 **1515.21 kB**
（gzip 450.79 → 473.33），且 `export-report` 独立 chunk 消失 —— 等于回退 X3 的拆分。改为与 `CanvasToolbar`
同款 `await import(...)` 后恢复：

| 产物 | 基线（T3.5 后） | 静态引入（错误做法） | 本任务最终 | 差 |
|---|---|---|---|---|
| `index-*.js`（主 chunk） | 1,457.38 kB（gzip 450.79） | 1,515.21 kB（gzip 473.33） | **1,458.25 kB（gzip 451.18）** | **+0.87 kB（gzip +0.39）**：ChatInput 的导出反馈条 |
| `export-session-*.js` | —（不存在） | —（并入主 chunk） | **14.11 kB（gzip 7.11）** | 新增懒加载 chunk（fflate + 打包逻辑） |
| `export-report-*.js` | 43.13 kB | —（并入主 chunk） | **43.24 kB（gzip 16.06）** | +0.11 kB（chunk 边界重排；该文件本身零改动） |
| `plotly.min-*.js` | **4,646.12 kB** | 4,646.13 kB | **4,646.12 kB** | **0 —— 懒加载 chunk 未回退** |
| `sql-columns-*.js` | 2,436.98 kB | 2,436.98 kB | 2,436.98 kB | 0 |
| `index-*.css` | 53.91 kB（gzip 10.02） | 53.91 kB | 53.91 kB（gzip 10.02） | 0 |
| `dist-server/cli.mjs` | 198.9 kb | — | **205.4 kb** | +6.5 kb（session-bundle + bundle-api） |

## 4. 关键验收点复核（对齐 acceptance）

| acceptance 要求 | 落点 | 结果 |
|---|---|---|
| 产出与 session token 对应的自包含包，含画布 + 对话 + Manifest + 清单与校验和，可离线打开与校验 | `<token>.govio-bundle.zip`；`session.jsonl` / `canvas.json`（内含节点固化的 Manifest）/ `manifests.json` / `audit.jsonl` / `injection.jsonl` / `report.html` / `bundle.json` | ✅ 单测 + §5 真机冒烟双重证据 |
| 包内不含任何凭据（自动化反向断言） | `session-bundle.test.ts`「`.storage.json` 本体不入包…」+ `export-bundle.test.ts`「整包任何字节都不含假凭据/桶名/区域」 | ✅ 假凭据、桶名、区域、`storage-profiles.json` 字样均断言不出现；只留 profile 引用名 |
| 路径穿越被拒（断言） | 服务端 `assertValidSessionPath`（4 种越界样本）+ `isSafeBundlePath`（8 种非法包内路径，两端各断言一次）+ `dataframeParquetPathFor` 的 dfName 白名单（`../escape` 不触盘） | ✅ |
| T1.4 HTML 报告能力不被破坏：`verify:export` 148 项零回归（只增不削） | 三个相关文件零改动（§2.1）；`report.html` 复用其纯函数生成 | ✅ 148 → 148 |
| 包结构与 token 一致性有自动化断言；产物可被 T3.7 读取（格式契约双方对齐） | token = `deriveShareToken(sessionId)` 且两次导出恒定；`bundle.json` 全字段与逐文件 sha256 可独立复核；契约常量集中在 `src/types/bundle.ts`（T3.7 直接 import） | ✅ 见 §2.2 与 design.md §5 |
| build/lint/verify 全绿、基线零回归 + 新增用例 | §1、§2 | ✅ |

## 5. 真机冒烟（仓库真实会话数据，临时脚本跑完即删，不进 commit）

用仓库里**真实的**会话 `2026-11-15T08-52-22-637Z_01a1de68-…`（transcript 187,825 B，画布 7 节点 3 边含
chart×1 / dataFrame×2 / sourceTable×4，且同时有 `.audit.jsonl` 与 `.injection.jsonl`）走完整链路。
`report.html` 用替身（Node 里没有 Plotly，图表静态渲染只能在浏览器发生）——这一点如实标注。

```
[1] format=govio-session-bundle version=1
[1] token=3e27037a8304eb30813a56506240f23b (len 32, /^[a-f0-9]{32}$/ = true)
[1] sessionId=2026-11-15T08-52-22-637Z_01a1de68-57ed-76a9-be24-84c2fb8ffd5c
[1] storageProfile=(缺省：无 S3 绑定)     [1] missing=[]
[1] excluded.parquet={"count":2,"bytes":14329,"names":["df_chocolate_metrics.parquet","df_sales_amount_by_channel.parquet"],"absent":[]}
[1]   file session.jsonl      187825 B  sha256=38c8579fc586…
[1]   file canvas.json         12046 B  sha256=ab3765438261…
[1]   file manifests.json       3854 B  sha256=ef41cbcc0fea…
[1]   file audit.jsonl          2206 B  sha256=9cdb1a90abef…
[1]   file injection.jsonl       721 B  sha256=3fd439439a2d…

[2] fetch → http://localhost:5174/api/session-bundle          ← 基址由页面 origin 5173 推导（X25）
[2] buildReport ← nodes=7 edges=3 exportedAt=2026-11-17T03:00:00.000Z apiBase=http://localhost:5174
[2] fileName=3e27037a8304eb30813a56506240f23b.govio-bundle.zip
[2] zip bytes=65097 (63.6 KB)  fileCount=7  reportIncluded=true
[2] token 与服务端一致 = true

[3] zip 条目（7）: audit.jsonl, bundle.json, canvas.json, injection.jsonl, manifests.json, report.html, session.jsonl
[3] bundle.json: format=govio-session-bundle version=1 appVersion=0.7.2
[3] bundle.json.token === payload.token = true；列出 6 个文件（不含自身）
[3]   session.jsonl / canvas.json / manifests.json / audit.jsonl / injection.jsonl / report.html
      → exists=true bytes=true sha256=true（六个全部可独立复核）
[3] 清单外多余条目 = []        [3] 全部校验和可复核 = true
[3] session.jsonl 首行 = {"type":"session","version":3,"id":"01a1de68-…","timestamp":"202…
```

结论：187 KB 的真实 transcript + 12 KB 画布 + 三类留痕 → **63.6 KB** 的 zip（约 3.5:1），
七个条目、清单与包内实际内容逐条对得上，无多余条目。

### 5.1 真 HTTP 层冒烟（真 `node:http` server + 真 `fetch`，按 `backend.ts` 的挂载顺序）

fake `req/res` 证不了真实 HTTP 行为（查询串解码、Windows 绝对路径、响应头、预检），所以另起真 server
（`handleParquetApi` → `handleShareApi` → `handleBundleApi`）打了一遍：

```
[1] GET /api/session-bundle（无活动会话）      → 409 {"error":"session bundle requires an active session"}
[2] GET ?session=<Windows 绝对路径>            → 200 format=govio-session-bundle v=1
[2] token=3e27037a8304eb30813a56506240f23b sessionId 一致=true
[2] files=session.jsonl(187825B), canvas.json(12046B), manifests.json(3854B), audit.jsonl(2206B), injection.jsonl(721B)
[2] content-type=application/json  cache-control=no-store
[2] CORS: allow-origin=http://localhost:5173  allow-methods=GET, POST, DELETE, OPTIONS  expose=ETag
[3] ?session=../../evil.jsonl                 → 400 {"error":"invalid-session-path"}
[3] ?session=D:\Work\gov-io\govio-map\.govio\evil.jsonl → 400 {"error":"invalid-session-path"}
[3] ?session=D:/Windows/win.ini               → 400 {"error":"invalid-session-path"}
[4] 合法但不存在                              → 404 {"error":"session-not-found"}
[5] POST → 405    DELETE → 405    OPTIONS → 204（预检由 parquet-api 的全局 OPTIONS 分支处理，allow-methods 未变）
[6] 非白名单 Origin → access-control-allow-origin=null（不回显），业务仍 200
[7] /api/session-bundles → 404 {"error":"Not found"}（不误接管，落到 backend 兜底）
[8] GET /api/shares/<token>（该会话未开启分享）→ 404 {"error":"share-not-found"}（T3.5 分享路由未受影响）
```

两个临时冒烟脚本跑完即删（`git status --porcelain` 已确认无残留）。

## 6. 未覆盖 / 需人工确认

1. **真实浏览器里的端到端体验**：本环境无浏览器（且任务纪律只允许装 `fflate`），所以「键入 `/export` →
   看到提示条 → 浏览器真的落一个 zip 到下载目录 → 双击 `report.html` 能离线打开」这一段没有人工跑过。
   自动化覆盖了除「浏览器真的下载」以外的全部环节（`download` 是注入点，产物字节已被反解校验）。
   建议验收时跑一次：`npm run dev` → 发一条消息造几个节点 → `/export` → 解开 zip 双击 `report.html`。
2. **`report.html` 的图表静态渲染在包内的实际效果**：冒烟用的是替身 HTML（Node 无 Plotly）。
   生成路径复用的是 T1.4 那条已被 148 项断言锁住的纯函数链（`renderChartImages` + `buildDeliveryReportHtml`），
   但「zip 里的报告图表是图片而非配置摘要」仍需上面第 1 条的人工验证一并确认。
3. **导出历史会话时附录 B 可能拿不到审计记录**：`GET /api/permission-audit` 只读服务端会话单例（既有设计），
   详见 design.md 遗留 4。包内 `audit.jsonl` 仍是那个会话的完整留痕（服务端读的），不受影响。
