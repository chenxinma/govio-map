# T1.2 改动清单

分支 `feature/phase1-trusted-analysis`。共 18 个文件（9 新增 / 9 修改；三件套按 3 个文件计，此前误计为 16）。

## 新增文件

| 文件 | 摘要 |
|------|------|
| `src/types/rerun.ts` | 复跑记录类型（前后端共享，纯类型 + 字段级中文注释）：`RerunRecord`、`RerunOutcome`（`identical`/`drift`/`error`）、`RerunSnapshot`（before/after 快照）、`RerunDiff`（行列数增量、schemaChanged、baselineIncomplete、中文 summary）；文件头说明与 Manifest 的关系（一致只刷新 executedAt，漂移原样保留） |
| `server/govio-cli-exec.ts` | 从 `parquet-api.ts` 抽出的共享 CLI runner `runGovioCliWithArgs(args, timeoutMs = 30000)`（`execFile` 数组参数，SQL 全文不经 shell 拆分）；失败时 reject 的 Error 以 stderr 优先，前端能拿到 CLI 真实报错 |
| `server/dataframe-rerun.ts` | 复跑与漂移判定：`RERUN_TMP_PREFIX`/`RERUN_LOAD_TIMEOUT_MS`(120s)/`RERUN_RELEASE_TIMEOUT_MS`(15s)、`rerunBlockReason`、`manifestSnapshot`、`tempDfNameFor`、`buildRerunLoadArgs`、`parseLoadOutput`、`compareRerunResult`、`rerunDataFrame`（runCli/now 可注入，永不抛错，`finally` 释放临时 DF）。零 agent 依赖；文件末尾带 `NODE_ENV !== production` 自检（11 项断言） |
| `src/utils/rerun.ts` | 复跑记录的前端写入规则（纯函数）：`MAX_RERUN_HISTORY = 20`、`latestRerun`、`hasDrift`、`canRerun`、`withRerunRecord`（追加+封顶+一致时刷新 `manifest.executedAt`，不可变更新）、`formatRerunTime` |
| `src/components/Nodes/RerunStatus.tsx` | 复跑状态条：进行中（Loader2 旋转）/ 复现一致（品牌绿）/ 漂移（warning + 差异摘要）/ 失败（error + 原因）；右侧「N 次」按钮展开记录列表（`max-h-32` 可滚动，每行 title 里给出原留痕、本次结果、差异、耗时、临时 DF 名、会话） |
| `scripts/verify-rerun-drift.ts` | 可复跑验证脚本（`npm run verify:rerun`，交付时 62 项断言、`-- --real` 74 项；R1 审查后 67 / 79 项，见 docs/tasks/REVIEW-R1-fixes.md；走真实 govio-cli），失败退出码 1 |

## 修改文件

### 服务端

| 文件 | 改动 |
|------|------|
| `server/parquet-api.ts` | ① 删除局部 `runGovioCliWithArgs`，改从 `govio-cli-exec.js` 导入（`/api/execute-sql` 行为不变）；② 新增 `readManifestFromCanvas(nodeId)`：`getSession().sessionManager.getSessionFile()` → `loadCanvas()` → 按 nodeId 取 `data.manifest`，读不到/异常返回 null 并告警；③ 新增路由 `POST /api/rerun-dataframe`：请求体只认 `{ nodeId }`，缺字段 400、sidecar 里找不到留痕 409、其余异常 500，正常返回 `200 { record }`（不可复跑/CLI 失败也是 200 + `outcome: 'error'` 的记录）；④ 复跑**不**调用 `pushGovioNode`，不新建节点 |

`server/session-history.ts`、`server/ws-handler.ts`、`server/govio-node-queue.ts`、`server/analysis-manifest.ts`、`server/extensions/govio-canvas.ts` **未改动**：复跑记录随 `node.data` 走既有的 `canvas_save` → sidecar 通道，校验和复用 T1.1 的 `computeChecksum`。

