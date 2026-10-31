# T1.2 DataFrame 一键复跑与漂移提示 — 设计说明

> 任务：ROADMAP Phase 1 / KR2「复跑验证」（北极星指标：可复现率）
> 分支：`feature/phase1-trusted-analysis`，前置任务 T1.1（Analysis Manifest）
> 状态：实现完成，`npm run build` + `npm run lint` + `npm run verify:rerun`（62 项断言）+ `npm run verify:rerun -- --real`（74 项断言，真实 govio-cli）通过

## 1. 目标与范围

给 dataFrame 节点一个「复跑」入口：**按 T1.1 固化在 `node.data.manifest` 里的 SQL 与数据源**重新执行一次 `govio-cli observe load`，把结果与原 Manifest 的行数/校验和对比：

- 一致 → 刷新 Manifest 的执行时间（最近一次可复现确认时间）
- 不一致 → 节点显示漂移警告标记，**原 Manifest 原样保留**，把旧值/新值/时间追加为一条复跑记录
- 三态展示：进行中 / 成功（复现一致）/ 漂移（外加「失败」态，见 §7）

范围内：节点 UI（复跑按钮 + 状态条 + 记录列表）、后端复跑通道（HTTP）、漂移判定、复跑记录数据模型与持久化、验证脚本。

范围外（本任务不做）：值级差异比对（`observe compare`）、定时/批量复跑、复跑结果的「采纳新值」动作、权限确认关联（T1.3）、导出附录（T1.4）、sqlQuery/report/chart 节点的复跑。

## 2. 通道选型：HTTP 而不是 WS（取舍）

选 `POST /api/rerun-dataframe`（`server/parquet-api.ts`，端口 5174），不走 WebSocket：

| 考量 | HTTP（选定） | WS |
|------|--------------|----|
| 交互形态 | 复跑是一次性请求-响应，HTTP 天然带状态码与错误体 | 需要自己定义 request/response 关联（requestId）与超时 |
| 与现有前端服务层一致 | `/api/execute-sql`（SQLModal）、`/api/preview`（canvas-store）都是 HTTP fetch，本任务的调用点也在 canvas-store | `/ws` 现有语义是「会话与 agent 事件流」，复跑不经 agent（不消耗模型、不进 transcript），塞进去会混淆职责；`/canvas` 是服务端→前端的单向事件流，没有客户端消息入口 |
| 类型改动面 | 零协议改动（不碰 `WSMessage` 联合类型与 `useChat` 的消息分发） | 需要扩 `WSMessage`、`ws-handler` 分发、`useChat` 处理分支 |
| 缺点 | 无进度推送 | 可推送进度 |

缺点的处置：「进行中」状态由前端本地维护（按钮禁用 + 旋转图标 + 状态条），复跑是单条 SQL，`observe load` 给了 120s 超时上限，不需要流式进度。

URL 用绝对地址 `http://localhost:{window.location.port + 1}`，与 canvas-store 里既有的 `/api/preview` 调用一致：Electron 生产模式的静态服务器（5173）**不代理** `/api`，相对路径在打包版会打到静态服务器上（`SQLModal` 的 `/api/execute-sql` 就有这个问题，见 §11 遗留问题 6）。

## 3. 复跑语义：验证式（临时 DataFrame），不覆盖已交付结果（核心取舍）

复跑有两种可能语义：

- **A. 覆盖式**：`observe load --name <原 dfName>`，把 ObserveStore 里的同名 DataFrame 换成新结果
- **B. 验证式（选定）**：`observe load --name rerun_tmp_<dfName>_<ts><rand>`，比对完立刻 `observe release` 释放临时 DF，原 DataFrame 一动不动

选 B 的理由：

1. **KR2 的北极星是「可复现率」**——「任意 DataFrame 节点可一键复跑且结果一致的比例」。这是验证指标，复跑的目的是回答「这个数还能不能复现」，不是「再取一次数」。
2. **覆盖式会让留痕与数据脱钩**：漂移时节点上的 Manifest（行数/校验和）说的是旧结果，store 里的 parquet 已经是新结果，预览面板与节点卡片互相矛盾，而且 T1.1 的校验和无法再由 store 复算。
3. **覆盖式会销毁交付物**：业务方已经拿到的那份数，在一次「验证」点击后被冲掉，与 Phase 1「可信分析」的目标相反。
4. B 的代价可控：多一次 `observe release`（已实测 CLI 支持），临时名带 `rerun_tmp_` 前缀便于识别；释放在 `finally` 里，失败只告警且记录里带 `tempDfName` 可手工清理。残留的唯一副作用是可能被 `restoreCanvas`（`observe list`）补成一个画布节点，故必须保证释放。

