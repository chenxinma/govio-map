# T1.3 权限确认记录进审计留痕 — 设计说明

> 任务：ROADMAP Phase 1 / KR3「取数确认门」
> 分支：`feature/phase1-trusted-analysis`
> 状态：实现完成，`npm run build` + `npm run lint` + `npm run verify:audit`（86 项断言）通过，T1.1/T1.2 验证脚本无回归

## 1. 目标与范围

让「这个数是谁批准的」变成可质证的事实：每次触发取数确认门（`govio-cli observe load` 带 `-o`）都留下**请求**与**最终决策**两条记录，全局放行（Accept All）留下**模式变更**记录，全部追加到会话自己的审计 sidecar；并且当这次确认对应一个 `observe load` 产生的 dataFrame 节点时，把决策 ID 写进节点 Manifest 的 `permissionDecisionId`（T1.1 预留字段），实现「节点 → 确认记录」双向可查。

范围内：`server/permission-audit.ts`（新模块：JSONL 追加/读回/删除 + 会话归属解析）、`server/permission-manager.ts`（decisionId、审计写入、决策索引）、`govio-canvas.ts`（Manifest 回填）、`session-history.deleteSession`（sidecar 清理）、`agent.ts`（会话归属注册）、验证脚本与文档。

范围外（本任务不做）：审计日志的前端查看 UI 与导出附录（T1.4 消费）、集中式/跨会话审计存储与操作者身份（Phase 3 多用户 SSO）、危险命令闸门的扩展（X1 安全基线）、复跑与 SQL 编辑器路径的确认（见 §8 遗留问题）。

## 2. 存储形态：为什么是会话 sidecar + JSONL

```
.govio/sessions/<ts>_<id>.jsonl                会话 transcript（pi 拥有）
.govio/sessions/<ts>_<id>.jsonl.canvas.json    画布快照 sidecar（整份覆盖写）
.govio/sessions/<ts>_<id>.jsonl.audit.jsonl    权限审计 sidecar（逐行追加写）← 本任务新增
```

- **不写进 pi 的 transcript**：`.jsonl` 由 `SessionManager` 拥有并解析，塞自定义条目会有版本兼容风险，且 `buildTranscript()` 会把它当成消息渲染。sidecar 是项目既有惯例（canvas 已经这么做）。
- **追加式 JSONL 而不是整份 JSON 覆盖**：审计是**事实流水**，追加写天然不覆盖历史；进程崩溃最多丢最后一行，而不是整份日志；`jq`/逐行解析即可分析，不需要读完整文件。canvas sidecar 是**状态快照**，覆盖写才对——两者形态不同是刻意的。
- **与会话同生命周期**：`deleteSession()` 已经删 transcript 与 canvas sidecar，本任务在同一处补删审计 sidecar（验收要求）。删会话即删审计，是单机工作台语义；企业侧「删会话不得删审计」属于 Phase 3 的集中式存储职责（§8）。
- **一行一条 + `JSON.stringify`**：命令原文常含换行（多行 SQL），JSON 转义保证不会把一条记录拆成两行（验证脚本第 6 节专门断言）。

## 3. 记录模型

三类记录，共有字段 `v`（结构版本，常量 `PERMISSION_AUDIT_VERSION = 1`）、`at`（ISO 8601）、`decisionId`、`sessionId`、`sessionFile`：

| `type` | 时机 | 专有字段 |
|--------|------|----------|
| `permission_request` | 确认门被触发（含放行模式下的自动确认） | `command`（原文）、`gate`（`ask` / `accept-all`）、`followsDecisionId?` |
| `permission_decision` | 决策落定 | `decision`、`command`（**改前**）、`editedCommand?`（**改后**）、`reason?`、`source`、`elapsedMs` |
| `permission_mode` | Accept All 开关**真正**变更 | `acceptAll`、`reason`、`pendingAffected` |

`source` 区分「用户亲手点的」与「系统代答的」：`user` / `accept-all` / `timeout`（5 分钟无响应）/ `abort`（用户中止）/ `reset`（清空或切换会话）。这一列是审计的核心：`decision: "deny"` 只说明没执行，`source` 才说明**是用户拒绝的还是系统替他拒绝的**。

### 取舍

