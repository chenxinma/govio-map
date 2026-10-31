# T1.1 Analysis Manifest 数据模型与持久化 — 设计说明

> 任务：ROADMAP Phase 1 / KR1「分析留痕」
> 分支：`feature/phase1-trusted-analysis`
> 状态：实现完成，`npm run build` + `npm run verify:manifest`（52 项断言）通过

## 1. 目标与范围

给「分析结果」建立可复现的留痕：每个由 agent 或 SQL 编辑器产生的 dataFrame 节点、每个由助手消息产生的 sqlQuery 节点，都在 `node.data.manifest` 上固化一份 **Analysis Manifest**，并随 canvas sidecar（`<session-file>.canvas.json`）持久化，会话重开后完整恢复。

范围内：类型定义、服务端填充（`observe load` 事件流、`govio_show_dataframe` 工具、`POST /api/execute-sql`、助手消息 SQL）、事件与 store 透传、sidecar 往返、前端「详情」只读展示、可复跑验证脚本。

范围外（本任务不做）：复跑与漂移对比（T1.2）、权限审计与决策 ID 落地（T1.3）、导出（T1.4）、report/chart 节点留痕。

## 2. 数据模型

新增 `src/types/manifest.ts`（纯类型文件，前后端共享；服务端以 `../src/types/manifest.js` 导入，与既有 `src/types/models-config.ts` 的做法一致）。`src/types/index.ts` 以 `export type { ... } from './manifest'` 再导出，并把 `manifest?: AnalysisManifest` 挂到 `DataFrameNodeData` 与 `SQLQueryNodeData`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schemaVersion` | number | 是 | 结构版本号，当前 1（常量 `MANIFEST_SCHEMA_VERSION`） |
| `origin` | `ManifestOrigin` | 是 | 产生路径：`observe-load` / `show-dataframe` / `sql-editor` / `assistant-sql` |
| `sql` | string | 是 | SQL 全文（原样保留换行与注释）；取不到时为空串 = 该节点不可一键复跑 |
| `datasource` | string | 是 | 数据源标识；`--memory` 派生为 `memory`；未知为空串 |
| `dfName` | string | 否 | 结果 DataFrame 名（sqlQuery 节点无） |
| `executedAt` | string | 是 | ISO 8601 执行/产生时间（服务端时钟；`assistant-sql` 取助手消息 timestamp） |
| `rowCount` / `columnCount` | number | 否 | 结果规模；未执行（sqlQuery）时缺省 |
| `checksum` | `ManifestChecksum` | 否 | 轻量校验和，见 §4 |
| `model` | `ManifestModel` | 否 | 生成模型 `provider` / `id` / `name` / `responseModel`；人工执行时缺省 |
| `sessionId` | string | 是 | pi 会话 ID，回链 `.govio/sessions/` transcript |
| `permissionDecisionId` | string \| null | 否 | 关联权限决策 ID（**预留**，T1.3 落地前恒为 `null`） |
| `sourceDataFrames` | string[] | 否 | `--memory` 派生时的上游 DataFrame 名（已按 SQL 文本过滤，与血缘边一致） |

取舍：**一个类型覆盖 dataFrame 与 sqlQuery**，而不是各定义一份。sqlQuery 只有 SQL 没有结果，所以结果指标（rowCount/columnCount/checksum）与 dfName 为可选；这样 T1.4 导出附录、T1.2 复跑判断都能用同一套读取逻辑。`permissionDecisionId` 显式写 `null` 而不是省略，用来区分「本次结果没触发权限确认」与「旧节点没有这个字段」。

## 3. 填充路径

构建与哈希逻辑集中在新增的 `server/analysis-manifest.ts`（零项目内依赖，只用 `node:crypto`），避免 `analysis-manifest → agent → govio-canvas → analysis-manifest` 的循环依赖；会话上下文由调用方传入：

| origin | 触发点 | 会话/模型来源 | SQL 来源 |
|--------|--------|---------------|----------|
| `observe-load` | `govio-canvas.ts` `tool_result` → `handleLoadResult` | `piSessionContext(ctx)`（pi 扩展上下文 `sessionManager.getSessionId()` + `ctx.model`） | `extractSqlFromCommand(cmd)` |
| `show-dataframe` | `govio_show_dataframe` 工具 `execute` | 同上（execute 第 5 个参数 ctx） | 无（空串） |
| `assistant-sql` | `govio-canvas.ts` `message_end` | `sessionId` 取 ctx；模型优先取助手消息自带的 `provider`/`model`/`responseModel` | ```sql 代码块原文 |
| `sql-editor` | `parquet-api.ts` `POST /api/execute-sql` | `agentSessionContext(getSession())`（AgentSession） | 请求体 `sql` 原文 |

`extractSqlFromCommand` 取代原先的 `cmd.match(/--sql\s+"([^"]*)"/)`：支持 `--sql "..."`、`--sql '...'`、`--sql=...`、多行 SQL、引号内转义引号还原；未加引号时截到下一个 flag 之前（避免把 `-o out.parquet` 尾巴算进 SQL）；**取不到就返回空串**，不再回退成整条命令（原行为会把 shell 参数固化成「SQL」，对 T1.2 复跑是毒数据）。血缘匹配仍保留原有回退（`sqlText || cmd`），行为不回退。

模型来源的取舍：`message_end` 用助手消息自带的 `model`/`responseModel`，而不是 `ctx.model`。一轮对话中途切模型时，消息自带的字段才是真实生成者；`ctx.model` 只作为兜底。

## 4. 结果校验和（轻量方案与取舍）

`schema-v1`：

```
schemaHash = sha256(JSON.stringify([rowCount, columnCount, [[name, dtype], ...]])).slice(0, 16)
sqlHash    = sha256(sql).slice(0, 16)
```

