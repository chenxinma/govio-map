# T3.5 验证

## 1. 验证命令与结果（全绿）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run build` | **0** | `tsc -b` 无错误；`vite build` ✓ built in ~2s；`compile:server` → `dist-server/cli.mjs 198.9kb` |
| `npm run lint` | **0** | `eslint .` 无 error 无 warning |
| `npm run verify` | **0** | 九个脚本全绿 + `vitest run` 24 文件 333 例 + `vitest run tests/ui` 6 文件 57 例 |
| `git status --porcelain`（verify 全跑后） | — | 只含本任务改动，**无 verify 残留物** |

`npm run verify` 展开的九步：`verify:manifest` → `verify:rerun` → `verify:audit` → `verify:export` →
`verify:source-table` → `verify:semantic-lineage` → `verify:caliber-conflict` → `verify:cwd` →
`verify:prompt-injection` → `verify:integration` → `verify:ui`。

## 2. 断言数对账（§4.9 要求：删前 → 删后逐项）

### 2.1 脚本断言：**671 → 671（零变化，零回归）**

| 脚本 | 基线（main `3901c03`） | 本任务后 | 差 |
|---|---|---|---|
| `verify:manifest` | 92 | 92 | 0 |
| `verify:rerun` | 71 | **71** | **0**（只读页复跑削减**没有**动到主界面复跑链路：`server/dataframe-rerun.ts`、`src/utils/rerun.ts`、`DataFrameNode` 复跑按钮、`RerunStatus` 全部零改动） |
| `verify:audit` | 119 | 119 | 0 |
| `verify:export` | **148** | **148** | **0**（T3.6/T3.7 链路零改动，符合范围纪律硬要求） |
| `verify:source-table` | 39 | 39 | 0 |
| `verify:semantic-lineage` | 54 | 54 | 0 |
| `verify:caliber-conflict` | 77 | 77 | 0 |
| `verify:cwd` | 13 | 13 | 0 |
| `verify:prompt-injection` | 58 | 58 | 0 |
| **合计** | **671** | **671** | **0** |

### 2.2 vitest（`npm run verify:integration` = `vitest run`）：**21 文件 289 例 → 24 文件 333 例（净 +44）**

**删除：`tests/integration/share-fork.test.ts` 整文件，7 例**（快照语义随裁决 ④ 废弃）

| # | 被删用例名 | 处置 |
|---|---|---|
| 1 | `createShare → resolveShare 往返；Manifest 抽取；令牌形状` | **重建**为活视图形态：`share-live.test.ts`「源画布新增节点后同一 token 载荷立即含新节点…」+「token = sha256(域前缀+sessionId)…」+「开启幂等…」（Manifest 抽取断言保留：`manifests[0].manifest.sql === "SELECT 1"`） |
| 2 | `视图载荷剥 profile/originBackend；一切工件不含凭据` | **重建**为「凭据与后端拓扑不外泄：活视图载荷与开关 sidecar 都不含 profile 名/凭据值」（活视图载荷天生不含 profile 字段，扫描范围从 4 类工件改为载荷 + 开关 sidecar 2 类） |
| 3 | `只读纪律：resolve/fork 不改动源画布 sidecar（内容+etag 恒定）` | **原样保留并加强**：「只读纪律：活视图 GET / fork 前后源画布 sidecar 字节与 etag 恒定」（另加 `loadCanvas` 内容比对） |
| 4 | `S3 绑定画布的分享写远端 key，并可经 profile 枚举跨实例发现` | **有意删除**（裁决 ⑦：远端 share 工件整体退出，跨实例分享不在本期）。design.md §8 给结论、遗留 1 归口 T3.3/T3.4 |
| 5 | `forkShare 暂存 → 应用到新画布：forkFrom 落 canvas.json 顶层` | **原样保留并加强**：「forkShare 从**当前**活画布暂存 → forkFrom 落新画布 canvas.json 顶层」（新增断言：fork 前源画布又长了节点，fork 必须拿到最新内容） |
| 6 | `血缘抗 autosave：后续无 meta 的 saveCanvas（1s debounce 快照）保留 forkFrom` | **原样保留**（T3.2 既有断言不回退，任务书 §4.8 点名） |
| 7 | `派生画布再分享：ShareRecord 继承 forkFrom（血缘链可追溯）；fork 未知令牌 404 语义` | **原样保留并加强**：「派生画布再分享：活视图载荷继承 forkFrom…；未知/已撤销 token fork → null」（新增撤销后 fork 也失效） |

