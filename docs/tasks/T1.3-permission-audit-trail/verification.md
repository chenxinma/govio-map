# T1.3 验证记录

环境：Windows Git Bash · Node 项目根 `D:/work/gov-io/govio-map` · 分支 `feature/phase1-trusted-analysis`
执行时间：2026-10-30（收尾复跑）

## 1. 门槛：`npm run build`（通过）

```
$ npm run build
> tsc -b && vite build
✓ 2461 modules transformed.
dist/index.html                     0.79 kB │ gzip:     0.42 kB
dist/assets/index-CY6_Ir1k.css     51.12 kB │ gzip:     9.52 kB
dist/assets/index-D0OPgJ6p.js   6,065.50 kB │ gzip: 1,859.15 kB
✓ built in 1.97s
```

chunk 体积告警是既有问题（plotly 全量打包，见 X3）。`tsc -b` 经 `vite.config.ts → server/index.ts` 覆盖全部 server 改动文件（`permission-audit.ts`、`permission-manager.ts`、`session-history.ts`、`agent.ts`、`extensions/govio-canvas.ts`、`analysis-manifest.ts`），强制全量重跑同样通过：

```
$ npx tsc -b --force > /tmp/tsc.log 2>&1; echo "tsc exit=$?"
tsc exit=0
```

（`npx tsc -p tsconfig.electron.json` 的 `server/cli.ts:81` 报错为 main 上既有问题，与本任务无关，按任务书忽略。）

## 2. `npm run lint`（通过）

```
$ npm run lint
> eslint .
（无输出 = 0 error / 0 warning）
```

## 3. 主验证：`npm run verify:audit`（86 项断言全通过）

新增脚本 `scripts/verify-permission-audit.ts`，可反复执行，任一断言失败退出码 1。不调 govio-cli、不调模型、不读任何数据内容；审计写在系统临时目录，只有 `deleteSession` 一节在 `.govio/sessions/` 下创建一次性会话文件并在 `finally` 清理。

