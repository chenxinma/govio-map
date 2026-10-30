# `govio-cli observe load -o` 执行权限拦截设计

## 背景

`govio-cli observe load -o <output>` 会将数据内容写出/显示。当 agent 自动生成该命令时，存在未经用户许可即导出敏感数据的风险。需要在前端向用户请求许可，用户可一次性 Accept All（本会话内）或拒绝/编辑命令后执行。

## 触发条件

匹配规则（在 `tool_call` 事件中，`toolName === "bash"`）：

- 命令中含 `govio-cli observe load` 子串
- 且命令中含 `-o` 标志的任意形式：
  - `-o` / `--output`（独立 token）
  - `-o=xxx` / `--output=xxx`
  - `-oxxx`（短选项紧跟值，仅当 `-o` 后非空格）
  - `-o xxx` / `--output xxx`

实现用单一正则：`/govio-cli\s+observe\s+load\b[\s\S]*?(?:^|\s|=)-(?:o|--output)(?:=|\s|$)/`，再配合 `/\bgovio-cli\s+observe\s+load\b/` 与 `/(?:^|\s|=)(?:-o|--output)(?=\s|=|$)/` 两条分别匹配后取交集，避免误判。

## 架构

```
agent → bash tool_call 事件
  → govio-canvas.ts tool_call handler
  → permission-manager.requestPermission(cmd, toolCallId)   // 生成 decisionId，先写一条 permission_request 审计条目
      ├─ acceptAll === true → resolve({decision:"allow", decisionId})   // 不打扰前端，但同样写审计（source:"accept-all"）
      ├─ 否则：emit "permission_request" 给 ws-handler
      │     → ws.send({type:"tool_permission_request", requestId, command})
      │     → 前端渲染 PermissionCard
      │     → 用户点击 → ws.send({type:"tool_permission_response", requestId, decision, editedCommand?})
      │     → ws-handler 转发回 permission-manager.resolve(requestId, decision)
      └─ 同时监听 session abort → resolve({decision:"deny", reason:"用户中止"})（source:"abort"）
  → handler 返回 ToolCallEventResult
      ├─ allow  → 不返回 block，bash 继续执行
      └─ deny   → { block:true, reason:"用户拒绝执行该命令" }
      └─ edit   → { block:true, reason:"用户修改为：<editedCommand>，请使用该命令" }
  → 决策落定时追加一条 permission_decision 审计条目（allow/deny/edit、改前改后命令、reason、耗时）
  → allow/edit 的决策进入「toolCallId / 命令 → decisionId」索引；随后 observe load 的 tool_result
    建 dataFrame 节点时把 decisionId 写进 node.data.manifest.permissionDecisionId
```

### 关键约束

- `tool_call` handler 返回 `Promise<ToolCallEventResult>`，pi-coding-agent 会 await，因此可以阻塞等待用户响应。
- acceptAll 是**单例内存态**（当前架构同时只有一个活动会话），不持久化；`clearAll()`（清空/切换会话）时关闭。开关每次真正变更都写一条 `permission_mode` 审计条目。
- pending request 在 session abort 时自动 deny，避免 Promise 永远挂起。
- 审计写入是「尽力而为」：落盘失败只告警，绝不阻断确认流或命令执行（见下文「审计留痕」）。

## 模块

### `server/permission-manager.ts`