**新增：4 个文件，51 例**

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `tests/integration/share-live.test.ts` | **21** | token 派生（形状/域分隔/纯函数恒定性）、开关默认关且未开启 token 不可解析、开启幂等、撤销即失效且可恢复同一 token、旧随机 token 与非法形状 404、坏 sidecar 视为未开启、`deleteSession` 级联、活视图返回当前画布且不产生 `.govio/shares/`、etag 随内容变化、`ifNoneMatchHits` 十种头形态、空画布不是 404、只读纪律（字节+etag 恒定）、凭据不外泄、`GET /api/share-state`（409/开启前后）、`POST`+`DELETE /api/shares`（幂等/撤销后 404）、`GET /api/shares/<token>`（ETag 头 + `Cache-Control: no-store` + 304 无 body + 内容变化后不再命中）、**rerun 路由已删（`handled === false`）**、fork 仍在 + 非法方法 405、CORS 放行 DELETE/If-None-Match/暴露 ETag、fork 三例（暂存+forkFrom、抗 autosave、链式传承） |
| `tests/integration/share-poll.test.ts` | **10** | 退避阶梯与 `sharePollDelayMs` 边界（0/1/2/3/4/5/99/−1/NaN/小数）、中断文案、start 立即拉一次 + 3s 排定、**304 不回调 `onPayload`**、etag 作为下一次 `If-None-Match` 来源、连续失败 3→6→12→30→30 + 中断只报一次 + 恢复后复位并清除提示、`fetchView` 抛异常进退避不炸、404 → `onGone` 一次并终止、隐藏暂停 + 恢复立即拉一次并重启计时、隐藏时 start 不排下一次、`stop()` 清定时器并解绑可见性 |
| `tests/ui/share-view.test.tsx` | **13** | **陷阱 1**：全流程后 `localStorage['govio-canvas-state']` 与种子**逐字节相同**；**陷阱 2**：pending/首拉失败/404 三条路径都不闪现本机画布，回包后本机节点被整体替换；五类节点真渲染（表名/字段/全限定名、SQL 高亮 span、entries×columns/列结构/dtype、报告 markdown 正文、chart 标题+来源 df+类型、右栏 Manifest 计数）；**chart 真出 Plotly**（懒加载模块 `react()` 被调用且收到节点的 `config.data`/`config.layout`，容器是 HTMLElement，未降级成「图表配置错误」）；`nodeTypes` 就是主画布那份且 ShareView 不再自带 `ShareNodeCard`/`shareCard`；**陷阱 4**：源码用 `apiBaseFrom(window.location.origin)`、无 `parseInt(window.location.port`、无相对路径 `fetch(\`/api/shares/`；**陷阱 3**：五类卡片上引用/删除/预览/复跑/编辑全不渲染而「详情」「放大」保留、点遍画布内所有按钮**零请求**且 store 未被改、只读页不含 WebSocket/canvas-service/useChat；304 时 `hydrateSession` 不再被调用（fake timers 驱动 3s 轮询，第三次轮询内容变化后又调用）；卸载后不再发请求；五个节点都无 `selectable`/`draggable` class |
| `tests/ui/share-toggle.test.tsx` | **7** | 挂载即查 `/api/share-state` 且默认关、服务端已开启时初始即开启态、`disabled` 透传、开启 → POST + 浮层给出页面 origin 链接（X25 反向断言：不等于 API 基址拼出的地址）+ 隐私告知文案、已开启时再点只展开浮层**不发请求**（T3.2 短路缺陷不复现）、撤销 → DELETE → 重新开启得到**同一链接**（token 恒定）、开启失败（409）给错误提示且不假装已开启 |

### 2.3 UI（`npm run verify:ui` = `vitest run tests/ui`）：**4 文件 37 例 → 6 文件 57 例（净 +20）**

新增 `share-view.test.tsx`（13）+ `share-toggle.test.tsx`（7）= +20；既有 4 个 UI 文件
（`canvas-toolbar` 2 / `settings-modal` 11 / `source-table-node` 16 / `sql-query-node` 8 = 37 例）
**零改动零回归**——节点组件加的 `useReadOnlyCanvas()` 默认 `false`，无 Provider 时行为与改前一致
（这 37 例全部在无 Provider 环境下运行，正好反向证明主画布零行为变化）。

### 2.4 汇总（供主会话更新 `verificationBaseline`）

| 组 | 基线 | 本任务后 |
|---|---|---|
| 脚本断言 | 671 | **671**（9 脚本，逐项零变化） |
| vitest integration（`vitest run`） | 21 文件 / 289 例 | **24 文件 / 333 例** |
| UI（`vitest run tests/ui`） | 4 文件 / 37 例 | **6 文件 / 57 例** |

