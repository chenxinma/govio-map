# 会话管理：持久化、恢复、历史切换与画布绑定（设计）

日期：2026-09-11
分支：feature/session-management
状态：设计已评审（会话部分确认，画布绑定与删除为追加需求）

## 目标

1. 对话过程中后端把对话记录**实时落盘**；服务重启后自动恢复最近会话并显示到前端。
2. 前端一次性加载最近 **10 轮**对话，可逐步加载更多历史。
3. `/clear` 清空界面与 session 的同时，**开启新的会话文件**。
4. 前端可浏览历史会话文件并**切换**继续此前会话。
5. **画布与会话绑定**：画布状态随会话同步保存，切换/恢复会话时画布一并恢复。
6. 支持**删除**历史会话。

## 现状盘点

- `server/agent.ts`：`createAgentSession` 使用 `SessionManager.inMemory()`，会话不落盘。
- pi SDK 的 `SessionManager` 已自带完整 JSONL 文件持久化（append-only 树）：
  - `SessionManager.create(cwd, sessionDir)` 新建会话文件（构造时即确定路径 `<ts>_<id>.jsonl`）
  - `SessionManager.continueRecent(cwd, sessionDir)` 续接最近会话（无则等价新建）
  - `SessionManager.open(path)` 打开指定历史文件；`SessionManager.list(cwd, dir)` 返回 `SessionInfo[]`（含 path/id/name/created/modified/messageCount/firstMessage）
  - 每条 user/assistant/toolResult 消息由 pi 运行时自动 append，**无需自建写入逻辑**
  - `AgentSession.sessionManager` 可直接访问
- `server/ws-handler.ts`：`clear` 分支已实现 resetSession + 重建；`session_ready` 在 3 处发送。
- 前端 `useChat.ts` 维护 messages 状态（纯内存）；`canvas-store.ts` 用 zustand persist 存 localStorage（跨刷新恢复画布，但与会话无关）。
- 用户消息经 `makePrompt()` 将引用节点拼为 `REF:[{"label": "data"},...]\n` 前缀。

## 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 对话持久化格式 | 复用 pi JSONL 会话文件 | SDK 全套能力白嫖，零自研格式 |
| 存储目录 | `<cwd>/.govio/sessions/` | 项目内聚，不污染用户全局 `~/.pi` |
| 画布快照存储 | 会话文件 sidecar：`<session-file>.canvas.json` | 画布快照是**高频覆盖写**，不适合 append-only JSONL；sidecar 与会话文件同名同目录，生命周期一致 |
| 展示用转写 | 读完整 entries 沿 leaf 路径（`getBranch()`），**不用** `buildSessionContext()` | 后者经 compaction 会丢老消息，展示会缺历史 |
| 分页单位 | “轮”（1 条 user + 其后 assistant/toolResult） | 与需求“最近 10 轮”对齐 |
| referencedNodes 还原 | 解析 user 消息的 `REF:` 前缀提取 label | 不另存自定义 entry；原始 data 含未转义 JSON 不可靠，仅还原 label 展示 |

## 总体架构

```
┌─ 前端 ─────────────────────────────────────────────┐
│ useChat ──/ws──► ws-handler                        │
│   · session_ready 后接收 session_messages_result    │
│     (replace=true) hydrate 消息 + canvas_restore    │
│   · 加载更早 → session_messages{beforeEntryId}      │
│   · 历史列表/切换/删除 → session_list/open/delete    │
│   · canvas store 变更(debounce 1s) → canvas_save    │
│ canvas-store.hydrateSession(nodes, edges)          │
└────────────────────────────────────────────────────┘
┌─ 后端 ─────────────────────────────────────────────┐
│ agent.ts: SessionManager.create/continueRecent/open │
│ session-history.ts: list/transcript分页/delete/画布 │
│ .govio/sessions/                                    │
│   2026-09-11T…_<id>.jsonl          ← pi 自动落盘    │
│   2026-09-11T…_<id>.jsonl.canvas.json ← 画布sidecar │
└────────────────────────────────────────────────────┘
```

## 数据流

### 1. 实时落盘
- `getOrCreateSession()`：服务启动后**首次**创建用 `continueRecent(cwd, dir)`（重启即恢复最近会话，LLM 上下文一并续接）；此后（`/clear`、切换后 reset）一律 `create()` 新文件。用模块级 `resumedOnce` 标志区分。
- 每条消息 pi 自动 append 到当前 `.jsonl`。

### 2. 画布同步保存
- 前端订阅 canvas store 的 nodes/edges 变化，debounce 1s，经 `/ws` 发 `canvas_save {nodes, edges}`。
- 后端写入当前会话 sidecar（覆盖写）。`session_ready` 后前端额外延时补发一次快照，保证 `/clear` 出的新会话也能立刻绑定当前画布。

### 3. 恢复与切换（统一推送）
后端在每次会话建立/切换后统一推送（`pushSessionState`）：
1. `session_ready {sessionId}`
2. `canvas_restore {nodes, edges}`（sidecar 存在时）
3. `session_messages_result {messages, hasMore, oldestEntryId, replace:true}`（最近 10 轮）

