# X2 验证：WS 协议契约化

## 验证门槛（全绿）

| 命令 | 结果 |
|---|---|
| `npm run build` | ✓（tsc -b + vite build，2466 模块） |
| `npm run lint` | ✓（eslint 无告警） |
| `npm run verify` | ✓（verify:manifest/rerun/audit/export/source-table/cwd + verify:integration 全过） |
| `git status --porcelain`（verify 全跑后） | 干净（verify 不留残留物；工作区仅本任务交付文件，随单次 commit 提交） |

## 断言数变化

| 项 | 基线（HEAD 7dc7c4c） | 本任务后 | 变化 |
|---|---|---|---|
| verify 脚本断言 | 92+71+119+126+39+13 = 460 | 460 | 0（零回归） |
| 集成测试用例 | 38（X4，4 文件） | 57（5 文件） | **+19**（新增 tests/integration/ws-protocol.test.ts） |

## 新增契约测试覆盖（19 用例 / 5 组）

1. **注册表版本化**（3）：`PROTOCOL_VERSION === WS_PROTOCOL.version === 1`；42 条消息 schema 全部
   携带 `$id: govio-ws/v1/<type>` + `version` 字段；消息全集 17（客户端）+ 25（服务端）与样本清单
   **双向对齐**（漂移防护）。
2. **合法收发匹配 schema**（3）：客户端 17 类 + 服务端 25 类样本通过联合与成员双重校验；
   附加字段容忍、缺字段不拒（兼容策略 3/4）。
3. **拒绝路径**（6）：非法 JSON（`String(err)` 原文案）、非对象 JSON（5/`"str"`/`[]`/`null`）、
   未知 type 点名、缺 type、形状非法 5 例（`content: 123`、`decision: "maybe"`、
   `referencedNodes: "x"`、`nodes: "x"`、`beforeEntryId: 42`）、合法消息原样返回。
4. **端到端**（5，真实 `setupWebSocket` + ws 客户端，mock pi session）：未知 type → 回
   `unknown message type: ...` 且连接不断（后续 abort 正常）；形状非法 → 回 `invalid message: ...`；
   非法 JSON → `SyntaxError: ...` 原文案；合法消息（prompt/canvas_save/steer，含附加字段）不被拒；
   **服务端实发的每条消息逐条 `Value.Check(WSServerMessageSchema)`** 并覆盖
   session_ready/models_config/queue_cleared/model_set/error 五条真实链路。
5. **无重复定义回归防护**（1）：源码扫描断言 ws-handler.ts 无 `interface WSMessage`、
   useChat.ts 无 `interface WSEvent`，双端经 `parseWSClientMessage`/`sendMsg`/`sendClientMessage` 收口。

## 编译期契约保障（build 门槛覆盖）

- 服务端全部 `/ws` 发送经 `sendMsg(ws, WSServerMessage)`、客户端全部出站经
  `sendClientMessage(ws, WSClientMessage)`——新增/改字段不匹配契约即构建失败；
- `handleNormalMessage` 的 `default: assertNever(msg)`：契约新增消息类型未落 case 即构建失败；
- 收端 `WSServerMessage` 判别联合按 `type` 收窄，字段误用即构建失败。

## 逐字节等价抽查

- X4 既有 38 用例全数复跑通过（含非法 JSON error 文案、`session_open requires path`、
  越界路径拒绝、canvas_save 静默等行为断言）；
- 发送路径仅换包装（同对象字面量 JSON.stringify，键序不变）；合法消息的处理逻辑逐字未动。
