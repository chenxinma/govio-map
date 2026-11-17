# T3.5 只读分享重定义：session 指纹 token 的画布活视图 · 设计

任务：`docs/task-plan.json → phases[2].tasks[] | select(.id=="T3.5")`（note / decisions ①-⑦ / scope / acceptance）。
任务书：`docs/tasks/T3.5-live-share-view/DISPATCH.md`。取代 `docs/tasks/T3.2-sharing-fork/design.md` 的快照语义。

用户裁决（2026-11-16，已内联进任务书，本设计不改口径）：① 接受活视图的隐私影响但强制配套开关+撤销；
② 开关默认关、关闭即撤销、不做过期时间；③ 轮询 3s + ETag/304、隐藏暂停、退避 3→6→12→30s；
④ 旧 `.govio/shares/*.json` 直接废弃，不迁移不兼容；⑤ token 由会话指纹派生且保持 32-hex、链接恒定；
⑥ 只读页删除复跑；⑦ 活视图只读本地 sidecar，S3 远端工件不参与。

---

## 1. 语义重定义：快照 → 活视图

| 维度 | T3.2（快照，已废弃） | T3.5（活视图，本设计） |
|---|---|---|
| 内容时点 | 分享那一刻固化，之后不变 | **永远是源会话当前画布**，随源画布实时变化 |
| token | `randomBytes(16).hex`，每次分享新建一条记录 | `sha256(域前缀 + sessionId)` 前 32 hex，**同一会话恒定** |
| 落盘 | `.govio/shares/<shareId>.json`（+ S3 远端副本） | **无任何快照文件**；只有开关 sidecar `<session>.jsonl.share.json` |
| 访问控制 | 令牌即读权限，无法撤销 | **开关 sidecar 即访问控制**：不存在/`enabled:false` 的会话其 token 解析不到 |
| 前端渲染 | 自写简化卡片 `ShareNodeCard`，图表完全不渲染 | **复用主画布同一套 `nodeTypes`**，chart 真渲染 Plotly |
| 只读页复跑 | `POST /api/shares/<token>/rerun` | **已删除**（见 §7） |
| 不变性交付物 | 分享链接 | 转移给 `/export`（T3.6）与「导出交付报告」（已存在） |

根因对照（DISPATCH §1）：(a) 快照陈旧 → 活视图从定义上消除；(b) `handleShare` 首行 `if (shareUrl) {copy; return;}`
短路复制旧链接 → token 恒定后「旧链接」这个概念不存在，且入口改成开关语义（§6）；(c) 渲染保真度缺口 →
复用五类节点组件（§4）；(d) 五类组件都依赖 `useCanvasStore` → 单例 store + persist 中和 + 只读上下文（§4/§5）。

---

## 2. token：派生、防猜测性与解析

### 2.1 派生

```ts
// server/share.ts
export const SHARE_TOKEN_DOMAIN = "govio-share-v1:";
export function deriveShareToken(sessionId: string): string {
  return createHash("sha256").update(`${SHARE_TOKEN_DOMAIN}${sessionId}`, "utf-8").digest("hex").slice(0, 32);
}
```

- `sessionId` = 会话文件 basename 去 `.jsonl`（= T3.1 的 `canvasId`，单一来源 `canvasIdFromSessionFile`）。
- **域分隔前缀**`govio-share-v1:`：避免「同一 sessionId 在别的用途上算出同一个 hash」的跨用途碰撞，也让
  token 原文不可能等于任何裸 sessionId；`-v1` 预留派生算法的版本位（将来换算法不撞旧 token）。
- **形状不变**：32 位小写 hex，`SHARE_ID_RE = /^[a-f0-9]{32}$/` 与 `src/main.tsx:9` 的分享路由正则
  `/^\/share\/([a-f0-9]{32})\/?$/` **零改动**（裁决 ⑤）。
- **零新增依赖**：只用 Node 内置 `crypto`。

