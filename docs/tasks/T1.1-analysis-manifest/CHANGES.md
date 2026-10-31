# T1.1 改动清单

分支 `feature/phase1-trusted-analysis`。共 18 个文件（7 新增 / 11 修改；三件套交付物按 3 个文件计，此前误按 1 行计为 16）。

## 新增文件

| 文件 | 摘要 |
|------|------|
| `src/types/manifest.ts` | Analysis Manifest 类型定义（前后端共享，纯类型 + 字段级中文注释）：`AnalysisManifest`、`ManifestChecksum`、`ManifestChecksumAlgorithm`、`ManifestModel`、`ManifestOrigin`；文件头说明下游消费者（T1.2/T1.3/T1.4）与校验和取舍 |
| `server/analysis-manifest.ts` | Manifest 构建与校验和计算：`MANIFEST_SCHEMA_VERSION`、`CHECKSUM_ALGORITHM`、`shortSha256`、`computeChecksum`、`toManifestModel`、`toManifestModelFromMessage`、`piSessionContext`、`agentSessionContext`、`buildManifest`；文件末尾带 `NODE_ENV !== production` 自检（哈希确定性、行数/dtype 变化可检出、无列信息不产出校验和），沿用 `session-history.ts` 的自检惯例。零项目内依赖，避免与 `agent.ts` 形成循环导入 |
| `src/components/Nodes/ManifestDetails.tsx` | 只读 Manifest 折叠面板，dataFrame / sqlQuery 节点共用；展示来源、数据源、执行时间、行×列、校验和、生成模型、会话、权限决策、上游 DF、SQL 全文 |
| `scripts/verify-manifest-roundtrip.ts` | 可复跑验证脚本（52 项断言，失败退出码 1），见 `verification.md` |

## 修改文件

### 服务端

| 文件 | 改动 |
|------|------|
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent` 增加 `manifest?: AnalysisManifest`（type-only 导入 `../src/types/manifest.js`），节点事件透传留痕 |
| `server/extensions/govio-canvas.ts` | ① 新增导出 `extractSqlFromCommand()`：从命令行还原 `--sql` 全文（双/单引号、`--sql=`、多行、转义引号还原、未加引号截到下一个 flag；取不到返回空串）；② `handleLoadResult(cmd, stdout, context)` 新增会话上下文入参，`observe load` 产出的 dataFrame 事件携带 `origin: 'observe-load'` 的 Manifest（SQL 全文、datasource、dfName、行列数、checksum、`sourceDataFrames`），血缘匹配保留 `sqlText \|\| cmd` 回退以不回退既有行为；③ `tool_result` handler 接收 `ctx` 并传 `piSessionContext(ctx)`；④ `govio_show_dataframe` 的 `execute` 接收 ctx，产出 `origin: 'show-dataframe'` 的 Manifest（SQL 为空串，注明不可复跑）；⑤ `message_end` handler 接收 `ctx`，sqlQuery 事件携带 `origin: 'assistant-sql'` 的 Manifest（SQL 全文、模型取助手消息 `provider`/`model`/`responseModel`、`executedAt` 取消息 timestamp），并在无 SQL 代码块时提前 return |
| `server/parquet-api.ts` | `POST /api/execute-sql` 路径：提取 `columns`/`rowCount`/`columnCount` 局部变量，dataFrame 事件携带 `origin: 'sql-editor'` 的 Manifest（SQL 与 datasource 来自请求体原文，会话/模型来自 `agentSessionContext(getSession())`）；新增 `getSession` 导入 |

`server/session-history.ts` 与 `server/ws-handler.ts` **未改动**：sidecar 与 WS 都是整份 node 对象透传，Manifest 随 `node.data` 走。

### 前端

| 文件 | 改动 |
|------|------|
| `src/types/index.ts` | 再导出 manifest 类型；`SQLQueryNodeData` 与 `DataFrameNodeData` 各增加 `manifest?: AnalysisManifest`（带注释） |
| `src/services/canvas-service.ts` | `CanvasEvent` 增加 `manifest?: AnalysisManifest`（type-only 导入 `../types`） |
| `src/store/canvas-store.ts` | `createGovioNode`：sqlQuery / dataFrame 两个分支把 `event.manifest` 写入 `node.data.manifest`；dataFrame 去重分支新增「已有节点缺 Manifest 时回填、已有则不覆盖」逻辑（不静默覆盖原始留痕，漂移判定留给 T1.2） |
| `src/components/Nodes/DataFrameNode.tsx` | 新增 `showManifest` 状态 + 操作栏「详情」按钮（仅有 Manifest 时渲染）+ 操作栏上方的 `ManifestDetails` 面板 |
| `src/components/Nodes/SQLQueryNode.tsx` | 同上（按钮位于「引用/编辑」之后） |

### 配置与文档

| 文件 | 改动 |
|------|------|
| `package.json` | 新增脚本 `"verify:manifest": "tsx scripts/verify-manifest-roundtrip.ts"`（无新依赖，复用既有 `tsx`） |
| `docs/specs/02-nodes.md` | `SQLQueryNodeData` / `DataFrameNodeData` 字段表各补一行 `manifest?` |
| `docs/specs/06-backend.md` | 后端文件表补 `server/analysis-manifest.ts`；`GovioNodeCreateEvent` 字段表补 `manifest` |
| `docs/task-plan.json` | T1.1 `status` 按状态协议更新 + `history` 追加 + 顶层 `updatedAt` 刷新 |
| `docs/tasks/T1.1-analysis-manifest/*` | 本任务三件套交付物 |
