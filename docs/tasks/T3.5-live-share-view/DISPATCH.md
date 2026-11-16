# T3.5 任务书：只读分享重定义为「session 指纹 token 的画布活视图」

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → .phases[] | .tasks[] | select(.id=="T3.5")`（note/scope/acceptance 即验收契约）。
> 用户裁决（2026-11-16，本任务书已内联，无需再问）：
> ① 接受「活视图 = 源画布后续内容实时暴露给持链接者」的隐私影响，但**必须**配套分享开关 + 撤销；
> ② 分享开关**默认关**，显式开启才生成链接，关闭即撤销；**过期时间不做**（记遗留归口 T3.3）；
> ③ 轮询 **3s + ETag/304**，页面隐藏暂停，失败指数退避 3→6→12→30s 封顶并提示「与源画布同步中断」；
> ④ 旧 `.govio/shares/*.json` 快照记录**不必保留**——直接废弃，不迁移、不做只读兼容。

## 1. 背景与动机

用户实测（2026-11-15）：打开 `http://localhost:5173/share/6d6aa27396782536ecad2be1a3ac5597` 与主画布「差异太大 / 缺节点」。主会话取证四条根因（详见 task-plan T3.5 `note` 字段，务必先读）：

- **(a) 快照陈旧**：该链接是 17:06:50 的 ShareRecord 快照（5 节点 3 边），源画布 18:10 已有 7 节点；
- **(b) 重点分享不重生成**：`src/components/Chat/ChatPanel.tsx` 的 `handleShare` 首行 `if (shareUrl) { copy; return; }` 短路——加完节点后再点分享只重复复制**旧链接**，除非刷新页面清掉组件 state；
- **(c) 渲染保真度缺口**：`src/components/Share/ShareView.tsx` 对所有节点类型都用自写简化卡片 `ShareNodeCard`（仅类型徽标 + 标题 + SQL 前 3 行 + 「含 Manifest」一行），**图表完全不渲染**（Plotly 不出现）、无表结构字段、无 X18 口径徽标、无输出列、无边 label 详情；
- **(d)** 五类真实节点组件都 `import { useCanvasStore }`，复用需要只读适配层（见 §3 陷阱）。

用户据此裁决：**重新定义只读分享**——基于主 session 指纹 token 的画布**活视图**，与 session 保持一致、**不考虑分享时点的不变性**、渲染方式与主画布一致、**不做快照**、内容随主 session 变化（轮询）。不变性职责转移给重做的 `/export`（T3.6），配套导入能力为 T3.7（**均不在本任务**）。

## 2. 先读清单（按序）

1. `AGENTS.md`、`.pi/APPEND_SYSTEM.md`
2. `docs/task-plan.json → .phases[].tasks[] | select(.id=="T3.5")` 的 **note / scope / acceptance 全文**（note 里有主会话取证明细）
3. `docs/tasks/T3.2-sharing-fork/design.md`（现行分享/fork 设计与**三层只读实现**：视图层 / 连接层不建 /ws / API 层无写入口）——本任务是**取代**其快照语义，三层只读纪律必须继承
4. `docs/tasks/T3.2-sharing-fork/CHANGES.md` + `verification.md`（现有断言在哪、锁了什么行为）
5. `docs/tasks/T3.1-canvas-team-storage/design.md`（存储抽象、sidecar 命名、`.storage.json` 绑定、凭据边界）
6. `docs/tasks/BUGFIX-share-link-port.md`（X25，**已合入 main**）——`src/utils/share-link.ts` 的 `apiBaseFrom()` / `shareLink()` 是链接与 API 基址的**唯一正确构造方式**，其「影响面与遗留」4 条中第 2 条与本任务直接相关
7. `server/share.ts`（337 行：`ShareRecord` / `newShareId` / `createShare` / `resolveShare` / `extractManifests` / `readCanvasForkMeta` / `forkShare` / `readStagedFork` / `consumeStagedFork` / `shareViewPayload` / S3 `putRemoteShare`·`getRemoteShare`·`findRemoteShare`）
8. `server/share-api.ts`（203 行：`handleShareApi`，路由见 §3）
9. `src/components/Share/ShareView.tsx`（273 行，本任务主改文件）
10. `src/main.tsx`（19 行全文，分享路由正则 `/^\/share\/([a-f0-9]{32})\/?$/`）
11. `src/store/canvas-store.ts`（610 行，重点：`persist` 配置在文件尾 `name: 'govio-canvas-state'` + `partialize`；`hydrateSession` 在 542 行；`subscribeToCanvas` 在 364 行）
12. `src/components/Nodes/`（`SourceTableNode` / `SQLQueryNode` / `DataFrameNode` / `ChartNode` / `ReportNode` + `SQLModal` / `ManifestDetails` / `RerunStatus` / `ChartErrorBoundary` / `use-plotly.ts`）
13. `src/components/Chat/ChatPanel.tsx`（`handleShare` 约 68-96 行 + 分享按钮约 148-156 行）
14. `server/session-history.ts`（`getSessionDir()` = `<cwd>/.govio/sessions`；`listSessions()`；`assertValidSessionPath()`；`deleteSession()` 第 67-79 行——**sidecar 同生命周期删除**，新增 sidecar 必须挂进去）
15. `server/storage/paths.ts`（`canvasPathFor` = `<session>.canvas.json`、`storageBindingPathFor` = `<session>.storage.json`；新 sidecar 路径函数**加在这里**保持单一来源）
16. `docs/specs/02-nodes.md`、`docs/specs/06-backend.md`（路由表）、`docs/specs/07-websocket-protocol.md`（X2 契约与 `PROTOCOL_VERSION` 决策口径）、`docs/USER-MANUAL.md`

## 3. 实证事实（主会话已取证，避免你重复踩坑）

**现状 API 路由**（`server/share-api.ts`）：`POST /api/shares`（76 行，建快照）、`GET /api/shares/<token>`（101 行）、`POST /api/shares/<token>/fork`（114 行）、`POST /api/shares/<token>/rerun`（127 行）；同文件还有 `/api/canvas-storage` GET/POST（155/165 行，**不属本任务，别动**）。请求体上限 `MAX_BODY_BYTES = 1MB`（38 行）。

**sidecar 全集**（`<session>.jsonl` 为 pi transcript，同目录 `.govio/sessions/`）：`.canvas.json`（画布）、`.audit.jsonl`（权限审计 T1.3）、`.injection.jsonl`（注入留痕 T2.1）、`.storage.json`（S3 绑定 T3.1）。另有 1 个孤儿 `.injection.zip`（旧格式残留，与本任务无关）。

**⚠️ 陷阱 1（最危险，务必处理）：`useCanvasStore` 带 `persist`**
`src/store/canvas-store.ts` 尾部 `persist(..., { name: 'govio-canvas-state', partialize: {nodes, edges, referencedNodes} })`。`/share/<token>` 与主界面**同源**，共享同一 localStorage。若你把远端画布灌进这个单例 store 而不中和持久化，**远端画布会被写进 `govio-canvas-state`**，用户下次打开主界面会 rehydrate 成「别人的画布」，静默顶掉本机画布——这是数据损坏级 bug。
必须：在 /share 分支**任何 `set()` 之前**中和持久化（如 `useCanvasStore.persist.setOptions({ storage: <内存/空实现> })`），并给出**自动化断言**：/share 页全流程结束后 `localStorage['govio-canvas-state']` 未被写入/未被改写。

**⚠️ 陷阱 2：store 在模块导入时即从 localStorage 同步 rehydrate**
即 /share 页一加载，单例 store 里已经是**本机用户的画布**。若远端 fetch 未完成/失败就渲染，会**闪现本机画布**（反向隐私泄漏）。必须：远端数据到达前渲染显式 loading 态，到达后整体替换；失败渲染错误态；**任何时刻不得渲染本机 localStorage 里的节点**。给出断言。

**⚠️ 陷阱 3：节点卡片内含会触发副作用的操作入口**
五类节点组件不只是展示——卡片内有预览 / 复跑 / 删除 / SQL 编辑等按钮，会调 store action 或打 `POST /api/preview`、`POST /api/rerun-dataframe`、`POST /api/execute-sql` 等 HTTP 接口，而这些接口作用于**服务端当前会话单例**（即源实例），构成对源 session 的写/执行副作用，违反只读纪律。
必须：新增只读上下文（建议 `ReadOnlyCanvasProvider` + `useReadOnlyCanvas()`，默认 `false` 以保证主界面零行为变化），让节点组件在只读态**隐藏/禁用所有副作用入口**；ReactFlow 侧 `nodesDraggable/nodesConnectable/elementsSelectable` 全关（ShareView 211 行已有基础）；并给出**自动化断言：只读页不存在任何写回源 session 的路径**（枚举所有 mutating 端点，断言只读页代码路径不触达）。

**⚠️ 陷阱 4：`ShareView.tsx` 自带一份 `apiBase()`（19-23 行）仍是「页面端口 +1」硬编码**
X25 只修了 ChatPanel 侧，`ShareView` 的这份是 X25 遗留 2 明确点名的残留之一。本任务既然要改 ShareView 的轮询请求，**必须**一并改用 `apiBaseFrom(window.location.origin) ?? ''`（生产单端口同源时退回相对路径）。同理检查 127 行那处 `fetch('/api/shares/...')` 相对路径写法，统一到同一构造方式。

**token 解析的设计约束（关键，别设计成不可实现的方案）**
token 由 session 指纹派生 ⇒ **hash 不可逆**，服务端无法从 token 直接算出 session 文件。解析只能是：枚举 `.govio/sessions/*.jsonl` → 只保留**分享已开启**的 → 逐个算指纹 → 匹配。n 很小（本机 23 个 session），可接受；建议加缓存并按 sessions 目录 mtime 失效。**分享开关天然就是访问控制**：无 `.share.json` 或 `enabled:false` 的 session 其 token 不可解析。

**分享开关天然可撤销**：撤销 = 关闭/删除该 session 的 share sidecar，之后 token 解析不到 → 链接立即失效。无需独立黑名单。

**X25 已闭合的依赖**：`dependsOn: ["T3.2","X25"]` 两项均已 `accepted` 并在 main 上；`src/utils/share-link.ts` 与 `tests/integration/share-link.test.ts`（11 例）已存在，**直接复用，不要另写一套链接构造**。X25 遗留 1（旧 `:5174/share/<token>` 链接不自愈）与本任务裁决 ④ 叠加后结论一致：旧链接一律失效。

**当前验证基线（派发时 main = `51f5ebc`，主会话已独立复跑全绿）**：脚本断言 **671**（manifest 92 / rerun 71 / audit 119 / export 148 / source-table 39 / semantic-lineage 54 / caliber-conflict 77 / cwd 13 / prompt-injection 58）；vitest integration **21 文件 289 例**；UI **4 文件 37 例**。

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **token 形态**：由主 session 指纹派生、**保持 32 位小写 hex**（`src/main.tsx:9` 正则 `[a-f0-9]{32}` 无需改动）。建议 `sha256("govio-share-v1:" + <sessionId>)` 取前 32 hex（域分隔前缀防跨用途碰撞；`sessionId` = session 文件 basename 去 `.jsonl`）。在 design.md 论证防猜测性（session id 含 ms 时间戳 + 128-bit uuid，原像空间不可枚举）。**同一 session 的链接恒定**——这从根上消除 §1(b) 的陈旧链接短路缺陷，需专门回归断言（模拟「生成链接 → 画布新增节点 → 再次点分享」，断言链接不变且内容变新）。
2. **分享开关 sidecar**：新增 `<session>.jsonl.share.json`，形如 `{ version:1, enabled:boolean, enabledAt:string, token:string }`；路径函数加进 `server/storage/paths.ts`（保持单一来源）；`server/session-history.ts` 的 `deleteSession()` 挂上同生命周期删除。开关**默认关**（无 sidecar 即未开启）。仅本地，不随 T3.1 同步到 S3（见第 6 项）。
3. **API 重做**（`server/share-api.ts` + `server/share.ts`）：
   - `GET /api/share-state` → 当前会话的 `{ enabled, token }`（供 UI 渲染开关状态；拿不到会话文件 → 409，与既有纪律一致）
   - `POST /api/shares` → **开启**当前会话分享，**幂等**（重复调用返回同一 token）
   - `DELETE /api/shares` → **撤销**（关闭开关），幂等
   - `GET /api/shares/<token>` → 返回**当前**画布活视图载荷（不再写快照文件）；带 **ETag**（画布内容 hash），支持 `If-None-Match` → **304**；token 未开启/不存在 → **404 + `{error:"share-not-found"}`**
   - `POST /api/shares/<token>/fork` → **保留**，改为从当前活画布 stage（沿用 `.govio/forks/<forkId>.json` + `forkFrom` 派生血缘机制）
   - `POST /api/shares/<token>/rerun` → **删除**（含 UI 入口）。依据：scope 第 5 项要求只读页禁止复跑；活视图语义下「动手」一律走 fork。这是**有意的功能削减**，见第 9 项对账要求。
   - **去快照化**：`createShare` 不再写 `.govio/shares/*.json`；`resolveShare` 改为按 §3「token 解析约束」读**当前** session sidecar；`extractManifests` / `readCanvasForkMeta` / `shareViewPayload` 尽量复用。
   - **废弃旧快照**：代码不再读写 `.govio/shares/`；`ShareRecord` 类型与 `SHARE_RECORD_VERSION` 等若失去消费者则删除。**不做迁移、不做只读兼容**（裁决 ④）。旧 token（随机 32-hex）解析不到 → 404，前端给明确失效文案。
4. **轮询同步**（`ShareView.tsx`）：间隔 **3s**；带 `If-None-Match`，命中 **304 或指纹未变则不重渲染**（断言渲染次数不增）；`document.visibilitychange` 隐藏时**暂停**、恢复时立即拉一次并重启计时；失败**指数退避 3→6→12→30s 封顶**并显示「与源画布同步中断」提示，恢复后清除提示并复位退避；组件卸载清理定时器。**轮询走 HTTP**，不新增 WS 消息类型 ⇒ **`PROTOCOL_VERSION` 保持 1**（若你判断必须动 WS，先在 design.md 论证并按 X2 契约走，不要静默 bump）。
5. **高保真渲染**：只读视图复用主画布五类 nodeTypes 与同一套边渲染（语义边样式、X13/X15 关系详情、X18 口径徽标、Plotly 懒加载 chunk）。**推荐实现（可在 design.md 提出更优方案并论证）**：单例 `useCanvasStore` 灌入远端数据 + 按 §3 陷阱 1 中和 persist + 新增只读上下文隐藏副作用入口（§3 陷阱 3）。备选：把五类节点拆 presentational + container。**无论选哪个，chart 节点必须真渲染出 Plotly 图**（不是文字卡片），且 X3 的 plotly 懒加载拆分不得回退（记录 bundle 前后对比）。
6. **与 T3.1 S3 绑定的关系（design.md 必须给结论）**：**推荐口径**——活视图只读**本地当前 session sidecar**；绑定 S3 的画布其远端工件**不参与**活视图；跨实例分享（目标实例读源实例远端画布）**不在本期**，记遗留归口 T3.3/T3.4。share sidecar 亦仅本地。若你发现该口径与既有代码冲突，在 design.md 说明并给最小修正。
7. **ChatPanel 分享入口改造**：`handleShare` 去掉 `if (shareUrl) { copy; return; }` 短路；按钮改为**开关语义**（开启 / 已开启可复制 / 撤销），状态来自 `GET /api/share-state`；链接一律用 `shareLink(path, window.location.origin)` 构造（X25 模块），API 调用一律 `apiBaseFrom(origin) ?? ''`；开启时明确提示**「链接内容随源画布实时变化」**（隐私告知，见第 10 项）。
8. **测试**（放既有基建：`tests/integration/*.test.ts` 走 vitest；纯函数逻辑优先下沉 `src/utils/` 或 `server/` 以便 Node 侧断言，参照 X25 的取舍）：
   - 只读接口返回**当前**画布（源改动后立即可见，非旧快照）
   - 304 / 指纹未变**不重渲染**；页面隐藏暂停轮询；断连退避并提示
   - **只读纪律**：只读页无任何写回源 session 路径（枚举 mutating 端点断言不触达）；`localStorage['govio-canvas-state']` 未被写（§3 陷阱 1）；不闪现本机画布（§3 陷阱 2）
   - 真实节点组件在只读视图渲染，含 **chart 节点出 Plotly 容器**
   - token 恒定性 + 开启/撤销后可解析性（撤销后 404）；`POST /api/shares` 幂等
   - fork 仍产 `forkFrom`（含链式传承、抗 autosave 两条 T3.2 既有断言不得回退）
   - 分享链接 origin 反向断言（复用 X25 的 11 例思路，锁死不得由 API 基址拼出）
9. **断言数对账（因删 rerun 路由会有意减少，必须逐项列明）**：`verification.md` 给出「删前 → 删后」逐项对账表：删除了哪些用例（文件名 + 用例名 + 数量）、新增了哪些、净变化。**其余既有断言零回归**。最终报出脚本 / vitest integration / UI 三组新数字供主会话更新 `verificationBaseline`。
10. **文档**：`docs/specs/02-nodes.md`（只读视图渲染口径与只读上下文）、`docs/specs/06-backend.md`（路由表增删：`/api/share-state`、`DELETE /api/shares`、活视图 `GET` 的 ETag/304、移除 `/rerun`；轮询契约）、`docs/specs/07-websocket-protocol.md`（确认 `PROTOCOL_VERSION` 未变的结论）、`docs/USER-MANUAL.md`（**分享语义变更**：链接内容随源画布变化 + 隐私影响显著告知 + 开关/撤销用法 + **旧链接一律失效**）、`docs/tasks/T3.2-sharing-fork/design.md` 顶部加一行标注「快照语义已被 T3.5 取代」。
11. **三件套**落盘 `docs/tasks/T3.5-live-share-view/`：`design.md`（token 派生与解析方案、只读渲染方案取舍与 bundle 对比、persist 中和方案、S3 结论、复跑削减理由、**「遗留问题」小节**）、`CHANGES.md`（文件清单 + 每处摘要，含删除项）、`verification.md`（验证命令 + 关键输出 + 断言对账表 + **人工目视对照记录**：只读页与主画布并排的截图或逐项文字描述，覆盖五类节点）。

## 5. 范围纪律（明确不做）

- **不做 T3.6（/export 打包）与 T3.7（导入）**——即使顺手也不要碰 `src/commands/export-session.ts`、`src/utils/export-report.ts`、`CanvasToolbar` 的导出报告按钮；`verify:export` 的 **148 项断言必须零改动零回归**
- **不做 T3.3（SSO/多用户隔离）、T3.4（Docker/port+1 全仓收敛）**：本任务只把 **ShareView 侧**的 `apiBase()` 改用 X25 模块；`useChat` / `canvas-service` / `canvas-store` 里的 port+1 残留**不要动**（X25 遗留 2 归口 T3.4）
- **不做分享链接过期时间**（裁决 ②，记遗留）
- **不动 `/api/canvas-storage`**（T3.1 绑定接口）与 S3 后端实现；不动 `server/storage/s3-*.ts`
- 不动 `/ws`、`/canvas` 通道语义；**不 bump `PROTOCOL_VERSION`**（除非 design.md 论证充分并按 X2 契约走）
- 不重构与本任务无关的 store / 节点组件逻辑；不改节点数据契约（`src/types/index.ts`）形状
- **不改 `docs/task-plan.json`**（状态与 `verificationBaseline` 由主会话验收时统一记账；你只在 `verification.md` 报出新数字）
- 不新增除本任务必需之外的依赖；本任务**预期零新增 npm 依赖**（Node 内置 `crypto` 足够做 sha256）
- 新发现一律写 `design.md`「遗留问题」，不顺带修

## 6. 环境与协议

- **第一步（必做，只读校验即可）**：确认 `.agents/` 已就位——`ls .agents/skills/` 应列出 **9** 个目录（govio / govio-eda / govio-meta / govio-observe / govio-query / govio-reconcile / moli-cdp-server / moli-webfetch / moli-websearch）。它被 gitignore（`.gitignore` 的裸 `skills` 模式命中 `.agents/skills/`，故 `git status` 不显示它属正常），fresh worktree 本不含，**本次已由主会话在 setup 跑完后预置**，所以你只需校验、**不要重复复制**；仅当不足 9 个时才补 `cp -r /d/Work/gov-io/govio-map/.agents ./`（约 350K/44 文件）。
  背景（避免你误判环境）：2026-11-17 的首次派发（worktree `t35-live-share`）因 Orca 的 setup 完成哨兵 `__ORCA_SETUP_COMPLETE__` 丢失，该 worktree 的 exec helper 对**任何**命令永久报 `helper_unknown_error: setup refresh had errors`（harness 在建进程前就拒绝，命令根本没执行），整轮零进展报废；Orca 无重跑 setup 的动词，只能弃用重建。你现在这个 worktree 的 setup 健康已由主会话预先验证过（`node_modules` 关键 bin 齐全 + `npm ls --depth=0` 干净）。预置 `.agents/` 是为了让你起手即可开工，不必在 setup 刚结束的窗口做大批量 I/O。
- **`package-lock.json` 若显示 ` M`**：那是 setup hook 把 lockfile 的 `version` 从 `0.7.0` 同步到 `0.7.2`（仓库既有漂移，X20 升版本时漏改 lockfile），**不是你的改动、也超出 T3.5 范围**。开工前执行 `git checkout -- package-lock.json` 还原，让你的 commit 只含 T3.5 改动；并在 `design.md`「遗留问题」记一条（T3.6 引 zip 依赖跑 `npm install` 时会自然吸收这个版本同步）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪，repo setup hook 是 `npm install`）。同一 worktree 只有你一个写者；只 `git add` 你自己的改动，**禁止 `git add -A` 之外还顺手 commit 他人文件**
- **不切分支、不 push**（主会话负责 PR）
- **Windows Git Bash 约定**：路径统一正斜杠（`D:/Work/...`）、**路径末尾不要以反斜杠结尾**（会吞掉后续引号导致 `unexpected EOF`）；`python` 指向 Windows Store 存根**不可用**（用 `node` / `tsx`）；JSON 解析用 **`jq`**
- **禁止用 `head`/`tail`/`sed`/`grep` 截断 `govio-cli` 输出**（本任务基本不碰 govio-cli，若碰则遵守）
- commit：**单次 commit**，message 前缀 `T3.5: ...`
- 验证门槛（全绿才算完成，**禁止虚报**）：`npm run build`、`npm run lint`、`npm run verify`；基线见 §3 末尾（脚本 671 / vitest 21·289 / UI 4·37）——除第 4.9 项列明的 rerun 削减外**零回归** + 新增用例；verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态；完成置由主会话写
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成/受阻也发（`--outcome failed` / `blocked`）。**只在终端写汇报而不发信号 = 任务未结**
- 收到 `send` 消息时若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话，不要自行猜测产品决策

## 7. 时间预算

- 总预算 **150 分钟**（`--timeout-ms 9000000`）
- **到期前 15 分钟为 checkpoint 点**（≈135min）：未完成则 commit 已改文件 + 三件套现状（前缀 `T3.5: WIP ...`），如实汇报「已改文件 / 验证状态 / 剩余工作」。**超时不是变更安全边界**——宁可 checkpoint 也不要留半成品未提交
- 建议节奏：读档 ≤20min → token+sidecar+API 去快照化 ≤35min → 只读渲染与 persist 中和 ≤40min → 轮询 ≤20min → 测试 ≤25min → 三件套与文档 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/T3.5-live-share-view/{design.md,CHANGES.md,verification.md} + <代码文件摘要>
commit: <hash> <message>
token: 派生方式=<一句话>；恒定性断言=<通过?>；旧链接失效行为=<404+失效文案?>
只读渲染: 方案=<单例store+persist中和 / 展示层拆分>；chart 出 Plotly=<是/否>；bundle 对比=<主chunk/plotly chunk 前后>
只读纪律: localStorage 未写=<断言通过?>；不闪现本机画布=<通过?>；无写回源 session=<通过?>；rerun 路由已删=<是/否>
轮询: 间隔=3s；304 不重渲染=<通过?>；隐藏暂停=<通过?>；退避 3→6→12→30s+提示=<通过?>
S3 结论: <一句话>
API 变更: 新增=<...>；删除=<...>；PROTOCOL_VERSION=<1 未变 / 变更理由>
断言数: 脚本 671 → <k>（删除逐项 + 新增逐项）；vitest 21·289 → <..>；UI 4·37 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
人工目视: <只读页与主画布对照结论一句话，详情在 verification.md>
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），**禁止虚报验证结果**。

## 9. subagent 执行模式补充（2026-11-17 改派：pi subagent，**覆盖** §6/§8 中的 Orca 专属条目）

本任务改由 **pi subagent（`worker` agent）在主仓 checkout 直接执行**，不走 Orca worktree。§1-§5、§7 全部照旧，以下条目覆盖 §6/§8 的对应表述：

1. **工作位置**：`D:/Work/gov-io/govio-map`（主仓 checkout，非 worktree）。主会话已创建并切到任务分支（分支名见派发 brief），基于含本 §9 的 main。**不切分支、不 push、不建 PR**（PR 由主会话创建、用户合并）。同一时刻只有你一个写者。
2. **环境已就位，不要重装**：`node_modules/`（`.bin` 102 项）与 `.agents/skills/`（9 个目录）均已存在——**不要跑 `npm install`**、不要复制 `.agents/`，只做一次只读校验（`ls .agents/skills | wc -l` 预期 9）。§6 第 1 条关于 Orca setup 哨兵与 `helper_unknown_error` 的背景与你无关，可整段跳过。
3. **`package-lock.json`**：§6 第 2 条的 setup hook 漂移在本次不适用（无 setup hook）。开工前 `git status --porcelain` 应为空；若意外出现 `package-lock.json` 改动，`git checkout -- package-lock.json` 还原、**不要提交它**，并在 design.md「遗留问题」记一条。本任务预期**零新增 npm 依赖**（§5 已明）。
4. **提交纪律**：commit 前用 `git status --porcelain` 逐条核对，只 `git add` 你自己的改动（`.agents/`、`node_modules/`、`.govio/`、`.pi/`、`dist*/` 均已被 `.gitignore` 覆盖，正常不会出现）；**单次 commit**，message 前缀 `T3.5: ...`。
5. **汇报方式（覆盖 §6 末两条与 §8 结尾）**：**环境里没有任何 orca 命令**——不要执行 `orca orchestration send/ask`。阻塞或遇到未裁决的产品决策时用 `contact_supervisor`（`reason:"need_decision"`，发出后**等回复**再继续）；非阻塞进度用 `reason:"progress_update"`（简短）。完成时把 §8 的 ≤15 行摘要作为**最终回复正文**返回，不要以问题结尾。
6. **不改 `docs/task-plan.json`**：状态、history、`verificationBaseline` 全部由主会话验收时统一记账（你只在 `verification.md` 报出三组新数字）。
7. **时间预算照 §7**：150 分钟。harness 会在到期前约 15 分钟投递 checkpoint 提示，收到即按 §7 落 `T3.5: WIP ...` commit（含三件套现状）并如实汇报「已改文件 / 验证状态 / 剩余工作」。