### 2.2 防猜测性（论证）

sessionId 由 pi `SessionManager` 生成，形如 `2026-11-15T09-30-00-000Z_<uuid>`：毫秒时间戳 + 128-bit UUID。
攻击者要猜中一个有效 token，需要：

1. 猜中完整 sessionId（时间戳部分可缩小到「某天的某毫秒」，但 UUID 部分是 2^122 量级的不可枚举空间）；
2. 且该会话的分享开关处于开启态。

sha256 单向，从 token 反推 sessionId 等价于对 UUID 空间做原像搜索。**结论：与 T3.2 的 `randomBytes(16)`
（2^128）在同一安全量级**，没有因为「可派生」而降低强度——强度来自 sessionId 本身的熵，而不是随机数发生器。
需要说明的**取舍**：token 是 sessionId 的确定性函数，所以「同一会话撤销后重新开启，链接复活」是设计特性
（裁决 ⑤ 的链接恒定），不是漏洞；真正的访问控制是开关 sidecar（§3），而不是 token 的不可猜性。
本机单用户工具基线下这与 T3.2 的暴露面等价；跨用户/公网暴露仍需 T3.3 的 SSO 兜底（记遗留）。

### 2.3 解析（hash 不可逆 ⇒ 只能枚举匹配）

```
枚举 .govio/sessions/*.jsonl → 派生 token → 与请求 token 比对 → 命中后**现读** .share.json 确认 enabled
```

- 索引缓存只缓存**纯派生结果**（sessionId→token），按「sessions 目录路径 + 目录 mtime」失效；
  目录路径进 key 是为了测试 `process.chdir` 不串味。
- **`enabled` 一律现读 sidecar，不进缓存**：这是撤销必须立即生效的硬要求。开启会新建文件（改目录 mtime），
  但撤销后重新开启、或极端情况下 mtime 粒度不足，都可能让缓存判断失真；把「状态判断」放在缓存之外，
  缓存就只影响性能不影响正确性。n 很小（本机 23 个会话），一次 `readdirSync` + 至多一次小文件读，
  3s 轮询下开销可忽略——所以**没有**做「按 sidecar mtime 缓存 enabled」这类会引入一致性风险的优化。
- `assertValidShareId` 先过形状白名单，非法形状直接 404，不进枚举（也防路径穿越）。
- 未开启 / 已撤销 / 旧随机 token（T3.2 遗留，如用户实测的 `6d6aa27396782536ecad2be1a3ac5597`）
  全部走同一条 `null` 路径 → **404 `{error:"share-not-found"}`**，不区分「没有这个会话」与「分享已关闭」
  （不泄露会话存在性）。

---

## 3. 分享开关 sidecar：默认关、可撤销、随会话同生命周期

- 路径单一来源：`server/storage/paths.ts` 新增 `shareStatePathFor(sessionFile) = sessionFile + ".share.json"`
  ⇒ `<session>.jsonl.share.json`（与 `.canvas.json` / `.audit.jsonl` / `.injection.jsonl` / `.storage.json` 同目录）。
- 形状：`{ version: 1, enabled: boolean, enabledAt: string | null, token: string }`。
  `token` 冗余存一份是为了让 sidecar 自解释（人读/排障），**判等时仍与现算的派生 token 双向校验**，
  脏值（形状不符）回退到现算值，坏 JSON / `version` 不符一律视为「未开启」。
- **默认关**：无 sidecar 即未开启（裁决 ②）。`POST /api/shares` 幂等开启（重复开启返回同一 token、
  不刷新 `enabledAt`，避免链接语义漂移）；`DELETE /api/shares` 幂等撤销 = **删除 sidecar**。
  撤销选择「删文件」而不是「写 `enabled:false`」：文件不存在是最强的「未开启」信号，不留可被误读的残留。
- `server/session-history.ts` 的 `deleteSession()` 挂上同生命周期删除（与 `.storage.json` 同款内联 unlink，
  **不从 `share.ts` 反向 import**——避免 `session-history ← share ← session-history` 的循环依赖）。