```
$ npm run verify:audit
> tsx scripts/verify-permission-audit.ts

[1] 审计条目格式与 allow 决策
  ✓ 确认请求推给了前端（requestId + 命令原文）
  ✓ requestId 就是决策 ID（同一次确认只有一个标识）
  ✓ allow 决策回传 decisionId
  ✓ toolCallId 与决策 ID 已建立关联（供 Manifest 回填）
  ✓ toolCallId 优先于命令文本（命令不同也能对回本次决策）
  ✓ 没有 toolCallId 时退回命令文本关联
  ✓ sidecar 路径为 <session-file>.audit.jsonl
  ✓ 一次确认写下「请求 + 决策」两条记录
  ✓ 两条记录同一个 decisionId
  ✓ 记录带结构版本号
  ✓ 记录带会话 ID 与会话文件
  ✓ 时间戳为 ISO 8601
  ✓ 决策时间不早于请求时间
  ✓ 请求记录命令原文（未改写）
  ✓ 请求记录标注走人工确认门
  ✓ 决策记录 allow / 来源为用户
  ✓ 决策记录耗时非负
  ✓ allow 决策不含 editedCommand / reason 字段

[2] deny 记录原因、edit 记录改前改后命令
  ✓ deny 决策回传 decisionId
  ✓ 被拒绝的命令不进入 Manifest 关联索引
  ✓ edit 决策回传修改后命令
  ✓ 修改后的命令进入关联索引（agent 重发时挂同一次决策）
  ✓ 被改写的原命令不再指向该决策
  ✓ deny 记录原因原文
  ✓ deny 记录命令原文
  ✓ edit 记录**修改前**命令
  ✓ edit 记录**修改后**命令
  ✓ edit 记录原因
  ✓ 每次确认都有配对的请求记录

[3] 超时 / 中止 / Accept All 模式事件 / 会话重置
  ✓ 超时自动拒绝并给出原因
  ✓ 超时决策来源记为 timeout
  ✓ 超时决策记录了等待时长
  ✓ 中止时挂起请求被自动拒绝
  ✓ 中止决策来源记为 abort
  ✓ 已清理的挂起请求不会被二次记账
  ✓ Accept All 写入一条模式变更事件（重复设置不重复记账）
  ✓ 模式事件记为开启放行 + 原因 + 时间戳
  ✓ 模式事件有独立 ID（pm- 前缀）
  ✓ 模式事件同样带会话归属
  ✓ 模式事件记录当时挂起的请求数
  ✓ 全局放行下不打扰前端
  ✓ 全局放行仍返回决策 ID
  ✓ 全局放行期间执行的命令也能关联决策
  ✓ 自动放行记为 gate=accept-all
  ✓ 自动放行决策来源记为 accept-all、耗时 0
  ✓ 会话重置时挂起请求被拒绝
  ✓ 会话重置后放行模式失效
  ✓ 会话重置写下「放行关闭」模式事件
  ✓ 模式事件记录受影响的挂起请求数
  ✓ 重置导致的拒绝来源记为 reset

[4] Manifest 关联 decisionId
  ✓ 命令空白差异不影响关联
  ✓ Manifest.permissionDecisionId = 确认门的决策 ID
  ✓ 按 Manifest 的 decisionId 能在审计日志里查到请求与决策
  ✓ 未过确认门的加载 Manifest 记为 null（而非省略字段）

[5] govio-canvas 事件流：确认门决策写进 dataFrame 节点 Manifest
  ✓ 扩展注册了 tool_call / tool_result 处理器
  ✓ 用户允许后不阻断 bash 执行
  ✓ 确认请求确实经过了前端通道
  ✓ observe load 生成 dataFrame 节点事件
  ✓ 节点 Manifest 关联到本次确认的 decisionId
  ✓ 节点 Manifest 其余留痕未受影响
  ✓ edit 决策阻断原命令
  ✓ 阻断原因里带上修改后的命令
  ✓ 修改后的命令重新过确认门后放行
  ✓ 改前改后各触发一次确认
  ✓ 改写后执行的结果关联到**重发那次**决策
  ✓ 命令文本兜底也能对回重发那次决策
  ✓ 不带 -o 的加载不触发确认门
  ✓ 未过确认门的节点 Manifest 记 null
  ✓ 重发命令的请求记录指回 edit 决策（followsDecisionId）
  ✓ 首次请求没有 followsDecisionId
  ✓ 未过确认门的命令不产生任何审计记录

[6] JSONL 追加、读回、坏行容错、deleteSession 清理
  ✓ 追加写：记录数与文件行数一致（历史未被覆盖）
  ✓ 每行都是一条完整 JSON
  ✓ 文件以换行结尾（可继续追加）
  ✓ 多行命令仍是一条请求 + 一条决策
  ✓ 多行命令原文完整保留（含换行）
  ✓ 多行命令没有把 JSONL 拆行
  ✓ 坏行与空行被跳过，其余记录照常读回
  ✓ 删除前会话 / canvas / 审计三个文件都在
  ✓ 审计记录写进了会话自己的 sidecar
  ✓ deleteSession 一并删除审计 sidecar
  ✓ deleteSession 仍删除会话与 canvas sidecar
  ✓ 审计 sidecar 不存在时删除返回 false（幂等）

[7] 会话尚未落盘时确认流不受影响（下面两行 warn 是预期输出）
[permission-audit] 当前无会话文件，permission_request(pd-…) 未落盘
[permission-audit] 当前无会话文件，permission_decision(pd-…) 未落盘
  ✓ 拿不到会话文件时确认照常完成
  ✓ 拿不到会话文件时没有新增任何审计记录
[permission-audit] 当前无会话文件，permission_mode(pm-none) 未落盘
  ✓ 直接写审计返回 null（不落盘、不抛错）

共 86 项断言，失败 0 项
PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID
```

