# X2 设计：WS 协议契约化（版本化 schema + 双端类型单一来源）

## 背景与目标

`/ws` 通道消息双端靠内联 interface 与裸 JSON 手工对齐（`server/ws-handler.ts` 的 `WSMessage`、
`src/hooks/useChat.ts` 的 `WSEvent`），新增消息易漂移、缺编译期保障。目标：版本化契约 +
双端类型单一来源 + 运行时入站把关 + 契约测试，**纯契约化、不改消息语义**。

## 方案取舍

### 1. 共享模块 vs 生成脚本

**选共享模块** `src/types/ws-protocol.ts`（typebox schema + `Static<>` 派生类型）：

- 生成脚本（schema → d.ts）多一步构建同步，且生成物易与手写代码再漂移；
- 共享模块是仓库既有先例（`src/types/models-config.ts` 被 server 与 src 双端消费），
  typebox 已在 dependencies 且有先例（`server/observe-load-schema.ts`、
  `server/extensions/govio-canvas.ts`）；
- 客户端只 `import type`（类型层零运行时成本，typebox 不进前端 bundle）；服务端
  `parseWSClientMessage` 运行时用 `Value.Check` 校验。

### 2. version 字段落点：契约元数据层，不上线

约束「消息字段、时序、错误处理行为逐字节等价」与「含 version 字段」存在张力。取舍：

- `PROTOCOL_VERSION = 1`、注册表 `WS_PROTOCOL.version`、每条 schema 的
  `$id: "govio-ws/v1/<type>"` + `version: 1` 字段——版本化落在 schema（元数据）层；
- 线上消息**不加**版本字段（保持逐字节等价）；v1 版本语义由「同仓同构建的部署对」隐式携带；
- 跨版本协商的演进路径：新增 hello/握手消息携带 version，而非给 42 条存量消息逐条加字段
  （见遗留问题）。

### 3. 字段必需性：镜像改造前 interface（全 Optional），拒绝面只覆盖「形状非法 + 未知 type」

acceptance 要求「非法/未知消息拒绝路径」，同时 scope 要求「错误处理行为逐字节等价」。取舍：

- **拒绝**：未知 `type`（此前静默忽略）、字段类型/字面量漂移（如 `content: 123`、
  `decision: "maybe"`，此前被隐式强转/吞掉）——这是 acceptance 点名的唯一行为收紧；
- **不拒**：缺字段（如无 content 的 prompt、缺 path 的 session_open）——保持原 handler
  guard 的错误文案（`session_open requires path` 等），X4 既有 38 用例零回归的前提；
- 非法 JSON 的 error 文案保持 `String(err)`，与改造前回包逐字节一致。

### 4. 开放载荷松绑

`args`（SDK `unknown`）、`nodes/edges`（React Flow）、`dataframes/info`（govio-cli JSON
透传）在契约中为 unknown/宽松对象——schema 管信封与控制消息的形状合法，开放载荷形状由
消费端自校验（与改造前 useChat 的松散处理等价，避免误拒合法载荷）。

## 实现

### 契约模块 `src/types/ws-protocol.ts`

- 载荷构件：`WSReferencedNode`、`WSPermissionDecision`、`WSDisplayToolCall`、
  `WSTranscriptMessage`、`WSSessionListItem`、`WSDataFrameSummary`、`WSObserveInfo`、
  `WSModelsConfig`；
- `WSClientMessageSchema`（17 类联合）/ `WSServerMessageSchema`（25 类联合），
  派生 `WSClientMessage` / `WSServerMessage`（判别联合，按 `type` 收窄）；
- `WS_PROTOCOL` 注册表（version + 双向消息 schema 映射，测试/文档生成用）；
- `parseWSClientMessage(raw)`：JSON 解析 + type 路由 + `Value.Check` 形状校验；
- `WSClientMessageOf<T>`：按 type 字面量提取成员（`makePrompt` 等非 switch 上下文收窄）。

### 服务端 `server/ws-handler.ts`（机械改造）

- 删除内联 `interface WSMessage`，改用契约类型；
- 50 处 `/ws` 发送统一走 `sendMsg(ws, msg: WSServerMessage)`（编译期对齐，JSON 字节不变）；
  `/canvas` 通道 3 处发送不动（不在 /ws 契约范围）；
- 3 个 `ws.on("message")` 监听接入 `parseWSClientMessage` 拒绝路径（未知/非法 → 回
  `error`，连接不断）；
- `handleNormalMessage` switch 补 `default: assertNever(msg)`——编译期穷尽校验，契约新增
  消息类型必须落 case 否则构建失败。

### 客户端 `src/hooks/useChat.ts`（机械改造）

- 删除松散 `interface WSEvent`，入站按 `WSServerMessage` 判别联合收窄（switch 无 default，
  未知服务端消息忽略不崩=兼容策略 1）；
- 20+ 处出站经 `sendClientMessage(ws, msg: WSClientMessage)` 编译期对齐；
- 线上载荷形状（`DataFrameSummary`/`ObserveInfo`/`SessionListItem`/`PermissionDecision`）
  改为契约类型别名再导出，UI 导入路径不变；
- 唯一的边界 cast：`tool.args`（wire `unknown` → UI `Record|string`），与既有
  `as ChatMessage[]` / `as Node[]` 边界 cast 同一惯例。

### 契约测试 `tests/integration/ws-protocol.test.ts`（19 用例）

注册表完整性（版本/`$id`/消息全集双向对齐）→ 合法样本 42 条匹配 schema → 拒绝路径
（非法 JSON/非对象/未知 type/形状非法）+ 容忍规则 → 端到端真实 ws 通道（未知/非法入站被拒、
合法不被拒、服务端实发消息逐条匹配 schema）→ 无重复定义回归防护（源码扫描）。
经 `verify:integration` 纳入 `npm run verify` 聚合。

## 逐字节等价的保证方式

- 发送路径仅替换包装函数（`JSON.stringify` 同对象字面量，键序不变）；
- 接收路径对**合法**消息的处理逻辑逐字未动（handler guard/错误文案/时序保留）；
- X4 既有 38 用例（含非法 JSON、session_open 缺 path/越界等错误文案断言）全数复跑通过。

## 遗留问题

1. **`/canvas` 通道未契约化**：`canvas_ready`/`govio_node_create` 仍是裸 JSON（GovioNodeCreateEvent
   在 `govio-node-queue.ts` 有接口）。若后续要契约化，可复用本模式；
2. **wire-level 版本协商**：如客户端独立发版，需新增 hello 消息携带 `version` 并定义协商/降级
   规则（本设计已预留演进路径，未实施）；
3. **平行类型的引用化**：`session-history.ts` 的 `DisplayMessage/SessionListItem`、
   `permission-manager.ts` 的 `PermissionDecision` 仍是自有定义，靠编译期结构对齐兜底
   （形状漂移会令 `sendMsg`/`resolve` 调用点构建失败）。彻底单一来源需改这两个文件，
   超出本次「只动 ws-handler/useChat 类型层」范围；
4. **steer 消息的 `referencedNodes` 服务端忽略**（仅 prompt 消费）——schema 按线上事实收录，
   语义归 T2.1/后续任务；
5. **`queue_update` 前端未消费**（schema 已收录，useChat 无 case，按兼容策略 1 忽略）；
6. **`observe_info_result.info` 可能为 `null`**（govio-cli JSON 透传），schema 显式收录
   `info | null`，前端 `?? {}` 处理；若 CLI 输出形状固化后可收紧。
