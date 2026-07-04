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
  → permission-manager.requestPermission(sessionId, cmd)
      ├─ acceptAll[sessionId] === true → resolve({decision:"allow"})
      ├─ 否则：emit "permission_request" 给 ws-handler
      │     → ws.send({type:"tool_permission_request", requestId, command})
      │     → 前端渲染 PermissionCard
      │     → 用户点击 → ws.send({type:"tool_permission_response", requestId, decision, editedCommand?})
      │     → ws-handler 转发回 permission-manager.resolve(requestId, decision)
      └─ 同时监听 session abort → resolve({decision:"deny", reason:"用户中止"})
  → handler 返回 ToolCallEventResult
      ├─ allow  → 不返回 block，bash 继续执行
      └─ deny   → { block:true, reason:"用户拒绝执行该命令" }
      └─ edit   → { block:true, reason:"用户修改为：<editedCommand>，请使用该命令" }
```

### 关键约束

- `tool_call` handler 返回 `Promise<ToolCallEventResult>`，pi-coding-agent 会 await，因此可以阻塞等待用户响应。
- acceptAll 状态是 per-session 内存，不持久化。`resetSession()` 时清空。
- pending request 在 session abort 时自动 deny，避免 Promise 永远挂起。

## 模块

### `server/permission-manager.ts`（新增）

```ts
export type PermissionDecision = "allow" | "deny" | "edit";

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  command: string;
}

export interface PermissionResponse {
  decision: PermissionDecision;
  editedCommand?: string;
  reason?: string;
}

class PermissionManager {
  private acceptAll = new Map<string, boolean>();            // sessionId → bool
  private pending = new Map<string, {
    resolve: (r: PermissionResponse) => void;
    sessionId: string;
    timer: NodeJS.Timeout;
  }>();

  setAcceptAll(sessionId: string, value: boolean): void;
  isAcceptAll(sessionId: string): boolean;
  clearSession(sessionId: string): void;                     // reject 所有 pending

  // 发起请求；监听器负责把 request 推给前端
  requestPermission(sessionId: string, command: string): Promise<PermissionResponse>;
  // ws-handler 收到前端响应后调用
  resolve(requestId: string, response: PermissionResponse): void;
  // 注册推送回调（ws-handler 启动时调用）
  onRequest(callback: (req: PermissionRequest) => void): () => void;
}

export const permissionManager = new PermissionManager();
```

pending 请求设 5 分钟超时自动 deny，防止泄漏。

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

  const sessionId = pi.getSessionId?.() ?? "default";
  if (permissionManager.isAcceptAll(sessionId)) return; // 放行，不 block

  const result = await permissionManager.requestPermission(sessionId, cmd);
  if (result.decision === "allow") return;
  // deny 或 edit 都 block；edit 时把新命令写进 reason 让 agent 重新发起
  return {
    block: true,
    reason: result.decision === "edit" && result.editedCommand
      ? `用户将该命令修改为：${result.editedCommand}，请改用此命令`
      : result.reason || "用户拒绝执行该命令",
  };
});
```

> `isToolCallEventType` 已由 pi-coding-agent 导出。sessionId 获取方式见下方"待确认"。

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
    permissionManager.setAcceptAll(session.sessionId, true);
    break;
  ```
- `clear`（resetSession）case 中调用 `permissionManager.clearSession(oldSessionId)`。
- abort case 中也调用 `permissionManager.clearSession(sessionId)` 把 pending 全 deny。

### `server/agent.ts`（修改）

`resetSession` 改为接受 sessionId 参数，或在调用处先取 sessionId 再 reset，确保 permission-manager 能清理对应会话。

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
- permission-manager 单元测试：allow/deny/edit/timeout/acceptAll/clearSession。
- 前端手动验证：触发 `observe load -o` 命令，分别点 4 个按钮，确认 agent 行为符合预期。

## 待确认（实现时验证）

1. `ExtensionAPI` 是否暴露当前 sessionId？若无，用单一全局 sessionId（当前架构只有一个 session）。
2. `tool_call` handler 返回 `block:true` 后，agent 是否会读取 `reason` 并据此重试？需实测。