## 3. 人工目视对照记录（只读页 vs 主画布，覆盖五类节点）

> ⚠️ **诚实声明**：本 worker 环境无浏览器、无 puppeteer/playwright（且任务纪律禁止 `npm install`），
> 所以**没有截图**。下面是**逐项文字对照**，其证据基础是两条：
> ① 结构性事实——`ShareView` import 的 `nodeTypes` 与 `src/components/Nodes/index.ts` 导出的是**同一个对象**
> （`tests/ui/share-view.test.tsx` 有源码级断言），即只读页与主画布跑的是**同一份组件代码**；
> ② 渲染产物断言——同一测试对只读页真实渲染出的 DOM 逐项断言（下表「自动化证据」列）。
> **真实浏览器并排目视与截图请在验收时补做**（记入 design.md 遗留 9）。
> 复现步骤：`npm run dev` → 主界面造出五类节点 → 点分享图标开启 → 新标签打开浮层里的链接。

| 节点类型 | 主画布显示 | 只读活视图显示 | 差异 | 自动化证据 |
|---|---|---|---|---|
| **sourceTable** | 紫色左边框卡片；表名、database、`N rows`、全限定名 + 复制按钮、字段表（名/类型/PK/FK/描述，超 6 条折叠）、表间关系小节（X13/X15 关系详情）、操作栏「引用 / 删除」 | **完全相同**，仅操作栏整条不渲染；复制全限定名、字段展开、关系展开都可用 | 少「引用 / 删除」两个按钮 | `getByText("REMOTE_TABLE_orders")`；`body` 含字段名 `channel_id` 与全限定名 `sales.main.REMOTE_TABLE_orders` |
| **sqlQuery** | 绿色左边框卡片；标题、口径冲突警示（T2.3）、SQL 全文（X21 语法高亮，超 8 行折叠）、口径徽标小节（X18，超上限折叠）、输出列、操作栏「引用 / 编辑 / 详情 / 删除」 | **完全相同**，操作栏只剩「详情」（有 Manifest 时）；双击 SQL 不进编辑态 | 少「引用 / 编辑 / 删除」；双击编辑禁用 | `getAllByText("REMOTE_SQL_汇总")` 命中 2 处（节点卡片 + 右栏 Manifest）；`document.querySelectorAll("[data-sqltok]").length > 0`（高亮 span 真在）；卡片按钮文本不含「编辑」 |
| **dataFrame** | 橙色左边框卡片；df 名、来源、`N entries / N columns / 内存`、列结构表（#/Column/Non-Null/Dtype，超 10 条折叠）、漂移徽标与 RerunStatus 复跑历史、操作栏「引用 / 预览 / 详情 / 复跑 / 删除」 | **完全相同**，操作栏只剩「详情」；历史复跑记录与漂移警示照常显示（那是数据不是动作） | 少「引用 / 预览 / 复跑 / 删除」 | `body` 含 `REMOTE_DF_sales`、`3 entries`、`2 columns`、列 dtype `float64`；卡片按钮文本不含「预览」「复跑」 |
| **report** | 琥珀/紫左边框卡片；标题、来源引用标签、Markdown 正文（标题/表格/列表解析） | **完全相同**，仅操作栏整条不渲染 | 少「引用 / 删除」 | `getByText("REMOTE_REPORT_差异")`；`body` 含正文 `两次取数一致` |
| **chart** | 蓝色左边框卡片；标题、来源 df 徽标、图表类型、**Plotly 真图**（260px 高容器，懒加载 chunk）、点击/「放大」开 ChartModal、操作栏「引用 / 放大 / 删除」 | **完全相同**：**Plotly 真渲染出图**（不是文字卡片），放大可用；操作栏只剩「放大」 | 少「引用 / 删除」 | `plotly.js-dist-min` 替身的 `react()` 被调用，且 `args[1]` 逐值等于节点 `config.data`、`args[2]` 等于 `config.layout`，`args[0]` 是 HTMLElement；未出现「图表配置错误」 |
| **边 / 画布 chrome** | 数据血缘（绿实线动画 smoothstep）、语义血缘（紫虚线 bezier，上/下 Handle）、X13/X15 边 label、点状 Background、Controls、MiniMap（五类节点各自配色）、血缘图例 | **完全相同**（`defaultEdgeOptions={lineageEdgeDefaults('data')}` + 同款 Background/Controls/MiniMap/LineageLegend） | 不能拖动节点、不能连线、不能选中、没有工具栏/查找栏/预览面板 | 5 个 `.react-flow__node` 均无 `selectable` / `draggable` class；`body` 含「血缘图例 / 数据血缘 / 语义血缘」 |
| **页头** | 画布工具栏（自动布局 / SQL / 导出交付报告 …） | 「只读 · 活视图」徽标 + 源画布更新时间 + 派生血缘提示 + 「与源画布同步中断」警示（仅退避期间）+ 复制链接 + **Fork 续写** | 主画布工具栏整条不存在；只读页多活视图状态与 fork 入口 | `body` 含「只读 · 活视图」「源画布更新于」「只读页不提供复跑」 |

