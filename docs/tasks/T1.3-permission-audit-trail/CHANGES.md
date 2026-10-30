# T1.3 改动清单

分支 `feature/phase1-trusted-analysis`。共 13 个文件（2 新增代码 / 1 新增脚本 / 7 修改代码 / 3 文档，含本目录三件套）。

## 新增文件

| 文件 | 摘要 |
|------|------|
| `server/permission-audit.ts` | 权限确认审计留痕（216 行）。导出：`PERMISSION_AUDIT_VERSION`(=1)、三类记录类型 `PermissionRequestAuditEntry` / `PermissionDecisionAuditEntry` / `PermissionModeAuditEntry`（+ 联合 `PermissionAuditEntry`、写入入参 `PermissionAuditEntryInput`）、`PermissionDecisionSource`(`user`/`accept-all`/`timeout`/`abort`/`reset`)、`auditPathFor()`(`<session-file>.audit.jsonl`)、`setAuditSessionResolver()` / `currentAuditSession()`（会话归属注入）、`appendPermissionAudit()`（追写，补齐 `v`/`sessionId`/`sessionFile`，失败返回 null 不抛错）、`parsePermissionAuditLine()`（坏行返回 null）、`readPermissionAudit()`、`deletePermissionAudit()`（幂等）。文件头写明三条设计约束（只追加不回改、写失败不阻断确认流、不记数据内容）；文件末尾带 `NODE_ENV !== production` 自检（sidecar 命名、空行/坏行/缺 decisionId 的跳过、无解析器时退化为无会话），沿用 `session-history.ts` / `analysis-manifest.ts` 的自检惯例。只依赖 `node:fs` / `node:path` + 一个 type-only 导入，无反向业务依赖 |
| `scripts/verify-permission-audit.ts` | 可复跑验证脚本（`npm run verify:audit`，483 行 / 86 项断言，失败退出码 1）。七节：条目格式与 allow、deny+edit（改前改后命令）、timeout/abort/Accept All 模式事件/reset、Manifest 关联（toolCallId 优先 + 命令文本兜底 + 空白容错）、真实扩展事件流（stub pi 驱动 `tool_call`→`tool_result`→节点事件，含 edit 重发链与 `followsDecisionId`）、JSONL 追加/多行命令不拆行/坏行容错/`deleteSession` 三文件同删、无会话归属时不阻断确认流。不调 govio-cli、不调模型、不读数据内容 |

## 修改文件

### 服务端

| 文件 | 改动 |
|------|------|
| `server/permission-manager.ts` | 从 84 行的内部类改造为可测的确认门 + 审计写入点（255 行）：① **导出 `PermissionManager` 类**（单例 `permissionManager` 保留），构造参数 `{ timeoutMs?: number }` 供验证脚本用短超时；② `PermissionResponse` 增加 `decisionId`，新增 `PermissionDecisionInput = Omit<PermissionResponse,"decisionId">` 作为 `resolve()` 入参类型（**决策 ID 由 manager 从挂起记录补，WS 输入无法伪造审计键**）；③ `requestPermission(command, toolCallId?)` 生成 `pd-<uuid>`，写 `permission_request` 条目（`gate: ask` / `accept-all`，命中上一次 edit 的改后命令时带 `followsDecisionId`），超时分支写 `source: "timeout"` 条目，放行分支写请求 + 决策两条（`elapsedMs` 显式传 0，避免量到写盘耗时）；④ `resolve()` 写 `source: "user"` 决策条目并维护索引（allow → 原命令 + toolCallId；edit → **改后**命令）；⑤ `denyPending(reason, source = "abort")` 逐条写决策条目后 resolve；⑥ `setAcceptAll()` 判等短路（状态真变才写 `permission_mode`，`pm-<uuid>`）；⑦ `clearAll()` 先补一条 `acceptAll: false` 模式事件（带 `pendingAffected`）再 `denyPending("会话已重置", "reset")`；⑧ 新增 `decisionIdForExecution(command, toolCallId?)`（toolCallId 精确匹配 → 命令归一化兜底）与私有 `indexDecision()` / `remember()`（两张索引各封顶 200 条，插入序淘汰最旧）；⑨ 超时提示文案改为按实际 `timeoutMs` 计算分钟数 |
| `server/extensions/govio-canvas.ts` | ① `tool_call` handler **删掉 `if (permissionManager.isAcceptAll()) return;` 早退**（放行期也要留痕；manager 内部照样直接允许，行为不变），改为 `requestPermission(cmd, event.toolCallId)`；② `handleLoadResult()` 新增第 4 个入参 `permissionDecisionId: string \| null`，透传进 `buildManifest({ permissionDecisionId })`；③ `tool_result` 的 `load` 分支传 `permissionManager.decisionIdForExecution(cmd, event.toolCallId)` |
| `server/session-history.ts` | `deleteSession()` 在删 transcript 与 canvas sidecar 之后补 `deletePermissionAudit(resolved)`（审计 sidecar 与会话同生命周期）；`canvasPathFor()` 加注释指向同目录的审计 sidecar；新增 `deletePermissionAudit` 导入 |
| `server/agent.ts` | 模块加载时调用 `setAuditSessionResolver()`，闭包读当前会话单例的 `sessionId` 与 `sessionManager.getSessionFile()`（取不到/抛错时退化为 `sessionFile: null`）；避免 `permission-audit → agent` 的反向依赖形成循环导入 |
| `server/analysis-manifest.ts` | 仅注释：`BuildManifestInput.permissionDecisionId` 与 `buildManifest()` 里的说明从「T1.3 落地前恒为 null / 当前透传」改为实际语义（只有过确认门的 `observe-load` 有值；显式写 null 以区分「没过确认门」与「旧节点无该字段」）。逻辑与 `MANIFEST_SCHEMA_VERSION`(=1) 未变——字段结构在 T1.1 就已定义 |