- **不哈希数据内容**。理由：(1) 项目纪律「非必要不读取数据内容」，全量哈希要读 parquet 全表；(2) 大表代价高，会让每次加载都变慢；(3) 复跑漂移的主信号是规模与结构变化，值级漂移由 T1.2 复跑时的 `govio-cli observe compare` 覆盖。
- 列顺序参与哈希：列顺序变化本身就是一次结构漂移。
- 用 `JSON.stringify` 拼接口而不是 `,` / `:` 拼接，避免列名里含分隔符时的歧义。
- 取 sha256 前 16 位（64 bit）：判定「是否同一结果」足够，节点上也展示得下。
- **拿不到列信息时不产出 checksum**（`columns` 为空数组），只保留 rowCount/columnCount。否则「空 schema 哈希」会在下次拿到真实列信息时造成假漂移。
- 算法一旦变更必须换 `algorithm` 名，新旧哈希不可比。

## 5. 持久化链路

```
服务端 buildManifest()
  → GovioNodeCreateEvent.manifest（server/govio-node-queue.ts）
  → WS /canvas `govio_node_create`（ws-handler 原样展开事件，无需改动）
  → CanvasEvent.manifest（src/services/canvas-service.ts）
  → createGovioNode() 写入 node.data.manifest（src/store/canvas-store.ts）
  → useChat.sendCanvasSnapshot() 发 `canvas_save`（整份 store 快照，无需改动）
  → saveCanvas() 写 <session-file>.canvas.json（server/session-history.ts，无需改动）
  → 会话重开：loadCanvas() → `canvas_restore` → hydrateSession() → node.data.manifest
```

sidecar 与 WS 都是「整份 node 对象透传」，所以 `session-history.ts` / `ws-handler.ts` 不需要改动——Manifest 天然随 `node.data` 走。同时 zustand `persist` 的 `partialize` 已包含 `nodes`，浏览器本地缓存里也带着 Manifest。

去重路径的取舍：`createGovioNode` 对同 `dfName` 会去重（`observe load` 自动建节点 + `govio_show_dataframe` 可能重复推送）。原逻辑直接 `return`。现在补一条**只在已有节点缺 Manifest 时回填**的规则；已有 Manifest 则不覆盖——同一 dfName 重跑的差异属于 T1.2 的漂移对比职责，静默覆盖会销毁原始留痕。

## 6. 前端展示

新增 `src/components/Nodes/ManifestDetails.tsx`：只读折叠面板，dataFrame 与 sqlQuery 节点共用。两个节点在操作栏各加一个「详情」按钮（`ScrollText` 图标，风格与既有「引用/预览/编辑」一致），展开后在操作栏上方渲染面板：来源、数据源、执行时间、DataFrame、行×列、校验和（含算法与哈希）、生成模型、会话、权限决策、上游 DF、SQL 全文（`max-h-32` 可滚动）。

- 无 `manifest` 的节点（历史 sidecar、`restoreCanvas`/数据源面板补出的节点）**不渲染按钮**，UI 与改动前一致。
- 不提供编辑入口：留痕被改过就失去复现意义。

## 7. 验证

新增 `scripts/verify-manifest-roundtrip.ts`（`npm run verify:manifest`），52 项断言，覆盖：buildManifest 字段完整性、`saveCanvas → loadCanvas` 深度相等、校验和可由持久化数据重算（T1.2 前提）、`extractSqlFromCommand` 7 种命令形态、扩展事件流（stub pi）真实产出带 Manifest 的节点事件、store → canvas_save → loadCanvas → hydrateSession 全链路 + 去重回填/不覆盖。详见 `verification.md`。

## 8. 遗留问题

1. **两条前端补节点路径没有 Manifest**：`canvas-store.restoreCanvas()`（会话恢复时按 `observe list` 补节点）与 `DataSourcesModal.handleAddToCanvas()`。它们没有执行上下文，本任务选择不伪造留痕。若要补全，应由服务端下发并新增 `origin: 'restore'`。
2. **sqlQuery 节点的 `datasource` 恒为空串**：助手消息里的 SQL 代码块不带数据源标识。补全需要跨消息关联 `observe load` 命令或查图谱，更适合放在 Phase 2 语义层（T2.2 口径溯源）。
3. **`permissionDecisionId` 恒为 `null`**：`permission-manager.requestPermission()` 目前不把 `requestId` 回传给调用方，T1.3 需要扩展 `PermissionResponse` 后才能建立关联。
4. **SQL 提取依赖命令行文本**：heredoc（`<<'SQL'`）、`$'...'`、shell 变量拼接的 SQL 无法还原，此时 `manifest.sql` 为空串（节点标记为不可复跑）。彻底解法是让 CLI/ObserveStore 回吐加载时的原始 SQL，或约定 `--sql-file`。
5. **report / chart 节点未留痕**：ROADMAP KR1 文案提到「每个 DataFrame/Report 节点」，本任务 scope 只覆盖 dataFrame/sqlQuery（与任务书一致）。report 节点的留痕建议在 T1.4 导出前单独评估。
6. **校验和不含值级信息**：见 §4，值级漂移依赖 T1.2 的 compare；如果后续要求「一键复跑必须检出值漂移」，需要在 CLI 侧提供内容摘要能力（能力下沉原则）。
7. **`columns[].nonNull` 仍是既有估算值**（`mapColumnInfo` 用 totalRows 填充），未参与校验和，本任务未改动该行为。
8. **WS 协议未契约化**：`manifest` 字段目前只由 TS 类型约束（`GovioNodeCreateEvent` / `CanvasEvent` 各写一份），X2 落地后应收敛到单一 schema。`docs/specs/05-store.md` 未逐字段列举 node data，本次只更新了 `02-nodes.md` 与 `06-backend.md`。