其中第 5 节用 stub pi 驱动**真实扩展代码**（`govioCanvasExtension`）：模拟前端在 `onRequest` 里应答，走 `tool_call`（确认门）→ `tool_result`（建节点）→ `flushGovioNodes()`，断言节点事件的 `manifest.permissionDecisionId` 等于前端拿到的 `requestId`。

## 4. 模拟请求验证日志格式（真实落盘样例）

用一段一次性脚本驱动 `PermissionManager`（与验证脚本同一套代码路径），三轮场景：① 用户把命令改窄（edit）② agent 用改后命令重发并被允许（allow）③ 开启 Accept All 后再来一条命令（自动 allow）。产出文件 `<tmp>/2026-10-30T15-00-00-000Z_01a1sample.jsonl.audit.jsonl`：

```
# 第一轮（用户改命令）      -> edit   pd-6657ec26-6117-4307-8cd6-85265a8a4d21
# 第二轮（改后命令重发）    -> allow  pd-88540fd3-3e48-47a1-8cb3-a41c8a204755
# 第三条（Accept All 期间） -> allow  pd-39194873-1b8c-4b39-8af5-680a15d4ef2c
# Manifest.permissionDecisionId(toolCallId=call_B) = pd-88540fd3-3e48-47a1-8cb3-a41c8a204755
```

```jsonl
{"type":"permission_request","at":"2026-10-30T16:27:03.085Z","decisionId":"pd-6657ec26-…","command":"govio-cli observe load --name df_orders --datasource sales --sql \"SELECT * FROM orders\" -o out/orders.parquet","gate":"ask","sessionId":"01a1sample","v":1,"sessionFile":"<tmp>/…jsonl"}
{"type":"permission_decision","at":"2026-10-30T16:27:03.096Z","decisionId":"pd-6657ec26-…","decision":"edit","command":"govio-cli observe load --name df_orders --datasource sales --sql \"SELECT * FROM orders\" -o out/orders.parquet","editedCommand":"govio-cli observe load --name df_orders --datasource sales --sql \"SELECT order_id, amount FROM orders LIMIT 100\" -o out/orders_sample.parquet","reason":"只取必要列并抽样","source":"user","elapsedMs":11,…}
{"type":"permission_request","at":"2026-10-30T16:27:03.099Z","decisionId":"pd-88540fd3-…","command":"govio-cli observe load … \"SELECT order_id, amount FROM orders LIMIT 100\" -o out/orders_sample.parquet","gate":"ask","followsDecisionId":"pd-6657ec26-…",…}
{"type":"permission_decision","at":"2026-10-30T16:27:03.101Z","decisionId":"pd-88540fd3-…","decision":"allow","command":"govio-cli observe load … LIMIT 100 … -o out/orders_sample.parquet","source":"user","elapsedMs":2,…}
{"type":"permission_mode","at":"2026-10-30T16:27:03.104Z","decisionId":"pm-c9ebfc5e-…","acceptAll":true,"reason":"用户选择本会话内全部放行（Accept All）","pendingAffected":0,…}
{"type":"permission_request","at":"2026-10-30T16:27:03.106Z","decisionId":"pd-39194873-…","command":"govio-cli observe load --name df_big --datasource sales --sql \"SELECT * FROM big\" -o out/big.parquet","gate":"accept-all",…}
{"type":"permission_decision","at":"2026-10-30T16:27:03.109Z","decisionId":"pd-39194873-…","decision":"allow","command":"govio-cli observe load --name df_big … -o out/big.parquet","source":"accept-all","elapsedMs":0,…}
```

样例里可直接读出四条验收要点：`edit` 决策同时带 `command`（改前）与 `editedCommand`（改后）+ `reason`；重发那次请求用 `followsDecisionId` 指回 edit 决策，形成链；Accept All 落成一条 `permission_mode` 事件，且放定期的命令仍有 `gate:"accept-all"` / `source:"accept-all"` 两条记录（不是静默放行）；节点 Manifest 拿到的是重发那次的 `pd-88540fd3-…`。