### 前端

| 文件 | 改动 |
|------|------|
| `src/types/manifest.ts` | 仅注释：`AnalysisManifest.permissionDecisionId` 从「预留，T1.3 落地后填充」改为实际语义（值 = 确认门的 `decisionId`，可在 `<session-file>.audit.jsonl` 按该 ID 查到命令原文/决策/决策人/时间；`null` = 没过确认门，`undefined` = 旧节点无该字段），文件头下游消费者一行同步。**无类型结构变更**，故 `ManifestDetails.tsx` 的「权限决策」行不需要改 |

`src/hooks/useChat.ts`、`src/components/Chat/PermissionCard.tsx`、`server/ws-handler.ts`、`server/govio-node-queue.ts` **未改动**：WS 协议字段没变（`decisionId` 与前端回传的 `requestId` 同值，不上行不下行），审计写入全部发生在 manager 内部，`tool_permission_response` / `permission_accept_all` / `abort` / `clear` / `session_open` 各路径自动被覆盖。

### 配置与文档

| 文件 | 改动 |
|------|------|
| `package.json` | 新增脚本 `"verify:audit": "tsx scripts/verify-permission-audit.ts"`（无新依赖，复用既有 `tsx`） |
| `docs/specs/10-observe-load-permission.md` | ① 新增「审计留痕（Phase 1 KR3）」一节：sidecar 路径与生命周期、三类记录字段表、`source` 语义、decisionId 与 Manifest 的双向反查、edit 链（`followsDecisionId`）、不记录的内容与失败策略；② 架构图补审计写入与索引/回填两步；③ 把与现状不符的旧设计稿改为当前 API（`requestPermission(cmd, toolCallId?)`、单例 `acceptAll`、`clearAll()`、`setAcceptAll(true)`、`decisionIdForExecution`），并在 govio-canvas 稿里补 `tool_result` 回填 Manifest 的片段；④「测试」补 `npm run verify:audit`；⑤「待确认（实现时验证）」改为「已确认」并写下两条结论（ctx 提供 sessionId/sessionFile，但 accept_all/abort/clear 路径拿不到 ctx，故审计归属走 agent.ts 解析器；`block:true` 的 reason 会被 agent 读取并重试） |
| `docs/specs/06-backend.md` | ① 文件结构表补 `server/permission-audit.ts`，`permission-manager.ts` / `session-history.ts` 职责描述更新；② `getOrCreateSession()` 的会话文件清单补审计 sidecar 一行 + `agent.ts` 注册解析器说明；③ 新增「permission-audit.ts - 权限确认审计留痕」一节（存储表、记录类型表、导出函数表、与 Manifest 的关联、验证命令）；④ `dataframe-rerun.ts` 一节里「确认记录关联属于 T1.3」改为 T1.3 已落地、复跑仍无 decisionId 的现状说明 |
| `docs/task-plan.json` | T1.3 `status` 按状态协议 `pending → in_progress → done` + `history` 追加两条 + 顶层 `updatedAt` 刷新 |
| `docs/tasks/T1.3-permission-audit-trail/*` | 本任务三件套交付物 |

## 未改动但相关的既有行为（确认无回归）

- **WS 协议零变更**：`tool_permission_request` 仍是 `{requestId, command}`，`tool_permission_response` 仍是 `{requestId, decision, editedCommand?, reason?}`，`permission_accept_all` 仍无字段。前端 4 个按钮（允许/拒绝/Accept All/编辑）行为不变。
- **确认门触发条件不变**：`shouldAskPermission()` 未动，仍只拦 `observe load` + `-o`。
- **放行模式的执行语义不变**：删掉的早退分支与 manager 内部的 `if (this.acceptAll)` 等价（都不 block、立即 allow），只是多写两条审计记录。
- **5 分钟超时、abort/clear 自动 deny、pending 清理**逻辑不变，只多了审计写入与 `source` 标注。
- T1.1 的 Manifest 其余字段与 `npm run verify:manifest`（52 项）、T1.2 的复跑链路与 `npm run verify:rerun`（62 项）全部照旧通过。