- **仅本地**，不随 T3.1 同步到 S3（见 §8）。

---

## 4. 只读渲染方案取舍（DISPATCH §4.5）

### 4.1 选型：单例 store 灌入 + persist 中和 + 只读上下文（推荐方案）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（采用）** 单例 `useCanvasStore` + persist 中和 + `ReadOnlyCanvasContext` | 远端画布经 `hydrateSession()` 灌进同一个 store，五类节点组件原样复用 | 改动面最小（节点组件只加一个 `readOnly` 分支）；渲染保真度**天然 100%**（同一份组件、同一份边样式工厂）；代价是必须严格中和 persist（§5）并守住「远端数据到达前不渲染」 |
| B 独立只读 store 实例 | `createStore` 造第二个实例，节点组件改成接收注入的 store | 需要给五类组件全部引入 store 注入层（context/props 双通道），主画布也要跟着改；`useCanvasStore` 在组件里是直接 import 的单例，改造面等于重写节点层 |
| C 拆 presentational + container | 把展示部分抽成纯组件，主画布与只读页各自包一层 container | 最「干净」但工作量最大，且 X13/X15/X18/T2.3 这些细节散落在容器逻辑里，拆分过程极易造成两侧视觉漂移——恰好是本任务要消灭的问题 |

选 A 的决定性理由：**验收标准是「与主画布视觉一致」**，复用同一个组件对象是唯一能结构性保证这一点的做法
（测试里直接断言 `ShareView` import 的 `nodeTypes` 就是 `src/components/Nodes/index.ts` 导出的那份）。

### 4.2 具体接线

- `ShareView` 用 `<ReadOnlyCanvasContext.Provider value={true}>` 包住 `<ReactFlowProvider><ReactFlow …>`；
  `nodeTypes` / `defaultEdgeOptions={lineageEdgeDefaults('data')}` / `Background` / `Controls` / `MiniMap` /
  `LineageLegend` 与 `src/components/Canvas/Canvas.tsx` 同款 ⇒ 语义边样式、X13/X15 关系详情、X18 口径徽标、
  Plotly 懒加载 chunk 全部原样继承。
- **不传** `onConnect` / `onNodesDelete` / `onEdgesDelete` / `onDrop`（这些都是主画布的写入入口）；
  `nodesDraggable` / `nodesConnectable` / `elementsSelectable` 全 `false`。
  `onNodesChange` / `onEdgesChange` 保留接的是 store 的同名 action（ReactFlow v12 需要它落尺寸变更），
  但在只读页上它们收不到任何拖动/选择/删除类 change。
- `useReadOnlyCanvas()` 默认 `false` ⇒ **主画布零行为变化**（无 Provider 时读到默认值）。
  五类节点里被隐藏的入口：引用、删除、预览（`POST /api/preview`）、复跑（`POST /api/rerun-dataframe`）、
  编辑 SQL（SQLModal 会 `POST /api/execute-sql`）、双击就地编辑；
  保留的纯本地展示：字段/列结构展开、口径徽标与冲突详情、表间关系、Manifest「详情」、图表「放大」、
  全限定名复制。逐项清单见 `docs/specs/02-nodes.md`「只读画布」小节。
- 操作栏只剩「详情」时仍渲染，一个按钮都不剩时整条栏不渲染（不留空壳边框）。

### 4.3 bundle 前后对比（X3 plotly 懒加载拆分不得回退）

同一台机器、同一 `npm run build`，基线用 `git stash push -u` 回到 main `3901c03` 实测：