按 Manifest 的决策 ID 反查（`jq`，无需读数据内容）：

```
$ jq -c 'select(.type=="permission_decision") | {decisionId, decision, source, reason, editedCommand}' <audit.jsonl>
{"decisionId":"pd-b0adfac4-…","decision":"edit","source":"user","reason":"只取必要列并抽样","editedCommand":"govio-cli observe load --name df_orders … LIMIT 100\" -o out/orders_sample.parquet"}
{"decisionId":"pd-0924f670-…","decision":"allow","source":"user","reason":null,"editedCommand":null}
{"decisionId":"pd-b44f36e4-…","decision":"allow","source":"accept-all","reason":null,"editedCommand":null}

$ jq -c 'select(.type=="permission_mode") | {decisionId, acceptAll, reason, pendingAffected}' <audit.jsonl>
{"decisionId":"pm-34d07b15-…","acceptAll":true,"reason":"用户选择本会话内全部放行（Accept All）","pendingAffected":0}
```

（两次运行的 UUID 不同，因为是各自独立的一次性脚本；格式一致。）

## 5. 回归：T1.1 / T1.2 验证脚本

```
$ npm run verify:manifest
共 52 项断言，失败 0 项
PASS: Manifest 往返无丢失

$ npm run verify:rerun
共 62 项断言，失败 0 项
PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
```

`verify:manifest` 里「权限决策 ID 预留为 null」等断言仍通过：未过确认门的 Manifest 依旧显式写 `null`，字段结构未变（`MANIFEST_SCHEMA_VERSION` 仍为 1）。

## 6. 验收标准对照

| 验收标准 | 证据 |
|----------|------|
| 审计日志随会话持久化（`.govio/sessions/` 下 sidecar / jsonl 追加） | §3 [1][6]：`auditPathFor` = `<session-file>.audit.jsonl`、追加写不覆盖、每行一条完整 JSON；样例见 §4 |
| `deleteSession` 时一并删除 | §3 [6]：`deleteSession 一并删除审计 sidecar` / `仍删除会话与 canvas sidecar` / `幂等` 三项断言 |
| edit 决策记录修改前后命令 | §3 [2] 四项断言 + §4 样例第 2 行（`command` 与 `editedCommand` 并存 + `reason`） |
| Manifest 可关联到触发它的权限决策 ID | §3 [4][5]：索引关联 + stub pi 真实事件流下 `manifest.permissionDecisionId === 前端 requestId`；§4 样例给出 `pd-88540fd3-…` |
| `permission_accept_all` 记录模式变更事件 | §3 [3] 六项断言（含重复设置不重复记账、放行期自动确认仍留痕）+ §4 样例 `permission_mode` 行 |
| `npm run build` 通过 | §1 |
| 三件套交付物 | `docs/tasks/T1.3-permission-audit-trail/{design,CHANGES,verification}.md` |

## 7. 未做的验证（诚实记录）

- **浏览器端人工冒烟未做**：没有起 `npm run dev` 真点一次 PermissionCard 的四个按钮。理由是 WS 协议与前端代码零改动（`decisionId` 与前端回传的 `requestId` 同值，未上下行），服务端路径已由 stub pi + 真实 manager 覆盖；但「用户点 Accept All → 后续命令不再弹窗 → 审计里出现 `gate:"accept-all"`」这条端到端体验仍建议主 session 或用户在 dev 环境点一次确认。
- **`observe load` 真实 CLI 链路未跑**：本任务的验证脚本刻意不调 govio-cli（确认门在命令执行**之前**，与 CLI 是否可用无关）；真实取数链路由 `npm run verify:rerun -- --real`（T1.2）覆盖。
- **并发工具调用下的关联正确性未实测**：`toolCallId` 优先的设计已消除主要风险（见 design.md §5），但没有构造并发 bash 调用的场景去验证。
