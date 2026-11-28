# X34 verification.md

> 验证命令与关键输出，按子任务分节累积。P1a 不新增 verify 脚本（P3 负责
> `verify:secrets-isolation` / `verify:onboarding`），守卫函数为纯函数、可被
> `tsx` 直接 import 断言。

## P1a 秘密结构性路由（后端守卫）

### 验证门槛（commit 前全绿，2026-11-28 本地跑）

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm run build` | ✅ | `tsc -b` 零错误；vite build ✓；`dist-server/cli.mjs` 237.4kb |
| `npm run lint` | ✅ | eslint 零告警 |
| `npm run verify` | ✅ | 12 项全绿，exit 0；`verify-prompt-injection: 58/58 通过`；`verify:integration` 34 文件 / 495 测试全过（含 ws-protocol 契约 29 类漂移防护）；`verify:ui` 11 文件 / 98 测试全过 |

断言数变化：**零新增测试用例**（verify 脚本按任务书归 P3）；既有
`tests/integration/ws-protocol.test.ts` 计数断言 28→29 随契约变更同步。

### 守卫函数冒烟（tsx 直接 import，15 例全过）

```
PASS mysql://admin:s3cr3t@10.0.0.5:3306/shop        -> connection_string（snippet: mysql://admin:[REDACTED]@10.0.0.5:3306/shop）
PASS postgresql://u:p%40ss@db.host/prod（URL-encoded）-> connection_string
PASS redis://cache:top@redis:6379/0 / oracle://sc/t:pw@ora-host:1521/ORCL -> connection_string
PASS 密码是 mySecret123 / 密码：中文密码abc            -> password
PASS password=hunter2 / --password hunter2 / "password": "json secret" / password: yaml-secret -> password
PASS duckdb://D:/Work/gov-io/data/sales.duckdb（无密码路径）-> 不命中
PASS SELECT 1 / 统计订单金额趋势 / password=（空值）    -> 不命中
redactSecrets: 全部命中片段 -> [REDACTED]；audit 条目零明文（仅 SHA-256）
```

### 端到端取证（临时 vitest，复用 ws-handler mock harness，跑完即删不入库）

`X34 秘密守卫端到端（prompt/steer/followUp 三通道）`：4/4 通过——
① followUp 含凭据 → 不入队（session.followUp 零调用、无 followUp_queued）+ 回执
`secret_redirect` 且回执/审计零明文；② 干净 followUp 照常入队（守卫不误伤）；
③ prompt 含连接串 → session.prompt 零调用 + redirect（含 connection_string 类别）；
④ steer 含 `password=` → session.steer 零调用 + redirect。

### console.* 全量防泄露清点（`rg -n "console\." server/`）

| 站点 | 处置 |
|---|---|
| `ws-handler.ts` makePrompt `console.debug("[ws] prompt: ...")` | ✅ 改 `redactSecrets(prompt)`（任务书点名） |
| `ws-handler.ts` tool_execution_end result debug | ✅ 改 `redactForLog(event.result)`（工具结果可能回显 config.yaml 等凭据） |
| `ws-handler.ts` 其余（启动/错误路径，err 对象） | 不改：无用户 content/prompt 全文 |
| `extensions/govio-canvas.ts` tool_result `cmd.slice(0,120)` | ✅ 改 `redactSecrets(cmd).slice(0,120)`（命令可内嵌 SQL/连接串） |
| `extensions/govio-canvas.ts` handleLoadResult 拒收日志 `stdout.slice(0,120)` | ✅ 改 `redactSecrets(stdout).slice(0,120)`（先脱敏再截断，防密码被拦腰切断绕过匹配） |
| `govio-cli-exec.ts` 失败日志 `args=`/stderr | ✅ 改 `redactForLog(args)` + `redactSecrets(stderr｜error.message)`（args 可内嵌 `--sql` 全文） |
| `agent.ts` runGovioCli cmd/stdout | 不改：cmd 为服务端字面量（observe list/info）+ Cypher（表名），stdout 为结构化元数据，非用户 content/prompt |
| `caliber-check/parquet-api/dataframe-rerun/storage/permission-audit/prompt-injection/serve/backend/cli/govio-installer` | 不改：均为固定文案、错误对象或派生元数据，无用户 content/prompt 全文 |

### 遗留（详见 design.md §10）

- ~~followUp 绕行口~~ **已收口（P1a）**：followUp 已加与 prompt/steer 同款拦截（审计 kind=`followUp`）；已对照 WSClientMessage 全集核查 handleNormalMessage，followUp 之外无其它入 LLM 通道（design.md 遗留 7 已标记解决）。
- 误伤/漏拦阈值（`密码为…` 等形态）待 `verify:secrets-isolation` 实测后调（遗留 2 裁决尾注）。
- secret_redirect 前端收尾归 P2（遗留 8，保持开放）。