已实测（见 `verification.md` 附录）：同名重载与临时名加载/释放都可用；`observe load` 输出自带 `rows`/`columns`/`column_info`，无需再调 `observe info`；`observe load` 的 `column_info[].dtype` 与 `observe info` 的 `schema[].dtype` 一致，所以 T1.1 两条填充路径产出的校验和可以直接对比。

## 4. 复跑用的 SQL 只认服务端持久化的留痕

请求体**只有 `{ nodeId }`**，不接受前端传 SQL：

```
POST /api/rerun-dataframe { nodeId }
  → readManifestFromCanvas(nodeId)：getSession().sessionManager.getSessionFile()
    → loadCanvas()（<session-file>.canvas.json）→ 按 nodeId 取 data.manifest
  → 找不到 → 409（画布未保存 / 会话不匹配）
  → rerunDataFrame(manifest, { sessionId })
```

取舍：如果让前端把 `node.data.manifest.sql` 传上来，验收标准「复跑使用 Manifest 固化的 SQL（不是任何当前输入）」就只由前端自觉保证；改成服务端从 sidecar 读，这条性质由后端结构保证（前端根本没有上传 SQL 的通道）。代价是多一个失败模式——sidecar 里没有该节点（画布快照防抖 1s 未落盘、WS 未连接、节点属于别的会话）→ 409 + 明确文案，不做「回退用前端传入的 SQL」这种静默降级。

`rerunDataFrame` 内部再做一次前置校验（`rerunBlockReason`）：`sql` / `datasource` / `dfName` 缺一即不可复跑，返回 `outcome: 'error'` 的记录（例如 T1.1 里 `show-dataframe` 来源的节点 SQL 为空串）。前端 `canRerun()` 只判断主导情况（`manifest.sql` 非空）来决定是否渲染按钮，其余由服务端兜底——避免把同一套规则写两遍。

## 5. 数据模型：复跑记录

新增 `src/types/rerun.ts`（纯类型，前后端共享，服务端以 `../src/types/rerun.js` 导入，沿用 T1.1 的 `src/types/manifest.ts` 做法），`src/types/index.ts` 再导出，并把 `rerunHistory?: RerunRecord[]` 挂到 `DataFrameNodeData`。

```
RerunRecord {
  rerunAt        本次复跑完成时间（ISO，服务端时钟）
  outcome        'identical' | 'drift' | 'error'
  before         原 Manifest 快照 { executedAt, rowCount, columnCount, checksum }
  after?         本次结果快照（error 时缺省）
  diff?          { rowCountDelta, columnCountDelta, schemaChanged, baselineIncomplete?, summary }（drift 时必有）
  error?         失败原因
  durationMs?    耗时
  tempDfName?    本次复跑用的临时 DataFrame 名（释放失败时便于手工清理）
  sessionId      触发复跑的 pi 会话 ID
}
```

取舍：

- **记录挂在 `node.data.rerunHistory`（数组，最新在前），不挂在 Manifest 里**。Manifest 是「原始留痕」，T1.1 已确立它只读；把复跑记录塞进 Manifest 会让「原始结果」与「复现历史」混在一个对象里，也让 T1.4 导出附录难以区分。挂 `node.data` 的好处是天然随 canvas sidecar 持久化（§6），且前端 `updateNodeData` 语义不变。
- **`before` 是完整快照而不是引用**：漂移记录必须能独立阅读（旧值就在记录里），否则一旦 Manifest 的 `executedAt` 被后续「一致」复跑刷新，历史记录的对照基准就丢了。
- **条数封顶 20**（`MAX_RERUN_HISTORY`，前端 `withRerunRecord` 执行）：sidecar 是整份 JSON 重写，长期反复复跑不能无限增长；最近 20 次足够审计。
- **`diff.summary` 由服务端生成中文摘要**（如 `行数 1200 → 1350（+150）`），前端直接展示，不再二次加工——避免「同一差异两种说法」。

## 6. 持久化链路（复用 T1.1 的通道，零协议改动）

