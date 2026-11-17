# T3.5 交付文件清单

单次 commit，message 前缀 `T3.5: `。设计与取舍见 `design.md`，验证与断言对账见 `verification.md`。

## 新增（源码）

| 文件 | 摘要 |
|---|---|
| `src/types/share.ts` | 活视图线上载荷的**前后端共享类型**：`CanvasForkFrom`、`ShareManifestEntry`、`LiveSharePayload`（含 `etag`）、`ShareStatePayload`、`ShareTogglePayload`、`SHARE_NOT_FOUND_ERROR`。与 `src/types/manifest.ts` 同款共享约定。 |
| `src/utils/share-poll.ts` | 轮询纯逻辑：`SHARE_POLL_INTERVAL_MS=3000`、退避阶梯 `SHARE_POLL_BACKOFF_MS=[3000,6000,12000,30000]`、`SHARE_SYNC_LOST_MESSAGE`、`sharePollDelayMs()`、`createSharePoller()`（定时器与可见性可注入，node 环境可断言）。 |
| `src/hooks/useReadOnlyCanvas.ts` | `ReadOnlyCanvasContext`（默认 `false` ⇒ 主画布零行为变化）+ `useReadOnlyCanvas()`。 |
| `src/components/Share/canvas-persistence.ts` | `neutralizeCanvasPersistence()`（把 persist 的 storage 换成内存空实现，陷阱 1）+ `isCanvasPersistenceNeutralized()`。独立成模块以保持 `ShareView.tsx` 只导出组件。 |
| `src/components/Chat/ShareToggle.tsx` | 分享**开关**组件：状态来自 `GET /api/share-state`；开启 `POST /api/shares`（幂等）；撤销 `DELETE /api/shares`；浮层内常驻隐私告知 `SHARE_LIVE_NOTICE`；链接一律 `shareLink(path, window.location.origin)`、API 一律 `apiBaseFrom(origin) ?? ''`。 |

## 新增（测试）

| 文件 | 用例数 | 摘要 |
|---|---|---|
| `tests/integration/share-live.test.ts` | 21 | 取代 `share-fork.test.ts`。token 派生/形状/域分隔、开关默认关与幂等、撤销即失效、坏 sidecar、旧随机 token 404、`deleteSession` 级联、活视图返回当前画布且不产生 `.govio/shares/`、etag 与 `ifNoneMatchHits`、空画布不是 404、只读纪律（源 sidecar 字节+etag 恒定）、凭据不外泄、四条 HTTP 路由（含 304 / 404 / 405）、rerun 路由已删、CORS 放行、fork 血缘三例。 |
| `tests/integration/share-poll.test.ts` | 10 | 退避阶梯 3→6→12→30→30 封顶、中断文案、3s 基准、304 不回调 `onPayload`、etag 传递、失败退避+只报一次中断+恢复复位、`fetchView` 抛异常不炸、404 终止轮询、隐藏暂停/恢复立即拉一次、`stop()` 清定时器并解绑。 |
| `tests/ui/share-view.test.tsx` | 13 | 陷阱 1（localStorage 逐字节未被改写）、陷阱 2（pending/失败/404 三条路径都不闪现本机画布）、五类节点真渲染（表结构字段、SQL 高亮、列结构、报告正文、chart 标题）、**chart 真出 Plotly**（懒加载模块被调用且收到节点 config）、`nodeTypes` 复用主画布且不再自带简化卡片、陷阱 4（`apiBaseFrom` + 无自带端口 +1）、只读纪律（副作用按钮全不渲染 / 点遍画布内按钮零请求 / store 未被改）、不建 `/ws`、304 不再 hydrate（fake timers 驱动 3s 轮询）、卸载停止轮询、ReactFlow 交互关死。 |
| `tests/ui/share-toggle.test.tsx` | 7 | 默认关且状态来自 `/api/share-state`、服务端已开启时初始即开启态、`disabled` 透传、开启后链接用页面 origin 且带隐私告知（X25 反向断言）、已开启时再点只展开浮层不发请求（**无 T3.2 短路缺陷**）、撤销 → DELETE → 重新开启得到同一链接（token 恒定）、开启失败给错误提示不假装成功。 |

## 修改（源码）