## 4. 关键回归点复核（任务书 §3 四个陷阱 + §4.8）

| 要求 | 落点 | 结果 |
|---|---|---|
| 陷阱 1：persist 中和后 `localStorage['govio-canvas-state']` 未被写 | `src/components/Share/canvas-persistence.ts` + `share-view.test.tsx`「全流程后 govio-canvas-state 字节未被改写」 | ✅ 逐字节相同 |
| 陷阱 2：远端数据到达前不闪现本机画布 | `ShareView` 的 `payload === null` 分支 + 三条路径断言 | ✅ pending/失败/404 都不出现本机节点标题 |
| 陷阱 3：只读页无任何写回源 session 路径 | `useReadOnlyCanvas` + 五类组件门控 + 「点遍画布内按钮零请求」+「源码不含 WebSocket/canvas-service/useChat」 | ✅ mutating 端点枚举断言不触达 |
| 陷阱 4：ShareView 自带 `apiBase()` 改用 X25 模块 | `apiBaseFrom(window.location.origin) ?? ''` + 源码级断言无 `parseInt(window.location.port` | ✅ |
| token 恒定性回归（生成链接 → 新增节点 → 再点分享，链接不变内容变新） | 服务端：「开启幂等」+「源画布新增节点后同一 token 载荷立即含新节点」；UI：「撤销后重新开启得到同一链接」+「已开启再点不发请求」 | ✅ |
| 只读接口返回当前画布（非旧快照） | 「…不产生任何 `.govio/shares/` 快照」 | ✅ |
| 304 / 指纹未变不重渲染 | `share-poll.test.ts`（onPayload 不回调）+ `share-view.test.tsx`（hydrateSession 不再被调用） | ✅ |
| 隐藏暂停 / 退避并提示 | `share-poll.test.ts` 三例 + `share-view.test.tsx`「首拉失败 → 显示与源画布同步中断」 | ✅ |
| chart 出 Plotly 容器 | `share-view.test.tsx`「chart 节点真渲染出 Plotly」 | ✅ |
| fork 仍产 `forkFrom`（含链式传承、抗 autosave） | `share-live.test.ts` fork 三例 | ✅ T3.2 两条既有断言未回退 |
| 分享链接 origin 反向断言（X25 思路） | `share-toggle.test.tsx` + 既有 `share-link.test.ts` 11 例零改动 | ✅ |
| `PROTOCOL_VERSION` 未 bump | `src/types/ws-protocol.ts` 零改动；`ws-protocol.test.ts` 19 例复绿 | ✅ 仍为 1 |
| `verify:export` 148 项零改动 | 见 §2.1 | ✅ |

## 5. 真机冒烟（仓库真实 `.govio/sessions`，临时脚本跑完即删，不进 commit）

为弥补「无浏览器」的缺口，在**仓库真实会话数据**上直接跑了一遍服务端活视图链路
（选中会话 `2026-11-14T10-57-32-491Z_01a1d9b4-…`，跑完立即撤销并确认 sidecar 已清）：

```
sessions: 7
target session: 2026-11-14T10-57-32-491Z_01a1d9b4-934b-7130-8e20-c5f9cc78c6bb
canvas: 5 nodes / 3 edges
canvas sidecar mtime: 2026-11-14T11:08:23.514Z

[1] derived token = 5b7497db7b34c02058ac939ce778c355 (len 32, /^[a-f0-9]{32}$/ = true)
[1] 未开启时 resolveShareToken → null ✅
[2] enableShare → enabled=true token=与派生值一致 ✅
[2] 幂等：二次开启 token 相同 = ✅；enabledAt 不变 = ✅
[2] 链接 = http://localhost:5173/share/5b7497db7b34c02058ac939ce778c355
[3] liveShareView → 5 nodes / 3 edges（与 sidecar 一致 = ✅）
[3] etag = 2411dce04e675012e5ec24e0228c2a07；manifests = 1；updatedAt = 2026-11-14T11:08:23.514Z
[3] 节点类型 = sourceTable, sourceTable, sourceTable, sourceTable, sqlQuery
[3] If-None-Match 命中 = ✅ 304
[4] 撤销后 sidecar 存在 = false ✅
[4] 撤销后 resolveShareToken → null ✅
[4] 撤销后 liveShareView → null ✅（前端渲染失效文案）
```