1. **请求与决策分两条，而不是决策时写一条合并记录**。理由：请求一触发就落盘，进程崩溃/前端断连/用户关掉窗口时仍有「问过但没答」的证据；两条靠 `decisionId` 配对，顺带能算 `elapsedMs`（人工确认耗时，是「确认门是否形同虚设」的观察指标）。代价是记录数翻倍——JSONL 追加写的成本可以忽略。
2. **`edit` 用 `command` + `editedCommand` 两个字段**，而不是只记改后命令。验收明确要求改前改后；而且改前命令是 agent 真实意图的证据（「模型想全表导出，用户改成了抽样」本身就是有价值的审计信息）。
3. **全局放行下的自动确认也写完整两条**（`gate: "accept-all"` / `source: "accept-all"`）。放行模式恰恰是风险最高的时段（没有逐条人工确认），如果不记，审计上会出现一段无法解释的空档，KR3 的「确认记录进 Manifest」也无从关联。为此**删掉了 `govio-canvas.ts` 里 `if (permissionManager.isAcceptAll()) return;` 的早退**——manager 内部本来就会直接允许，行为不变，但留痕补上了。
4. **`elapsedMs` 在自动放行时恒为 0**（显式传入，而不是算差值）。实测发现算差值会把「写请求条目这次的磁盘耗时」量进去（Windows 上约 9ms），对一个没有人工等待的决策是误导信息。
5. **模式事件只在开关真变时写**（`setAcceptAll` 首行判等返回）。前端每次点 Accept All 都会发一条 `permission_accept_all`，不判等会产生重复噪音；代价是「用户重复确认放行」这个动作不留痕，但每次放行的**命令**都留痕，信息不丢。
6. **`clearAll()` 也会补一条 `acceptAll: false` 的模式事件**（仅当此前是开启状态）。任务书只要求记录 `permission_accept_all`，但只记开不记关，日志里就无法判断某条命令执行时放行是否还生效——关闭事件是开启事件的必要对称面。`pendingAffected` 记录变更时挂起的请求数（关闭时它们会被自动拒绝）。
7. **不记录的东西**：查询结果/数据内容（项目纪律「非必要不读取数据内容」，审计也不需要）、模型响应、操作者身份（单机单用户，`source` 已足够；Phase 3 多用户时再加 `actor` 字段，届时 `v` 递增）。

## 4. decisionId：一个标识，两个名字

一次确认只生成**一个** ID：`pd-<uuid>`（模式事件用 `pm-<uuid>`，便于检索）。它在 WS 协议里叫 `requestId`（前端原样回传，协议未变），在审计日志与 Manifest 里叫 `decisionId`。

- 为什么不再生成第二个 UUID：两个 ID 指同一次确认，会让「前端看到的请求」与「审计里的决策」对不上，排查时反而要维护映射。`requestId` 本来就是给前端的不透明字符串，加前缀不影响它。
- **`resolve()` 的入参类型收窄为 `PermissionDecisionInput = Omit<PermissionResponse, "decisionId">`**：决策 ID 由 manager 从挂起记录里补，WS 传来的任何字段都无法伪造审计键。这是审计完整性的关键点——外部输入不能决定留痕的主键。
- 超时、`denyPending`（abort/reset）这些**没有前端参与**的决策路径，同样由 manager 自己写审计并回填 `decisionId`，所以 `PermissionResponse` 上的 `decisionId` 在所有分支都有值。

## 5. Manifest 关联：toolCallId 优先，命令文本兜底

难点是「确认发生在 `tool_call`，建节点发生在 `tool_result`」，两个事件之间需要一把关联钥匙。方案是 manager 内维护两张索引（各封顶 200 条，插入序淘汰最旧）：

| 索引 | 写入时机 | 用途 |
|------|----------|------|
| `toolCallId → decisionId` | `allow` 决策（含放行模式自动允许） | 精确匹配：pi 的同一次工具调用在 `tool_call` / `tool_result` 里共享 `toolCallId` |
| 归一化命令 → `{decisionId, decision}` | `allow`（原命令）、`edit`（**改后**命令） | 兜底：`edit` 后 agent 重发的命令是一次**新的**工具调用，没有自己的确认记录 |

`govio-canvas.ts` 的 `observe load` 分支调用 `permissionManager.decisionIdForExecution(cmd, event.toolCallId)`，取到的 ID 传进 `buildManifest({ permissionDecisionId })`，未过确认门（不带 `-o`）时为 `null`（T1.1 的语义不变：`null` = 没经过确认门，`undefined` = 旧节点没这个字段）。

取舍与已知边界：

- **为什么不只用命令文本**：文本匹配依赖「同一条命令每次都会重新过确认门，所以索引里最新的一条总是对的」。这个前提在当前 pi 串行执行工具时成立，但如果模型一次发多个 bash 调用并发执行，请求/结果就可能交错，文本索引会张冠李戴。`toolCallId` 没有这个问题，所以作为首选。
- **为什么不只用 toolCallId**：`edit` 决策 block 掉原调用后，真正执行的是 agent 重发的**新**调用（新 `toolCallId`）。若重发命令仍带 `-o`，它会再过一次确认门，节点关联到新决策，同时新请求条目用 `followsDecisionId` 指回那次 `edit`，形成完整链；若用户正是通过改写去掉了 `-o`，重发调用不过确认门，此时只有命令文本索引能把节点挂回那次 `edit` 决策。两条索引各覆盖一半场景，缺一不可。
- **命令归一化只折叠空白**（`\s+` → 单空格 + trim）：agent 重发时换行/缩进可能变化，但不做任何语义级归一（引号、参数顺序），避免「看起来一样其实不一样」的命令被误关联。
- 索引是**内存态**，进程重启即失效：重启后不会再有对应的 `tool_result`（那次工具调用已经随进程消失），所以不需要持久化。