```ts
export type PermissionDecision = "allow" | "deny" | "edit";

export interface PermissionRequest {
  requestId: string;      // 前端回传的关联令牌；与审计/Manifest 里的 decisionId 同值
  command: string;
}

export interface PermissionResponse {
  decision: PermissionDecision;
  decisionId: string;     // 审计日志与 Manifest.permissionDecisionId 的关联键（"pd-<uuid>"）
  editedCommand?: string;
  reason?: string;
}

/** resolve() 的入参：decisionId 由 manager 从挂起记录里补，调用方无法伪造 */
export type PermissionDecisionInput = Omit<PermissionResponse, "decisionId">;

export class PermissionManager {
  constructor(options?: { timeoutMs?: number });               // 默认 5 分钟，验证脚本用短超时

  setAcceptAll(value: boolean): void;                          // 状态真变了才记 permission_mode 事件
  isAcceptAll(): boolean;
  clearAll(): void;                                            // 关放行 + denyPending("会话已重置", "reset")
  denyPending(reason: string, source?: PermissionDecisionSource): void;

  // 发起请求；监听器负责把 request 推给前端。acceptAll 时不打扰前端，但一样留痕。
  requestPermission(command: string, toolCallId?: string): Promise<PermissionResponse>;
  // ws-handler 收到前端响应后调用（source 记为 "user"）
  resolve(requestId: string, response: PermissionDecisionInput): void;
  // observe load 建节点时回填 Manifest 用：toolCallId 精确匹配，命令文本兜底
  decisionIdForExecution(command: string, toolCallId?: string): string | null;
  // 注册推送回调（ws-handler 启动时调用）
  onRequest(callback: (req: PermissionRequest) => void): () => void;
}

export const permissionManager = new PermissionManager();
```

pending 请求设 5 分钟超时自动 deny（`source: "timeout"`），防止泄漏。单例之外还导出类本身，供验证脚本构造短超时/隔离索引的实例。

### `server/extensions/govio-canvas.ts`（修改）

新增：

```ts
import { permissionManager } from "../permission-manager.js";

function shouldAskPermission(cmd: string): boolean {
  if (!/\bgovio-cli\s+observe\s+load\b/.test(cmd)) return false;
  return /(?:^|\s|=)(?:-o|--output)(?=\s|=|$)/.test(cmd);
}

pi.on("tool_call", async (event) => {
  if (!isToolCallEventType("bash", event)) return;
  const cmd = event.input.command;
  if (!shouldAskPermission(cmd)) return;

  // 全局放行也走 requestPermission（manager 内部直接允许）：否则放行期间的取数没有任何留痕
  const result = await permissionManager.requestPermission(cmd, event.toolCallId);
  if (result.decision === "allow") return;
  // deny 或 edit 都 block；edit 时把新命令写进 reason 让 agent 重新发起
  return {
    block: true,
    reason: result.decision === "edit" && result.editedCommand
      ? `用户将该命令修改为：${result.editedCommand}，请改用此命令`
      : result.reason || "用户拒绝执行该命令",
  };
});

pi.on("tool_result", async (event, ctx) => {
  // … observe load 分支：建 dataFrame 节点时反查决策 ID，写进 Manifest
  await handleLoadResult(cmd, stdout, piSessionContext(ctx),
    permissionManager.decisionIdForExecution(cmd, event.toolCallId));
});
```

> `isToolCallEventType` 已由 pi-coding-agent 导出。关联键优先用 pi 的 `toolCallId`（同一次调用的 tool_call / tool_result 共享，精确一对）；命令文本作兜底（匹配前折叠空白），覆盖 `edit` 后 agent 重发的命令——那是一次新的工具调用，没有自己的确认记录。

### `server/ws-handler.ts`（修改）

- `subscribeToSession` 中订阅 `permissionManager.onRequest`，把 request 通过 `/ws` 推给前端：
  ```ts
  ws.send(JSON.stringify({ type: "tool_permission_request", requestId, command }));
  ```
- `ws.on("message")` 新增 case：
  ```ts
  case "tool_permission_response":
    permissionManager.resolve(msg.requestId, {
      decision: msg.decision,
      editedCommand: msg.editedCommand,
      reason: msg.reason,
    });
    break;
  case "permission_accept_all":
    permissionManager.setAcceptAll(true);   // 写一条 permission_mode 审计条目
    break;
  ```
- `clear` / `session_open` case 中调用 `permissionManager.clearAll()`（关放行 + pending 全 deny，审计来源 `reset`）。
- abort case 中调用 `permissionManager.denyPending("用户中止")`（审计来源 `abort`）。
- WS 协议本身**未因审计而改变**：`decisionId` 不上行也不下行，它只存在于服务端审计日志与节点 Manifest。

### `server/agent.ts`（修改）

模块加载时调用 `setAuditSessionResolver()`，把「当前会话 ID + transcript 文件路径」供给审计模块（会话单例在 agent.ts，反向依赖会形成循环导入）。会话尚未落盘时 `getSessionFile()` 返回 undefined，此时审计条目只告警不写盘。