另外单独验证了用户实测的那条**旧快照链接**的 token：

```
resolveShareToken('6d6aa27396782536ecad2be1a3ac5597') → null
```

即旧链接已彻底失效（前端渲染「分享链接已失效」），符合裁决 ④。
清理确认：`ls .govio/sessions/*.share.json` → 0 个残留。

### 5.1 真 HTTP 层冒烟（tmp cwd + 真实 `node:http` server + 真 `fetch`）

fake `req/res` 证不了真实 HTTP 行为（尤其 304 无 body 与预检），所以另跑了一轮真 server
（按 `backend.ts` 的真实顺序挂 `handleParquetApi` → `handleShareApi`）：

```
token(派生) === deriveShareToken ? true
[GET] 200 etag="68ca468b11f22435443610086eaeb895" cache-control=no-store body.etag=68ca468b… nodes=1
[GET + If-None-Match] 304（期望 304）body="" etag="68ca468b11f22435443610086eaeb895"
[源画布变更后同一 If-None-Match] 200（期望 200）nodes=2 etag 变了=true
[POST .../rerun] 404 {"error":"Not found"}（路由已删，落到 backend.ts 兜底）
[POST .../fork] 201 forkId=e03133a1…
[DELETE /api/shares/<token>] 405（带 token 的路径不接 DELETE）
[撤销后 GET] 404 {"error":"share-not-found"}
[OPTIONS 预检] 204 allow-methods=GET, POST, DELETE, OPTIONS
              allow-headers=Content-Type, If-None-Match  expose=ETag
cleanup: sidecar 残留=false
```

关键结论：**304 真的无 body 且带 ETag**；源画布变更后同一个 `If-None-Match` 不再命中（活视图生效）；
**跨源预检 204 且三个 CORS 头齐备**（否则 dev 下 5173→5174 的 `DELETE` 与 `If-None-Match` 会被浏览器拦下）。
两个临时冒烟脚本跑完即删，**不进 commit**（`git status --porcelain` 已确认干净）。

## 6. 未覆盖 / 需人工确认

1. **真实浏览器目视与截图**（§3 已声明）：需人工在 `npm run dev` 下并排对照五类节点与 chart 的真实 Plotly 渲染。
2. **端到端轮询的真机体验**：3s 节奏、隐藏标签页暂停、后端停机后的退避与提示，自动化是在注入替身下断言的
   （HTTP 层的 304/ETag/预检已由 §5.1 真 server 证实）；真机验证建议：开启分享 → 主画布加节点 →
   3s 内只读页自动出现新节点 → 切到别的标签页 30s 再切回 → 立即刷新一次。
3. **`.govio/shares/` 既有残留文件**：代码已不再读写该目录，本任务不清理磁盘上的旧文件（裁决 ④ 不做迁移）；
   需要时可人工删除该目录。

## 7. 主会话验收期修正（PR #46）

**GitGuardian 密钥扫描报 1 处 secret（误报，已收口）**：`share-live.test.ts`「凭据与后端拓扑不外泄」用例的
**假凭据夹具**原来的两个字面量分别带了 AWS access key id 的四字母全大写前缀、以及 OpenAI secret key 的
两字母+短横线前缀形态（**此处刻意不复写原字符串**，否则本文档自己又会触发扫描器），被扫描器当成真泄漏。已改为不带任何已知前缀的
`TEST-ONLY-AK-1234` / `TEST-ONLY-SK-1234`，并就地加注释说明「夹具刻意不采用真实凭据形态」，反向断言改为引用同一常量（断言意图与强度不变：两个值 + profile 名 +
`profile` 字样均不得出现在活视图载荷与开关 sidecar 中）。

修正后主会话**重跑全量门槛**（非转述）：`npm run build`=0 / `npm run lint`=0 / `npm run verify`=0；
脚本断言逐项复核仍为 **671**（92 / 71 / 119 / **148** / 39 / 54 / 77 / 13 / 58），vitest integration **24 文件 333 例**，
UI **6 文件 57 例**，`git status --porcelain` 除本修正外干净。