| 产物 | 改前（main 3901c03） | 改后（本任务） | 差 |
|---|---|---|---|
| `dist/assets/index-*.js`（主 chunk） | 1,454.31 kB（gzip 449.43） | 1,457.38 kB（gzip 450.79） | **+3.07 kB（gzip +1.36）** |
| `dist/assets/index-*.css` | 54.50 kB（gzip 10.22） | 53.91 kB（gzip 10.02） | **−0.59 kB**（删掉 `ShareNodeCard` 的样式） |
| `dist/assets/plotly.min-*.js` | **4,646.12 kB**（gzip 1,419.74） | **4,646.12 kB**（gzip 1,419.74） | **0 —— 懒加载 chunk 原样保留** |
| `dist/assets/sql-columns-*.js` | 2,436.98 kB | 2,436.98 kB | 0 |
| `dist/assets/export-report-*.js` | 43.13 kB | 43.13 kB | 0（T3.6 链路零改动） |

主 chunk 的 +3 kB 来自：ShareView 现在静态引入五类节点组件与 ReactFlow chrome（此前只引自写卡片）、
`share-poll.ts`、`ShareToggle.tsx`、只读上下文；plotly 仍是 `import('plotly.js-dist-min')` 的独立 chunk
（`ChartNode`/`ChartModal` 的懒加载路径未动），**拆分没有回退**。

---

## 5. persist 中和方案（DISPATCH 陷阱 1，数据损坏级）

**问题**：`src/store/canvas-store.ts` 尾部 `persist(..., { name: 'govio-canvas-state', partialize })`；
`/share/<token>` 与主界面**同源**，共享同一 localStorage。若把远端画布灌进这个单例 store 而不中和持久化，
远端画布会被写进 `govio-canvas-state`，用户下次打开主界面 rehydrate 成「别人的画布」，静默顶掉本机画布。

**方案**：`src/components/Share/canvas-persistence.ts`

```ts
useCanvasStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
```

- 为什么这样就够：zustand v5 的 persist 把 `set` 包成 `set(...) → setItem()`，`setItem` 走的就是
  `options.storage`；`setOptions` 只替换 `storage` 引用、**不触发 re-hydrate**（已核 `node_modules/zustand/esm/middleware.mjs`
  的 `api.persist.setOptions` 实现），所以换完之后的每一次写都落进内存空实现。
- `getItem` 恒返回 `null` 顺带堵住另一半风险：只读页不会把本机 localStorage 里的画布当成初始内容。
- **调用时机**：`ShareView` 组件体首行调用（幂等，模块级 `neutralized` 标志）。组件体早于所有 effect 与
  事件回调，而只读页上任何 `set()` 都发生在 effect（轮询回包 → `hydrateSession`）或用户交互里 ⇒
  「任何 `set()` 之前」成立。抽成独立模块而不是留在 `ShareView.tsx`，一是让 `ShareView` 保持
  「只导出组件」（`react-refresh/only-export-components`），二是让测试能直接断言中和状态。
- **主界面零影响**：`App` 分支永不 import 这个模块；`main.tsx` 的路由分支只渲染其中一个。
- 自动化断言：`tests/ui/share-view.test.tsx` 在 import 前用 `vi.hoisted` 把本机画布种进
  `localStorage['govio-canvas-state']`，跑完「加载 → 渲染五类节点 → 点遍按钮 → 轮询」全流程后断言
  **该 key 的字符串与种子逐字节相同**。

---

## 6. 前端：轮询、不闪现本机画布、开关入口

### 6.1 轮询（`src/utils/share-poll.ts`，纯逻辑 + 可注入）

`createSharePoller({ fetchView, onPayload, onSyncLost, onGone, schedule?, cancel?, visibility? })`
返回 `{ start, stop, failures, armed }`。定时器与可见性都可注入 ⇒ 在 **node 环境**（无 jsdom、无假定时器）
就能把节奏断言死，这是把逻辑下沉到 `src/utils/` 的主要理由（参照 X25 的取舍）。

- 基准 **3s**（`SHARE_POLL_INTERVAL_MS`）；
- **304 / 指纹未变不回调 `onPayload`**——`onPayload` 是只读视图唯一的渲染触发源（它里面才 `hydrateSession`
  + `setPayload`），所以「不回调」在结构上等价于「不重渲染」；