### 前端 `src/hooks/useChat.ts`（修改）

新增状态：

```ts
interface PendingPermission {
  requestId: string;
  command: string;
}
const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
```

`onmessage` 新增 case：

```ts
case "tool_permission_request":
  setPendingPermission({ requestId: data.requestId, command: data.command });
  break;
```

新增方法：

```ts
const respondPermission = useCallback((decision: "allow" | "deny" | "edit", editedCommand?: string) => {
  const ws = wsRef.current;
  if (!ws || !pendingPermission) return;
  const payload: Record<string, unknown> = {
    type: "tool_permission_response",
    requestId: pendingPermission.requestId,
    decision,
  };
  if (editedCommand) payload.editedCommand = editedCommand;
  if (decision === "allow") {
    // 用户主动点 allow 时不自动开启 acceptAll；acceptAll 由独立按钮触发
  }
  ws.send(JSON.stringify(payload));
  setPendingPermission(null);
}, [pendingPermission]);

const acceptAllPermission = useCallback(() => {
  const ws = wsRef.current;
  if (!ws || !pendingPermission) return;
  ws.send(JSON.stringify({
    type: "tool_permission_response",
    requestId: pendingPermission.requestId,
    decision: "allow",
  }));
  ws.send(JSON.stringify({ type: "permission_accept_all" }));
  setPendingPermission(null);
}, [pendingPermission]);
```

`abort` 中清理 `setPendingPermission(null)`。

返回值新增 `pendingPermission, respondPermission, acceptAllPermission`。

### 前端 `src/components/Chat/PermissionCard.tsx`（新增）

特殊消息卡片，含：
- 命令原文（等宽显示，可滚动）
- 4 个按钮：`允许` / `拒绝` / `Accept All` / `编辑`
- 点击「编辑」展开 textarea，初始值为原命令，下方 `执行修改后命令` / `取消` 按钮
- 样式沿用 Supabase dark theme，琥珀色左边框（与 report 节点一致，表示需关注）

### `src/components/Chat/ChatPanel.tsx`（修改）

在 messages 列表下方、ChatInput 上方插入条件渲染：

```tsx
{pendingPermission && <PermissionCard
  pending={pendingPermission}
  onAllow={() => respondPermission("allow")}
  onDeny={() => respondPermission("deny")}
  onAcceptAll={acceptAllPermission}
  onEdit={(cmd) => respondPermission("edit", cmd)}
/>}
```

## 审计留痕（Phase 1 KR3）

每次过确认门的请求与最终决策都追加到会话 transcript 的 sidecar：

```
.govio/sessions/<ts>_<id>.jsonl              会话 transcript
.govio/sessions/<ts>_<id>.jsonl.canvas.json  画布 sidecar
.govio/sessions/<ts>_<id>.jsonl.audit.jsonl  权限审计 sidecar（JSONL，一行一条记录）
```

与 canvas sidecar 同一套生命周期：`deleteSession()` 一并删除（`server/session-history.ts`）；只追加不回改，任何后续动作（复跑、导出）只读它。

### 记录类型

| `type` | 时机 | 关键字段 |
|--------|------|----------|
| `permission_request` | 确认门被触发（含全局放行下的自动确认） | `decisionId`、`command`（命令原文）、`gate`（`ask` / `accept-all`）、`followsDecisionId?` |
| `permission_decision` | 决策落定 | `decision`（allow/deny/edit）、`command`（**改前**）、`editedCommand?`（**改后**）、`reason?`、`source`、`elapsedMs` |
| `permission_mode` | Accept All 开关真正变更 | `acceptAll`、`reason`、`pendingAffected`；`decisionId` 为 `pm-<uuid>` |

三类记录共有字段：`v`（结构版本，当前 1）、`at`（ISO 8601）、`decisionId`、`sessionId`、`sessionFile`。

`source` 区分「用户亲手点的」与「系统代答的」：`user` / `accept-all`（放行模式自动允许）/ `timeout`（5 分钟无响应）/ `abort`（用户中止）/ `reset`（清空或切换会话）。