```
rerunDataFrame() 写入 node.data.rerunHistory（zustand）
  → useChat 的 store 订阅（nodes 变化，防抖 1s）→ canvas_save
  → saveCanvas() 写 <session-file>.canvas.json（server/session-history.ts，未改动）
  → 会话重开：loadCanvas() → canvas_restore → hydrateSession() → node.data.rerunHistory
```

`ws-handler.ts` / `session-history.ts` 不需要改：sidecar 存的是整份 node 对象。zustand `persist` 的 `partialize` 含 `nodes`，浏览器本地缓存里也带着记录。

**临时态与留痕态分离**：`rerunningNodeIds`（进行中）与 `rerunErrors`（请求本身失败的原因）是 store 顶层字段，不在 `partialize` 里，所以刷新/重开会话不会残留「复跑中」；`clearCanvas()` 与 `hydrateSession()` 都会清空它们。只有服务端真实执行过的复跑才写进 `rerunHistory`——请求失败（后端没起、409）只在节点上临时提示，不污染留痕。

## 7. 漂移判定与三态

`compareRerunResult(manifest, result)` 的判定优先级：

1. 双方都有校验和 → 比 `schemaHash`（覆盖行数、列数、列名、dtype、列顺序，即 T1.1 的 `schema-v1` 语义）
2. 原留痕没有校验和但有行数 → 退化到行数/列数对比。T1.1 在拿不到列信息时**不产出**校验和，此时不能因为「哈希缺失」就报漂移
3. 原留痕连行数也没有 → `diff.baselineIncomplete = true`，**按漂移处理**并在摘要里写明「无法确认复现一致」。宁可告警，也不给一个假的「复现一致」绿灯

`sqlHash` 不参与判定：复跑用的就是 Manifest 里那份 SQL，重算必然相同。

UI 状态归属（`RerunStatus.tsx`）：

| 展示态 | 数据来源 | 是否持久化 |
|--------|----------|-----------|
| 进行中 | `rerunningNodeIds`（临时态）+ 按钮禁用/旋转 | 否 |
| 成功（复现一致） | `rerunHistory[0].outcome === 'identical'` | 是 |
| 漂移 | `rerunHistory[0].outcome === 'drift'` → 状态条 + 头部「漂移」标签 + 卡片边框 warning 色 | 是 |
| 失败 | `rerunHistory[0].outcome === 'error'`（服务端执行失败，留痕）或 `rerunErrors[nodeId]`（请求失败，临时） | 部分 |

「失败」是任务书三态之外补的一态：复跑失败（数据源不可达、SQL 报错、CLI 超时、上游 memory DF 已释放）如果不显示，用户会以为按钮坏了；如果静默写进留痕又不诚实。所以区分两类：真实执行过的失败**写记录**（`outcome: 'error'`，含原因），请求级失败只**临时提示**。

漂移态以「最近一次复跑结论」为准：漂移后再复跑一次一致，警告自动消除（记录仍在，历史不丢）。节点卡片展示的行数/列数在漂移时**不更新**——它代表已交付的那份结果，新值在漂移记录里。

## 8. 一致时刷新执行时间的语义

任务书要求「一致 → 刷新执行时间」。实现为：`withRerunRecord()` 在 `outcome === 'identical'` 时把 `manifest.executedAt` 改成 `record.rerunAt`，原始执行时间保留在 `record.before.executedAt`。

因此 `manifest.executedAt` 的语义从「结果产生时间」变成「最近一次可复现确认时间」；首次产生时间在复跑记录里可追溯。这是对 T1.1「Manifest 只读」的一个**受控例外**：只允许复跑链路刷新这一个字段，且只在结论为一致时刷新，漂移/失败绝不触碰 Manifest（验证脚本对此有深度相等断言）。其余字段（SQL、校验和、模型、会话）永不被复跑改写。

## 9. 后端实现要点

- `server/govio-cli-exec.ts`（新增）：把原先 `parquet-api.ts` 里的局部函数 `runGovioCliWithArgs` 提出来共享（数组参数，SQL 全文不经 shell 拆分），并加可选 `timeoutMs`。复跑与 SQL 编辑器共用同一份实现，避免两处拼命令。
  - 行为变化：失败时 `reject(new Error(stderr || error.message))`，前端能拿到 CLI 的真实报错而不是 `Command failed: ...`。