| 文件 | 摘要 |
|---|---|
| `server/share.ts` | **重写**：删除 `ShareRecord`/`SHARE_RECORD_VERSION`/`parseShareRecord`/`shareViewPayload`/`getSharesDir`/`localSharePath`/`newShareId`/`createShare`/`resolveShare`/`putRemoteShare`/`getRemoteShare`/`findRemoteShare`/`remoteShareKey`/`ShareTransport`/`setShareTransportFactoryForTests`（快照与远端 share 机制整体废弃）。新增 `deriveShareToken`/`SHARE_TOKEN_DOMAIN`/`SHARE_STATE_VERSION`/`LIVE_SHARE_VERSION`/`ShareState`/`readShareState`/`shareStateOf`/`enableShare`/`disableShare`/`resolveShareToken`（含目录 mtime 索引缓存 + `clearShareIndexCache`）/`liveShareEtag`/`ifNoneMatchHits`/`liveShareRecord`/`liveShareView`/`newForkId`。保留并改造 `extractManifests`、`readCanvasForkMeta`、`forkShare`（改为从**当前活画布** stage）、`readStagedFork`、`consumeStagedFork`、`getForksDir`、`FORK_ID_RE`、`SHARE_ID_RE` 再导出；`CanvasForkFrom`/`ShareManifestEntry` 改为从 `src/types/share.ts` 导入再导出。 |
| `server/share-api.ts` | 路由重做：新增 `GET /api/share-state`、`DELETE /api/shares`；`POST /api/shares` 从「建快照」改为「幂等开启」；`GET /api/shares/<token>` 改为活视图 + `ETag`/`Cache-Control: no-store` + `If-None-Match`→304，404 统一 `{error:"share-not-found"}`；**删除 `POST /api/shares/<token>/rerun`**（连同 `rerunDataFrame` import 与 `readJsonBody` 的该处调用）；`POST .../fork` 保留；`/api/canvas-storage` GET/POST **原样未动**。移除 `export type { ShareRecord }`。 |
| `server/storage/paths.ts` | 新增 `shareStatePathFor(sessionFile) = sessionFile + ".share.json"`（sidecar 路径单一来源）。 |
| `server/session-history.ts` | `deleteSession()` 级联删除分享开关 sidecar（内联 `unlinkSync(shareStatePathFor(...))`，与 `.storage.json` 同款；不从 `share.ts` 反向 import，避免循环依赖）。 |
| `server/security.ts` | `corsHeadersFor`：Allow-Methods 加 `DELETE`、Allow-Headers 加 `If-None-Match`、新增 `Access-Control-Expose-Headers: ETag`。Origin 白名单逻辑未动（见 design.md §9）。 |
| `src/components/Share/ShareView.tsx` | **重写**：删除自写简化卡片 `ShareNodeCard`/`TYPE_BADGES`、复跑按钮与 `reruns` 本地态、自带 `apiBase()`（陷阱 4）。改为：首行中和 persist → 3s 轮询（ETag/304、隐藏暂停、退避+中断提示、404 失效页）→ `hydrateSession` 整体替换 → 用主画布 `nodeTypes` + `lineageEdgeDefaults('data')` + Background/Controls/MiniMap/LineageLegend 渲染，`ReadOnlyCanvasContext.Provider` 包住，`nodesDraggable/nodesConnectable/elementsSelectable` 全 false，不传 `onConnect`/`onNodesDelete`/`onEdgesDelete`/`onDrop`。右栏 Manifest 清单保留（去掉复跑按钮）+ 只读指引文案。API 基址改 `apiBaseFrom(window.location.origin) ?? ''`。 |
| `src/components/Nodes/SourceTableNode.tsx` | `useReadOnlyCanvas()`：只读态整条操作栏（引用/删除）不渲染。字段表、全限定名复制、表间关系（X13/X15）保留。 |
| `src/components/Nodes/SQLQueryNode.tsx` | 只读态隐藏 引用/编辑（SQLModal）/删除，禁掉双击就地编辑（`editing = isEditing && !readOnly`），`<pre>` 的 title 与空 SQL 占位文案改只读措辞。SQL 高亮、输出列、口径徽标（X18）、冲突详情（T2.3）、Manifest「详情」保留。 |
| `src/components/Nodes/DataFrameNode.tsx` | 只读态隐藏 引用/预览（`/api/preview`）/复跑（`/api/rerun-dataframe`）/删除；只剩「详情」时仍渲染操作栏，一个按钮都不剩时整条不渲染。列结构、RerunStatus 历史、Manifest 详情保留。 |
| `src/components/Nodes/ReportNode.tsx` | 只读态整条操作栏（引用/删除）不渲染；Markdown 正文与源引用标签保留。 |
| `src/components/Nodes/ChartNode.tsx` | 只读态隐藏 引用/删除；**Plotly 图本体与「放大」（ChartModal）保留** ⇒ 只读页 chart 真渲染出图。 |
| `src/components/Chat/ChatPanel.tsx` | 删除 `shareUrl`/`shareBusy` state 与 `handleShare`（含 `if (shareUrl) { copy; return; }` 短路）；改为渲染 `<ShareToggle disabled={!isConnected} />`；清掉不再使用的 `Share2`/`apiBaseFrom`/`shareLink` import。 |
| `src/main.tsx` | 仅注释更新（T3.2 快照 → T3.5 活视图）；路由正则 `[a-f0-9]{32}` **未改**。 |