### decisionId 与 Manifest 的关联

- 一次确认只有一个标识：前端回传时叫 `requestId`，审计与 Manifest 里叫 `decisionId`（`pd-<uuid>`）。
- `observe load` 产生 dataFrame 节点时，`handleLoadResult` 先用 pi 的 `toolCallId` 精确反查（同一次工具调用的确认与结果），未命中时退回命令文本（归一化后比对），把 `decisionId` 写进 `node.data.manifest.permissionDecisionId`；未过确认门的加载（无 `-o`）为 `null`。
- `edit` 决策只索引**改后**命令（原命令已被 block、不会执行）：若改后命令仍带 `-o`，agent 重发时会再过一次确认门，新请求记录用 `followsDecisionId` 指回那次 edit，节点最终关联重发那次的 `decisionId`；若改后命令不再触发确认门（如去掉了 `-o`），节点直接关联该 edit 决策。
- 反查路径：节点「详情」面板的权限决策 ID → 在该会话的 `.audit.jsonl` 里按 `decisionId` 检索，即可拿到命令原文、改前改后、决策人与时间。

### 不记录的内容与失败策略

- 只记命令文本与决策，**不记任何查询结果/数据内容**。
- 写盘失败或拿不到会话文件：只 `console.warn`，`appendPermissionAudit()` 返回 `null`，确认流与命令执行不受影响（「记不上账」不能变成「命令执行不了」）。
- 读取容错：`parsePermissionAuditLine()` 对截断行/手工编辑过的行返回 `null` 而不抛错，一行坏掉不影响整份日志可读。

## WS 协议新增

| 方向 | type | 字段 |
|------|------|------|
| server→client | `tool_permission_request` | `requestId`, `command` |
| client→server | `tool_permission_response` | `requestId`, `decision`("allow"\|"deny"\|"edit"), `editedCommand?` |
| client→server | `permission_accept_all` | （无） |

## 边界与错误处理

- 用户断线重连时若仍有 pending request：服务端 5 分钟超时会自动 deny，agent 收到 block reason 后会向用户说明。前端重连后不会收到历史 pending（YAGNI，不持久化）。
- 同时多个 pending（理论可能但 agent 串行执行工具，实际不会并发）：permission-manager 用 Map 按 requestId 隔离，互不影响。
- abort 时 pending promise 立即 deny，agent 后续不会再等。
- 命令匹配用正则，不解析 argv（避免引入 parser 依赖）。`-o` 出现在文件路径中的极端情况（如 `load --name x -o /tmp/-o`）会被误判为含 `-o` 标志——但这种情况 ask 一下也无害，倾向于保守拦截。

## 测试

- 后端 `shouldAskPermission` 单元测试：覆盖 `-o` / `--output` / `-o=x` / `--output x` / 无 `-o` / `observe compare -o` / 路径含 `-o` 等场景。
- permission-manager 单元测试：allow/deny/edit/timeout/acceptAll/clearAll。
- `npm run verify:audit`（`scripts/verify-permission-audit.ts`，86 项断言）：审计条目格式与成对关系、edit 改前改后命令、超时/中止/重置来源、Accept All 模式事件、放行期自动确认仍留痕、toolCallId/命令→decisionId 索引与 Manifest 回填、真实扩展事件流（stub pi）、JSONL 追加/坏行容错/`deleteSession` 清理。
- 前端手动验证：触发 `observe load -o` 命令，分别点 4 个按钮，确认 agent 行为符合预期，并检查 `.govio/sessions/*.audit.jsonl` 是否如预期追加。

## 已确认（实现时验证的结果）

1. `ExtensionAPI` 的事件 ctx 提供 `sessionManager.getSessionId()` / `getSessionFile()`（Manifest 的会话 ID 取自前者）；审计归属则由 `server/agent.ts` 注册的解析器提供，因为 `permission_accept_all` / abort / clear 这些路径不在扩展事件里，拿不到 ctx。
2. `tool_call` handler 返回 `block:true` 后，agent 会读 `reason` 并据此重试（edit 分支依赖该行为，已实测）。