### 前端

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | 再导出 `rerun.ts` 的 4 个类型；`DataFrameNodeData` 增加 `rerunHistory?: RerunRecord[]`（带注释：最新在前、漂移时原 manifest 保留、随 sidecar 持久化） |
| `src/store/canvas-store.ts` | ① 新增临时态字段 `rerunningNodeIds: string[]`、`rerunErrors: Record<string,string>`（不在 `partialize` 里，故不持久化）+ 模块内 `withoutKey()` 辅助；② 新增 action `rerunDataFrame(nodeId)`：并发保护 → `POST http://localhost:{port+1}/api/rerun-dataframe` 只传 `{ nodeId }` → 成功用 `withRerunRecord` 写回 `node.data.rerunHistory`，请求失败只写 `rerunErrors`（不污染留痕）→ finally 清进行中态；③ `clearCanvas()` / `hydrateSession()` 一并清空两个临时态；④ 导入 `RerunRecord` 类型与 `withRerunRecord` |
| `src/components/Nodes/DataFrameNode.tsx` | ① 新增 `rerunDataFrame` / `rerunning` / `rerunError` 三个 store 选择器；② 头部在漂移时显示 warning 色「漂移」标签（title 给出差异摘要），卡片边框由 `border-border-default` 切到 `border-warning/60`；③ 列信息区与操作栏之间渲染 `<RerunStatus>`；④ 操作栏在「详情」之后新增「复跑」按钮（`RotateCw`，仅 `canRerun(nodeData)` 时渲染，执行中禁用并显示「复跑中」+ 图标旋转）；⑤ 操作栏加 `flex-wrap`（5 个按钮在 320px 卡片里不溢出） |
| `package.json` | 新增脚本 `"verify:rerun": "tsx scripts/verify-rerun-drift.ts"`（无新依赖） |

### 文档

| 文件 | 改动 |
|------|------|
| `docs/specs/02-nodes.md` | 文件结构表补 `ManifestDetails.tsx`（T1.1 遗漏）/`RerunStatus.tsx`/`src/types/manifest.ts`/`src/types/rerun.ts`/`src/utils/rerun.ts`；`DataFrameNodeData` 字段表补 `rerunHistory?`；「DataFrameNode 详情」的布局与操作栏更新为当前实际结构，并新增「一键复跑与漂移提示（Phase 1 KR2）」小节（三态表 + 一致/漂移规则） |
| `docs/specs/05-store.md` | 状态表补 `rerunningNodeIds` / `rerunErrors`；新增「复跑操作（Phase 1 KR2）」小节（`rerunDataFrame` 5 步流程 + 只传 nodeId 的理由）；`clearCanvas()` 与「持久化」小节同步（临时态不持久化、节点级留痕随 nodes 持久化） |
| `docs/specs/06-backend.md` | 文件表补 `dataframe-rerun.ts` / `govio-cli-exec.ts` 并修正 `parquet-api.ts` 职责；`parquet-api.ts` 一节改为「HTTP API」+ 路由总表（5 条）+ dev/Electron 的 base URL 差异；新增 `POST /api/rerun-dataframe` 请求/响应表与流程；新增 `dataframe-rerun.ts` 一节（验证式复跑三步、导出函数表、漂移判定优先级、超时、与权限/agent 的关系、验证命令） |
| `docs/task-plan.json` | T1.2 `status` 按状态协议 `pending → in_progress → done` + `history` 追加两条 + 顶层 `updatedAt` 刷新 |
| `docs/tasks/T1.2-dataframe-rerun-drift/*` | 本任务三件套交付物 |

## 未改动但相关的既有行为（确认无回归）

- `POST /api/execute-sql`：仅把局部 CLI runner 换成共享实现，参数与响应不变（`npm run verify:manifest` 的 52 项断言仍全通过）。
- T1.1 的 `createGovioNode` 去重回填规则未动：复跑不推节点事件，所以不会触发「同 dfName 覆盖/回填」。
- `node.data.manifest` 除 `executedAt`（仅在复跑一致时）外不被本任务任何路径改写。