- 失败退避阶梯 `SHARE_POLL_BACKOFF_MS = [3000, 6000, 12000, 30000]`，`sharePollDelayMs(n)` 取第 n 档、
  超出封顶。**与裁决 ③ 的字面序列 3→6→12→30s 一致**（不是 `base*2^n` 再截断，那样第 4 档会是 24s）；
- 退避期间 `onSyncLost(true)` **只报一次**（去抖），恢复成功后 `onSyncLost(false)` 清除提示并把失败计数归零
  ⇒ 间隔回到 3s；UI 侧文案 = `SHARE_SYNC_LOST_MESSAGE`「与源画布同步中断」；
- `visibilitychange` 隐藏：取消已排定的定时器（`armed() === false`），期间不发任何请求；恢复可见：**立即拉一次**
  并重启计时。页面在隐藏状态下 `start()` 时仍发首拉（用户刚打开页面），但不排下一次；
- `fetchView` 抛异常（网络断）按 `error` 处理进退避，不会把轮询炸掉；
- `not-found`（404，分享被撤销）⇒ `onGone()` 并**终止轮询**（不再排定），UI 渲染「分享链接已失效」；
- `stop()` 清定时器 + 解绑 `visibilitychange`，`ShareView` 在 effect cleanup 里调用（卸载不留尾巴）。
- 请求侧：`If-None-Match: "<etag>"`（etag 取自上一次响应 body 的 `etag` 字段，见 §9 的 CORS 说明）、
  `cache: 'no-store'`；服务端响应 `Cache-Control: no-store`，所以 304 只来自显式协商，不会与浏览器缓存打架。

### 6.2 不闪现本机画布（DISPATCH 陷阱 2）

store 在**模块导入时**就同步 rehydrate 了本机画布，所以只读页一挂载 store 里就是本机节点。做法：

- `payload === null` 时**只渲染状态页**（`加载分享画布…` / `与源画布同步中断，正在重试…`），完全不渲染 ReactFlow；
- 首个 200 回包在同一个回调里先 `hydrateSession(远端 nodes, 远端 edges)`（**整体替换**，不是 merge）再
  `setPayload(...)` ⇒ React 批处理成一次渲染，渲染出来的必然是远端内容；
- 404 → 独立的失效页，同样不渲染任何画布。

断言：`tests/ui/share-view.test.tsx` 用「永不 resolve 的 fetch」证明请求未回来时本机节点标题从不出现，
再证明回包后本机节点被顶掉（store 里已无 `local-1`）；首拉失败与 404 两条路径同样断言不出现本机节点。

### 6.3 开关入口（`src/components/Chat/ShareToggle.tsx`）

- `handleShare` 的 `if (shareUrl) { copy; return; }` 短路**连同组件内 `shareUrl` state 一起删除**；
  链接一律由**当前 token 现算** `shareLink('/share/'+token, window.location.origin)`，不存在「缓存的旧链接」。
- 状态来自 `GET /api/share-state`（挂载时拉一次；409/网络不可达时按「未开启」渲染，按钮本身在
  `!isConnected` 时禁用）。
- 交互：未开启 → 点击 `POST /api/shares`（幂等）→ 自动复制链接 + 展开浮层；已开启 → 点击只展开浮层
  （**不再发任何请求**）；浮层内「复制链接」/「撤销分享」（`DELETE /api/shares`）。
- **隐私告知**（裁决 ①）：浮层里常驻一行警示色文案「链接内容随源画布实时变化：持链接者会看到源画布
  **后续新增**的全部内容（不是分享时点的快照）。不需要时请撤销。」，按钮 title 亦带同样提示；
  `SHARE_LIVE_NOTICE` 导出供测试锁文案。
- 基址纪律（X25）：链接只用页面 origin，API 只用 `apiBaseFrom(origin) ?? ''`；测试里有反向断言
  （链接不等于 API 基址拼出的地址）。