## 6. 会话归属：解析器注入而不是层层传参

审计条目要写进「哪个会话」的文件。三种可选方案：

1. 每个调用点显式传 `sessionFile`（扩展 ctx 里有 `sessionManager`，ws-handler 里有 `ctx.session`）——要改 `requestPermission` 签名，且 `denyPending` / `clearAll` / `setAcceptAll` 这些由 ws-handler 触发的路径也得逐个传，接口噪音大。
2. `permission-audit.ts` 反向 `import { getSession } from "./agent.js"`——形成 `agent → govio-canvas → permission-manager → permission-audit → agent` 的循环导入。
3. **采用：`setAuditSessionResolver()` 注入**。`agent.ts` 模块加载时注册一个读当前会话单例的闭包，`permission-audit` 不依赖任何业务模块。

方案 3 的额外好处：验证脚本可以注册指向临时目录的解析器，跑完整链路而不污染真实会话（`npm run verify:audit` 正是这么做的）。代价是引入一个模块级可变状态——但它只有一个写入点（`agent.ts`）和一个明确的读取点（`appendPermissionAudit`），且解析失败退化为「无会话」而不是抛错。

**写失败不阻断确认流**是硬约束：`appendPermissionAudit()` 内部 try/catch，落盘失败或拿不到会话文件时只 `console.warn` 并返回 `null`。「记不上账」不能变成「命令执行不了」或「用户点了没反应」。

## 7. 验证

新增 `scripts/verify-permission-audit.ts`（`npm run verify:audit`，86 项断言，失败退出码 1）。不调 govio-cli、不调模型、不读任何数据内容；审计写在临时目录，只有 `deleteSession` 那一节在 `.govio/sessions/` 下创建一个一次性会话文件并在 `finally` 里清理。覆盖：条目格式与请求/决策配对、allow/deny/edit（改前改后命令）、timeout/abort/reset 三种系统代答来源、Accept All 模式事件与放行期自动确认留痕、toolCallId 与命令文本两条关联路径、真实扩展事件流（stub pi 驱动 `tool_call` → `tool_result` → 节点事件 Manifest）、`followsDecisionId` 链、JSONL 追加/多行命令不拆行/坏行容错/`deleteSession` 三个文件一起删、无会话归属时不阻断。详见 `verification.md`。

## 8. 遗留问题

1. **审计日志没有读取入口**：目前只有文件与 `readPermissionAudit()`。前端「详情」面板显示的是裸 `decisionId`，用户看不到对应的命令与决策。建议在 T1.4 导出附录里带出确认记录，或加一个会话级「确认历史」面板（新增 WS 消息 `audit_list`，属 X2 协议契约化范围）。
2. **拿不到会话文件时留痕丢失**：会话尚未落盘（`getSessionFile()` 返回 `undefined`）时的确认只告警不写盘。实测中 `SessionManager` 在创建时就给出路径，正常流程不会命中；但若命中，这段确认无痕。彻底解法是给这类条目一个 fallback 归档文件（如 `.govio/sessions/unattributed.audit.jsonl`），本任务未做，避免引入第二个存储位置。
3. **`/api/execute-sql`（SQL 编辑器）与 T1.2 复跑都不过确认门**，所以它们的 Manifest `permissionDecisionId` 恒为 `null`。人工执行有「人就在屏幕前」的隐含确认，复跑用的是已确认过的 SQL——但复跑会把数据写进 ObserveStore（临时名），严格说也是一次取数。是否给复跑加确认门属于产品决策，未在本任务范围内自行决定。
4. **确认门只覆盖 `observe load -o`**：ROADMAP KR3 提到的「跨库查询、全表扫描」尚未纳入 `shouldAskPermission()`，因此也不会产生审计记录。扩展闸门属于 X1 安全基线（`security/hardening` 分支已扩展危险命令闸门），合并后审计会自动覆盖新闸门——本任务的记录点位于 `requestPermission` 内部，与命令匹配规则解耦。
5. **`decisionId` 不上前端**：WS 协议未变（前端只认 `requestId`），PermissionCard 上不显示决策 ID，用户无法当场核对自己刚才批准的是哪一条记录。若要做「确认历史」UI（见 1），需要把 `decisionId` 一并下发。
6. **审计文件无上限、无轮转**：长会话持续追加。单条约 300–500 字节，量级上可接受；若未来要长期留存，需要按大小/时间轮转与压缩策略。
7. **没有防篡改能力**：JSONL 是明文可编辑的本地文件，用户完全可以手工改。单机工作台场景下这是可接受的（审计目的是可追溯，不是对抗恶意操作者）；企业分发场景需要签名或写入只追加存储，属 Phase 3。
8. **`followsDecisionId` 只覆盖 `edit` 链**：deny 后 agent 换一条命令重试，两条决策之间没有显式关联（只能靠时间顺序与命令文本相似度人工判断）。要做「一次取数意图的完整决策树」需要引入意图级 ID，超出本任务范围。
