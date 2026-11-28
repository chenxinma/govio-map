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

## P1b onboarding 后端通道

### 验证门槛（commit 前全绿，2026-11-28 本地跑）

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm run build` | ✅ | `tsc -b` 零错误；vite build ✓；`dist-server/cli.mjs` 261.0kb |
| `npm run lint` | ✅ | eslint 零告警 |
| `npm run verify` | ✅ | 全链 exit 0；`verify:caliber-conflict 77/77`、`verify-prompt-injection: 58/58`；`verify:integration` 34 文件 / 495 测试全过（含 ws-protocol 契约 21 客户端类 / 31 服务端类漂移防护）；`verify:ui` 11 文件 / 98 测试全过 |

断言数变化：**测试用例数不变**（verify 脚本归 P3）；`tests/integration/ws-protocol.test.ts`
计数断言 20→21 / 29→31 随契约变更同步，合法样本 +7 条（onboarding_action ×4、
onboarding_progress/result ×3）。

### onboarding.ts 冒烟（tsx 直连真实子进程，隔离 HOME，17 断言组全过）

```
PASS classifyDatasourceError 8 例（dns/port/auth/timeout/host/other 归类）
PASS getOnboardingStatus 未初始化态: {"initialized":false,"error":"错误: 未找到配置文件，请先运行 govio-cli onboard"} cli=0.8.0 skills=true
PASS initGraph 幂等 ×2 → ladybug（graph 段 upsert，重复执行不破破坏）
PASS addDatasource（凭据零明文落盘：config.yaml 仅 encrypted_password + 脱敏 URL；
     同名拒绝 hint 含「覆盖」；overwrite 更新通过）
PASS testDatasource：duckdb 成功 / postgresql 坏主机 → dns 分类 + hint；
     独立密码/URL 密码均不回显；探测不存在的 duckdb 文件不落盘
PASS importMetadata 非 DuckDB → errorKind=unsupported + 聊天引导（无 Traceback）
PASS testModel：not_found / ok（fake ModelRuntime）
PASS removeDatasource + 状态收口 datasources=["sales"]（删除不存在 → hint 含「刷新」）
```

### 任务书实证事实复核（关键声明逐条验真）

- wrapper 解释器：`C:/Users/Administrator/AppData/Roaming/uv/tools/govio/Scripts/python.exe`
  `import govio.cli.onboard` ✓（add_datasource/remove_datasource/parse_cli_connect_args/
  _attach_password 均在；签名对照安装包源码逐字确认，未凭记忆）。
- 遗留 4 实测（隔离 HOME）：`govio-cli onboard --backend ladybug --remove-datasource NAME`
  单次 save（「已配置图后端 + 已删除数据源」同输出）；数据源不存在 exit 1 且不写 config.yaml。
- `govio-cli backend` 未初始化 → stderr「错误: 未找到配置文件，请先运行 govio-cli onboard」exit 1
  （明确状态）；已初始化 → stdout 纯后端名（如 `ladybug`）。
- sqlalchemy duckdb 方言会把 `duckdb://D:/...` 误解析（port 空串崩溃）→ wrapper 对 duckdb://
  改走 `duckdb.connect(path, read_only=True)`。

### 凭据通道（一句话）

静态 python wrapper（无秘密）+ stdin JSON 管道 → govio `ConfigManager` 加密落盘，
凭据零进入 LLM 上下文/日志/进程参数/环境变量，错误消息 wrapper 内 + Node 出口双重脱敏。

### 遗留（详见 design.md §10）

- test_model 只能测已保存的模型配置；向导 Step1 草稿态即时测试归 P2（遗留 9，保持开放）。
- 连接错误分类为关键词启发式，阈值待 `verify:secrets-isolation`/可用性测试实测后调（遗留 2 尾注延续）。

## P2 前端首启向导 + 组件改造

### 验证门槛（commit 前全绿，2026-11-28 本地跑）

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm run build` | ✅ | `tsc -b` 零错误；vite build ✓；`dist-server/cli.mjs` 260.5kb |
| `npm run lint` | ✅ | eslint 零告警 |
| `npm run verify` | ✅ | 12 项全绿，exit 0；`verify:integration` 35 文件 / 500 测试全过；`verify:ui` 12 文件 / 103 测试全过 |

断言数变化：`verify:ui` **+1 文件 / +5 用例**（`tests/ui/onboarding-wizard.test.tsx`：向导 Step0 环境状态、
Step1 无默认供应商（R7）、DatasourceForm 掩码显隐/提交禁用、SecretRedirectCard 渲染与事件派发）；
全量 `vitest run` 同步 +5（495→500）；`tests/integration/settings-provider-drafts.test.ts` 仅 1 条用例
断言更新（空配置回落空草稿，X34「无默认锁定」有源行为变更），其余不变，既有断言零回归。

### secret_redirect 收尾取证（遗留 8 裁决）

- 被拦原文不进聊天态：`useChat` 收到 `secret_redirect` 将最近发送气泡（`lastSentUserMsgIdRef` 关联）
  内容替换为脱敏摘要（后端 `redactedSnippets`，仅含 `[REDACTED]`），并清 steer/followUp 待投递标记
  （被拦消息不会再有 queued 回执）；聊天态无 localStorage 持久化（仅 `govio.selectedModel` 入
  localStorage），无残留面。
- 回执卡片 `SecretRedirectCard`：可读说明 + 脱敏摘要 + 「打开数据源表单」按钮（`govio:open-datasources`
  → Header → 数据源管理器）；UI 测试覆盖渲染与事件派发。
- secret_redirect 不带 clientMsgId，气泡关联用「最近发送」启发式（prompt/steer/followUp 均经 `send()`）；
  同时连发多条含凭据消息时逐条被拦、逐条脱敏，已记录于 design.md 遗留 8 尾注。

### test_model 草稿即时测试取证（遗留 9 裁决）

「保存并测试」流程：`save_models_config`（合并保存既有 provider，掩码由 unmaskFromDisk 还原）→
`config_saved` + 会话重启 `session_ready` 双信号 → `test_model`；UI 明示「先保存配置再测试」。
不做临时 provider 注册探测（草稿凭据不进 ModelRuntime 内存）。

### 遗留（详见 design.md §10）

- ~~test_model 只能测已保存配置~~ **已结案（P2）**：保存并测试流程（遗留 9）。
- 连接错误分类阈值待 `verify:secrets-isolation`/可用性测试实测后调（延续遗留 2 尾注）。
- `save_models_config` apiKey-only 通道已废弃（回可读错误，schema 不变），见 design.md 遗留 10。