触发点：WS 连接建立、`clear`、`session_open`、`save_models_config` 重启会话。

### 4. 分页加载更早
前端点“加载更早消息”→ `session_messages {beforeEntryId: oldestEntryId}` → 后端沿 leaf 路径取该轮之前的 10 轮 → `session_messages_result {replace:false}` → 前端 prepend。

### 5. 历史列表 / 切换 / 删除
- `session_list` → `SessionManager.list()` 按 modified 倒序 → `session_list_result {sessions:[{id,path,name,preview,messageCount,modified}]}`（preview = firstMessage 截断 100 字符）。
- `session_open {path}` → abort 流式 → 取消订阅 → `openSessionFile(path)`（resetSession + `SessionManager.open`）→ 重新订阅 → `pushSessionState`。
- `session_delete {path}` → 校验：resolve 后必须在 sessionDir 内、`.jsonl` 后缀、非当前会话文件 → 删除 jsonl + sidecar → `session_deleted {path}`。

### 6. /clear 语义
现有链路不变：前端清空 messages → 后端 `resetSession()` + 新建。落盘化后“新建”即 `SessionManager.create()` = **新 JSONL 文件**，旧文件自动进入历史列表。画布不清空（需求只涉及对话），随后的 canvas_save 会把当前画布绑定到新会话。

## 转写映射（entries → 前端 ChatMessage）

沿 `getBranch()`（root→leaf）遍历 `type==="message"` 的 entries：

| 源 | 目标 |
|---|---|
| user 消息（string 或 text blocks） | 一轮开始；剥离 `REF:` 前缀 → `referencedNodes`（label + 序号 id，type 置空走默认图标） |
| assistant `text` block | `content`（拼接） |
| assistant `thinking` block | `thinking`（拼接） |
| assistant `toolCall` block | `tools[] {toolName, success:undefined}`，登记 toolCallId 索引 |
| `toolResult` 消息 | 按 toolCallId 回填对应 tool 的 `success = !isError` |

- 消息 id 直接用 entry id（稳定、与前端本地 `msg-N` 不冲突）。
- 空消息（无 text/thinking/tool）跳过。
- 分页：轮数组上 `slice(max(0,end-10), end)`，`hasMore = start>0`，`oldestEntryId` = 页首轮的首 entry id。

## WS 协议增量

前端 → 后端：`session_list`、`session_open {path}`、`session_messages {beforeEntryId?}`、`session_delete {path}`、`canvas_save {nodes, edges}`
后端 → 前端：`session_list_result {sessions}`、`session_messages_result {messages, hasMore, oldestEntryId, replace}`、`session_deleted {path}`、`canvas_restore {nodes, edges}`

## 改动清单

| 文件 | 内容 | 估算 |
|---|---|---|
| `server/session-history.ts`（新增） | sessionDir、listSessions、buildTranscript、deleteSession、canvas sidecar 读写 | ~150 行 |
| `server/agent.ts` | create/continueRecent 切换（resumedOnce）、`openSessionFile(path)` | ~30 行 |
| `server/ws-handler.ts` | 5 个新消息分支、`pushSessionState` 替换 3 处 session_ready 发送 | ~100 行 |
| `src/hooks/useChat.ts` | hydrate/分页/会话列表状态与方法、canvas_save 防抖订阅、canvas_restore 路由 | ~100 行 |
| `src/store/canvas-store.ts` | `hydrateSession(nodes, edges)`（含 syncCountersFromNodes） | ~8 行 |
| `src/components/Chat/ChatPanel.tsx` | “加载更早消息”按钮、历史会话下拉（列表/切换/删除） | ~90 行 |
| `docs/specs/07-websocket-protocol.md` | 补充协议增量 | ~20 行 |

## 边界与取舍

- **画布快照早于首条消息**：`create()` 构造时即确定 jsonl 路径，sidecar 可先写；若用户始终未发消息，jsonl 不落盘，重启后该 sidecar 成孤儿文件（无害，list 只扫 .jsonl）。
- **旧会话无 sidecar**：`canvas_restore` 不发送，前端保留 localStorage 画布，随后 canvas_save 将其绑定进该会话。
- **compaction 后的展示**：转写读完整文件 entries，不受 LLM 上下文压缩影响。
- **流式中切换会话**：`session_open` 前先 abort。
- **多标签页/多连接**：与现状一致（共享单例 session），不在本次范围。

## 明确不做（需要时再加）

- 会话重命名 UI（SDK `appendSessionInfo` 已支持命名，后续可加）
- 画布数据（DataFrame 内容）恢复——仅恢复节点/边结构，数据预览按需重新加载（现有 `restoreCanvas` 机制）
- 会话文件加密/清理策略（保留数量上限等）

## 验证

1. `npm run build`（tsc + vite）通过。
2. 手工链路：对话产生消息 → `.govio/sessions/` 出现 jsonl 且实时增长 → 重启服务 → 前端自动显示最近 10 轮 + 画布恢复 → “加载更早”分页 → 历史列表切换 → 删除 → `/clear` 产生新文件。