- `server/dataframe-rerun.ts`（新增）：复跑与判定的全部逻辑，**不依赖 agent 会话**（`runCli` / `now` 可注入），所以验证脚本能直接跑；模块末尾带 `NODE_ENV !== production` 自检，沿用 `analysis-manifest.ts` / `session-history.ts` 的惯例。
  - 超时：`observe load` 120s（重查询比 SQL 编辑器的 30s 更宽），`observe release` 15s。
  - 临时名：`rerun_tmp_` + 归一化后的 dfName（`[^a-z0-9_]` → `_`，截断 32 字符）+ 36 进制时间戳 + 4 位随机尾（并发复跑不撞名）。
  - `rerunDataFrame` 永不抛错：CLI 失败 / 输出被截断 / 不可复跑都转成 `outcome: 'error'` 记录。
- `server/parquet-api.ts`：新增路由与 `readManifestFromCanvas()`；`/api/execute-sql` 逻辑未改（只换成共享的 CLI runner）。
- 复跑**不推送节点事件**（不走 `pushGovioNode`）：结果由前端就地更新到既有节点，不会新建/覆盖节点，也不会触发 T1.1 的去重回填逻辑。

## 10. 验证策略

`scripts/verify-rerun-drift.ts`（`npm run verify:rerun`，加 `-- --real` 走真实 CLI），交付时 62 / 74 项断言（R1 后 67 / 79，见 docs/tasks/REVIEW-R1-fixes.md），覆盖：复跑参数只来自 Manifest（结构性保证：`rerunDataFrame` 无「当前输入」通道，另有 argv 形状与 `buildRerunLoadArgs` 契约全等的断言）、临时名与释放、三态判定（行数/dtype/列名变化、无校验和退化、无基线）、失败路径与释放、前端写入规则（一致刷新时间、漂移保留原 Manifest 深度相等、封顶、不可变更新）、store → canvas_save → sidecar → hydrateSession 往返、并发点击只发一次请求；`--real` 额外用真实 `govio-cli` + `sales` 数据源跑完整链路并断言「原 DataFrame 未被覆盖」「无临时残留」。详见 `verification.md`。

## 11. 遗留问题

1. **值级漂移检不出**：校验和只覆盖规模与结构（T1.1 的既定取舍）。同结构同规模但数值变了（例如金额被修正）会判为 identical。补法是在复跑时对临时 DF 与原 DF 跑 `govio-cli observe compare`，但 compare 需要读数据内容，与「非必要不读取数据内容」的纪律冲突，应先由 CLI 侧提供内容摘要能力（能力下沉）。
2. **漂移后没有「采纳新结果」动作**：漂移时节点与 store 里的原 DF 都保持旧值，用户只能让 agent 重新取数。若后续需要一键采纳，应显式覆盖 `node.data` 的行列数与 Manifest，并保留本次漂移记录。
3. **复跑不过权限门**：`/api/rerun-dataframe` 与既有 `/api/execute-sql` 一样直连 CLI，不经 `permission-manager`（也不进 transcript）。含 `-o` 的命令不可能出现在复跑参数里（参数由服务端组装），但跨库/全表扫描这类风险目前无确认环节，T1.3 应把复跑纳入审计（`RerunRecord` 也需要补 `permissionDecisionId`）。
4. **`--memory` 派生节点的复跑依赖上游 DF 仍在 store 里**：上游被 `observe release` 后复跑会失败（返回 error 记录并给出 CLI 报错）。要真正可复现需要把上游链一起复跑，属于「画布级复跑」，超出本任务范围。
5. **sidecar 是复跑的唯一 SQL 来源**：画布快照防抖 1s，若 WS 未连接或后端刚重启（会话未建立），复跑会 409。文案已提示「请确认画布已保存或重开该会话」，但没有自动重试。
6. **`SQLModal` 的 `/api/execute-sql` 用相对路径**：Electron 生产模式的静态服务器不代理 `/api`，该请求在打包版会失败（既有问题，非本任务引入）。本任务的复跑请求用绝对 `localhost:{port+1}` 规避了；建议后续统一抽一个 `apiBase()`。
7. **临时 DF 残留的兜底**：进程在 load 与 release 之间被杀会留下 `rerun_tmp_*`。记录里有 `tempDfName`，但没有启动时清扫逻辑（可在 backend 启动时按前缀 `observe release`，本任务未做以免误删并发会话的临时 DF）。
8. **复跑记录只在 dataFrame 节点上**：sqlQuery 节点（`assistant-sql`）没有结果指标，不提供复跑；其「执行并对比」等价于新建一个 dataFrame 节点，属于另一条产品路径。