---

## 7. 复跑削减理由（裁决 ⑥，有意的功能削减）

删除 `POST /api/shares/<token>/rerun`（`server/share-api.ts`）与 ShareView 右栏的「复跑」按钮、
`reruns` 本地态、`RerunRecord` 相关渲染。三条理由：

1. **违反只读纪律**：`rerunDataFrame` 会在服务端拉起 `govio-cli`、按 Manifest 固化 SQL **真实执行一次取数**，
   并加载/释放 DataFrame。它作用的是**服务端当前会话单例**，也就是分享者的源实例——即使结果只进响应，
   「在别人的机器上触发一次真实执行」本身就是对源 session 的执行副作用，与 scope 第 5 项「只读页必须禁止复跑」冲突。
2. **活视图语义下没有稳定输入**：快照时代的复跑输入是「分享那一刻固化的 Manifest」，与源画布解耦；
   活视图下 Manifest 随源画布变化，只读页上的复跑结果与用户此刻看到的节点可能对不上，结论不可解释。
3. **有明确的替代路径**：需要动手就「Fork 续写」，在自己的可写副本里复跑（副本上的复跑走主界面既有的
   `POST /api/rerun-dataframe`，留痕与漂移判定完整）。只读页右栏与 USER-MANUAL 都写明了这条指引。

**不受影响**：主界面复跑（`server/dataframe-rerun.ts`、`src/utils/rerun.ts`、`DataFrameNode` 的复跑按钮、
`RerunStatus`、`verify:rerun` 的 71 项断言）**零改动**。只读态下 `DataFrameNode` 只是不渲染复跑按钮，
历史复跑记录（`node.data.rerunHistory`）照常展示——那是数据，不是动作。

---

## 8. 与 T3.1 S3 绑定的关系（结论）

**采用 DISPATCH 的推荐口径，且与既有代码无冲突**：

- 活视图**只读本地当前会话的 sidecar**（`loadCanvas(sessionFile)` → `<session>.canvas.json`）。
  绑定 S3 的画布，其本地 sidecar 就是 T3.1「本地写 + 异步同步」模型里的本地权威副本，
  且 `pushSessionState` 会先 `refreshCanvasFromRemote` 把对端更新拉回本地 ⇒ 活视图读本地即读到最新。
- **远端 share 工件整体退出**：`putRemoteShare` / `getRemoteShare` / `findRemoteShare` / `remoteShareKey` /
  `ShareTransport` 及其测试注入点 `setShareTransportFactoryForTests` 全部删除（它们的唯一消费者是快照记录）。
  跨实例分享（目标实例读源实例的远端画布）**不在本期**，记遗留归口 T3.3/T3.4（见 §10.1）。
- 开关 sidecar **仅本地**，不进 `syncCanvasToRemote` 的同步集合：分享是「源实例授权对外暴露」的本地决定，
  把它同步到 S3 等于让任何绑定同一 profile 的实例都能代替源实例开启分享，扩大暴露面。
- `server/storage/s3-backend.ts` 的 `shareKey()` **未动**（§5 范围纪律：不碰 `s3-*.ts`）。它现在没有调用方，
  属 T3.1 遗留的死代码，记入 §10.4 由后续任务清理。
- 凭据边界不变：活视图载荷只有画布内容 + Manifest，**不含** profile 名 / 绑定信息 / endpoint / 凭据；
  集成测试对「载荷 + 开关 sidecar」两类工件做深度扫描（沿用 T3.2 的凭据断言思路）。

---

## 9. 一处必要的基础设施改动：CORS（`server/security.ts`）

`corsHeadersFor` 原来只放行 `GET, POST, OPTIONS` 与 `Content-Type`。本任务的两个契约要求跨源时会被浏览器
预检拦下（dev：页面 5173 → API 5174 是跨源）：