## 修改（文档，§4.10 五处）

| 文件 | 摘要 |
|---|---|
| `docs/specs/02-nodes.md` | 文件结构表加 `src/hooks/useReadOnlyCanvas.ts`；新增「只读画布：分享活视图的渲染口径（T3.5）」小节（只读上下文用法 + 五类节点「隐藏/保留」逐项表 + 存储隔离必读）。 |
| `docs/specs/06-backend.md` | share 小节整节重写（路由表含新增/删除项、token 与开关 sidecar、活视图载荷与轮询契约、三层只读纪律、fork 血缘、前端接线）；`deleteSession` 级联补分享 sidecar；**CORS 小节纠错**（原写「完全开放 Allow-Origin: *」与代码不符，改为白名单回显 + DELETE/If-None-Match/ETag 放行说明）。 |
| `docs/specs/07-websocket-protocol.md` | 版本化小节加一条：T3.5 确认 `PROTOCOL_VERSION` 仍为 1、零契约变更（轮询走 HTTP、`/share/*` 不建 `/ws`、契约文件与计数不变）。 |
| `docs/USER-MANUAL.md` | 新增 `### 7.5 只读分享链接（活视图）`：显著隐私告知（内容随源画布实时变化、后续新增内容自动可见、链接无鉴权无过期）、开关/撤销/删会话行为表、链接恒定与轮询/退避表现、只读页能做与不能做、需要不变性请用导出、**旧链接一律失效**；FAQ 加两行（旧链接失效、只读页没有复跑按钮）。 |
| `docs/tasks/T3.2-sharing-fork/design.md` | 顶部加标注块：快照语义（§1 ShareRecord/`.govio/shares/`、§2 只读态复跑）已被 T3.5 取代并废弃删除；仍有效部分（三层只读、fork 血缘、WS 版本口径）与遗留闭合情况逐条说明。 |

## 删除

| 项 | 说明 |
|---|---|
| `tests/integration/share-fork.test.ts`（7 用例） | 快照语义测试整体删除；仍有效的行为（fork `forkFrom`、链式传承、抗 autosave、凭据不外泄、只读纪律）已在 `share-live.test.ts` 以活视图形态重建。逐项对账见 `verification.md`。 |
| `.govio/shares/*.json` 读写代码 | `getSharesDir`/`localSharePath`/`createShare` 的落盘与远端写、`resolveShare` 的本地记录读取全部删除；代码不再读写该目录（既有残留文件成为孤儿，不迁移不清理，见 design.md 遗留）。 |
| `ShareRecord` / `SHARE_RECORD_VERSION` / `parseShareRecord` / `shareViewPayload` | 失去消费者，按裁决 ④ 直接删除（不做只读兼容）。 |
| `ShareNodeCard` / `TYPE_BADGES`（ShareView 内） | 被主画布 `nodeTypes` 取代。 |
| `POST /api/shares/<token>/rerun` 及其 UI 入口 | 裁决 ⑥ 的有意功能削减，理由见 design.md §7。 |
| 远端 share 机制（`putRemoteShare`/`getRemoteShare`/`findRemoteShare`/`remoteShareKey`/`ShareTransport`/`setShareTransportFactoryForTests`） | 唯一消费者是快照记录；跨实例分享不在本期（design.md §8、遗留 1）。 |

## 未动（范围纪律核对）

- T3.6/T3.7 链路：`src/commands/export-session.ts`、`src/utils/export-report.ts`、`CanvasToolbar` 导出报告按钮 —— **零改动**（`verify:export` 148 项零变化）。
- `/api/canvas-storage` 与 `server/storage/s3-*.ts`（含成为死代码的 `shareKey()`，记 design.md 遗留 4）—— **零改动**。
- `useChat` / `canvas-service` / `canvas-store` 里的 port+1 残留（X25 遗留 2，归口 T3.4）—— **零改动**；本任务只改了 ShareView 侧那份 `apiBase()`，ChatPanel 侧本来就已用 X25 模块。
- `PROTOCOL_VERSION` 与 `src/types/ws-protocol.ts`、`src/types/index.ts` 的节点数据契约形状 —— **零改动**。
- `docs/task-plan.json` —— **零改动**（状态与 `verificationBaseline` 由主会话验收时记账）。
- `package.json` / `package-lock.json` —— **零改动，零新增 npm 依赖**（sha256 用 Node 内置 `crypto`）。