- `DELETE /api/shares`（撤销）——DELETE 不是 CORS 安全方法；
- `GET /api/shares/<token>` 带 `If-None-Match`——不是安全请求头。

故最小改动为：`Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`、
`Access-Control-Allow-Headers: Content-Type, If-None-Match`、新增 `Access-Control-Expose-Headers: ETag`。
**Origin 白名单逻辑一字未动**（仍只回显 `localhost|127.0.0.1|[::1]`），所以安全边界没有放宽，只是让
新契约在跨源下可用。预检 OPTIONS 早由 `handleParquetApi` 首位分支统一回 204（backend.ts 里它先于
`handleShareApi`），无需新增处理。

顺带把 `docs/specs/06-backend.md` 里「CORS 完全开放（Allow-Origin: *）」这句**与代码不符的旧描述**改正
（实际是白名单回显）——属文档纠错，不改行为。

`etag` 同时放进响应 body：跨源读响应头依赖 `Access-Control-Expose-Headers`，body 里的值前端无条件可读，
作为下一次 `If-None-Match` 的来源更稳（两者都在测试里断言）。

---

## 10. 遗留问题

1. **跨实例分享不可用**（归口 T3.3/T3.4）：活视图只读源实例本地 sidecar，所以链接只在「源实例后端可达」时有效。
   同一台机器上 dev（5173/5174）与生产单端口托管都没问题；把链接发给另一台机器的浏览器则打不开。
   要跨实例，需要 T3.4 的部署收敛（对外可达的地址）+ T3.3 的鉴权，或重新引入远端工件（本期已删）。
2. **无过期时间**（裁决 ②，归口 T3.3）：链接只有「开/关」两态，没有 TTL、没有访问次数限制、没有访问日志。
   活视图的暴露面大于快照（后续内容实时可见），撤销是唯一的收口手段。
3. **无鉴权 / 同网络可达即可读**（继承 T3.2 遗留 4，归口 T3.3）：后端只绑 loopback，但用户把链接发给别人、
   或部署到共享主机时，token 就是全部凭据。
4. **`server/storage/s3-backend.ts` 的 `shareKey()` 成了死代码**：本任务按范围纪律未碰 `s3-*.ts`。
   建议在 T3.3/T3.4 处理远端工件布局时一并删除（或明确保留给未来的跨实例分享）。
5. **`forkFrom.shareId` 字段名与新语义（token）不一致**：字段仍叫 `shareId`，存的是派生 token。
   改名会动到已落盘的 `canvas.json` 顶层键与 WS `fork_applied` 载荷（X2 契约），故本期保留旧名，
   已在类型注释与 `docs/specs/06-backend.md` 写明「`forkFrom.shareId` = 分享 token」。
6. **活视图的 Manifest 右栏与节点内「详情」信息重复**：右栏保留了 T3.2 的 Manifest 清单（去掉复跑按钮），
   节点卡片里的「详情」现在也能展开同一份留痕。是否收掉右栏属交互取舍，本期不动（保持信息可达）。
7. **`useCanvasStore` 单例被只读页复用**：这是方案 A 的固有代价——只读页与主界面在同一浏览器标签里
   不可能同时存在（路由互斥），所以当前是安全的；但若将来要在主界面内嵌只读预览（如「分享前预览」），
   必须改用方案 B（独立 store 实例），否则会互相覆盖。
8. **`package-lock.json` 的 `version` 漂移**（DISPATCH §6 第 2 条提到的既有问题）：本次开工前
   `git status --porcelain` 为空，未出现该漂移，故无需处理；T3.6 引 zip 依赖跑 `npm install` 时会自然吸收。
9. **人工目视对照未由本 worker 在真实浏览器完成**：环境无浏览器/无 puppeteer（且禁止 `npm install`），
   `verification.md` 里给的是**逐项文字对照**（依据 = 复用同一组件对象 + UI 测试对渲染产物的断言），
   真实浏览器并排目视与截图留给主会话验收/用户确认。
