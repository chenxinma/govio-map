# X34 CHANGES.md

> 任务：首次运行向导 + 数据源管理器 + 秘密结构性路由（`docs/task-plan.json` → crossCutting X34）。
> 本文件按子任务分节累积（P1a/P1b/P2/P3）。

## P1a 秘密结构性路由（后端守卫）

- `server/secret-guard.ts`（新建）：守卫核心。`detectSecretLeaks`（纯函数；连接串
  `scheme://user:pass@host` + 明文密码赋值形态，返回类别/offset/length/脱敏片段，
  不返回秘密全文）、`redactSecrets`/`redactForLog`（命中片段替换 `[REDACTED]`）、
  `buildSecretRedirect`（secret_redirect microcopy 组装，纯函数）、拦截留痕
  `buildSecretGuardAuditEntry`/`recordSecretGuardAudit`/`readSecretGuardAudit`/
  `deleteSecretGuardAudit`（`<session>.secret-guard.jsonl` sidecar，permission-audit
  同款 append-only；只记 sessionId/时间/类别/内容 SHA-256，零明文；kind=prompt/steer/followUp）。
- `server/ws-handler.ts`：prompt/steer/followUp 三分支**最早处**（buildInjectionContext/入队之前、
  任何 console.* 之前）跑 `detectSecretLeaks`（followUp 为 P1a 验收收口补漏）；命中即不调用
  session.prompt/steer/followUp，落审计后回 `secret_redirect`（拒绝执行 + 可读引导）。日志防泄露：makePrompt 的
  `console.debug("[ws] prompt: ...")` 改 `redactSecrets(prompt)`；tool_execution_end
  的 result debug 改 `redactForLog(event.result)`。
- `src/types/ws-protocol.ts`：WSServerMessageSchema 新增 `secret_redirect`
  （message/categories/redactedSnippets，X34 注释标注）；「28 种」注释改 29。
- `tests/integration/ws-protocol.test.ts`：合法样本清单补 `secret_redirect` 样本，
  漂移防护计数 28→29（测试用例数不变）。
- `server/session-history.ts`：`deleteSession` 一并删 `.secret-guard.jsonl`
  （sidecar 与会话同生命周期）。
- `server/govio-cli-exec.ts` / `server/extensions/govio-canvas.ts`：日志防泄露横切——
  govio-cli 失败日志的 args/stderr、tool_result 的 cmd、handleLoadResult 拒收日志的
  stdout 片段，一律先 `redactSecrets`（再截断，防密码被拦腰切断绕过形态匹配）。
- `.pi/APPEND_SYSTEM.md`：新增「凭据只走表单」硬约束节（凭据只走 GUI 表单、
  对话中出现凭据即停引导、密码一律 `[REDACTED]` 占位）。
- `docs/specs/07-websocket-protocol.md`：消息全集 28→29 + `secret_redirect` 入列；
  版本化「实例」补记 X34 属加法、`PROTOCOL_VERSION` 保持 1。
- `docs/tasks/X34-onboarding-gui/design.md`：§9 补「拦截审计留痕落点」取舍行（含
  不扩展 `.injection.jsonl` 的理由）；遗留问题 2 回填 P1a 裁决，新增 7（followUp
  未覆盖）、8（secret_redirect 前端收尾归 P2）。

## P1b onboarding 后端通道（状态/驱动/测试连接/测试模型/导元数据）

- `server/onboarding.ts`（新建）：onboarding 后端通道核心。
  - `getOnboardingStatus()`：govio-cli 版本 / 图后端状态（`govio-cli backend` 解析，
    未初始化给明确状态+可读原因）/ 数据源清单（`govio-cli observe info --datasource`）/
    skills 就绪（`.agents/skills/govio/SKILL.md`）/ models.json 是否已配置
    （`modelsConfigExists()`）；结构化 JSON。
  - `initGraph(config)`：`govio-cli onboard --backend …`（默认 ladybug 一键，graph 段
    upsert 幂等；falkordb/networkx 只收参不建运维能力）；错误→可读修复指引（G8）。
  - `addDatasource(payload)` / `removeDatasource(name)`：**更新 = 同名 + overwrite**
    （单次 `ConfigManager.save`，保留备份语义，无删+增的中间态）；删除走
    `govio-cli onboard --remove-datasource`（无秘密，argv 安全）。
  - `testDatasource(payload)`：stdin wrapper 只读探测（sqlalchemy connect；duckdb 走
    `duckdb.connect(read_only=True)`），**不落盘**；失败分类 dns/host/port/auth/timeout/other
    + 可读修复指引（`classifyDatasourceError` 纯函数）。
  - `testModel(runtime, provider, modelId)`：ModelRuntime 轻探测（`getModel` 注册校验 →
    `getAvailable` 凭据可用性 → `completeSimple` maxTokens=1 最小请求 + 超时 abort），
    失败给可读原因（not_found/auth/request/timeout）。
  - `importMetadata(params, onProgress)`：`govio-cli meta import-schema` 驱动（仅 DuckDB）；
    非 DuckDB 返回可读引导（errorKind=unsupported，非错误堆栈）；stdout 行脱敏后转进度。
  - `runEnvCheck(onProgress)`：包装 `ensureGovioCli()` + `downloadGovioSkills()`，阶段进度回调。
  - **凭据通道（核心裁决）**：govio-cli 只接受密码 via `--password`/URL（都是 argv）→ 不可用；
    改用**静态 python wrapper（`GOVIO_WRAPPER_SOURCE`，无秘密）+ stdin JSON 管道**，秘密零进入
    argv/env/日志/LLM；解释器解析稳健（Windows `<uv tool dir>/govio/Scripts/python.exe`、
    POSIX `<uv tool dir>/govio/bin/python`、fallback `uv run --from govio python`）；wrapper 复用
    govio `add_datasource`/`parse_cli_connect_args`/`_attach_password`（ConfigManager 加密落盘），
    异常消息 wrapper 内先脱敏（密码 + URL 用户信息段）→ Node 出口再过 `redactSecrets` 双保险。
  - 可测性：子进程交互经 `ExecFn` 注入（可 stub，供 P3 verify:onboarding）；`testModel` 接受
    `Pick<ModelRuntime, ...>` 结构型；不引入模块级隐藏状态。
- `src/types/ws-protocol.ts`：客户端新增 `onboarding_action`（payload 判别联合 8 动作：
  status/init_graph/add_datasource/remove_datasource/test_datasource/test_model/import_metadata/env_check）；
  服务端新增 `onboarding_result`（ok/data/error/errorKind/hint）与 `onboarding_progress`；
  注释 20→21 种 / 29→31 种。
- `server/ws-handler.ts`：`handleNormalMessage` 落 `onboarding_action` case（assertNever 穷尽
  强制）；`config_required` 预配置态同样接线（全新环境向导 Step0/2/3 不依赖 LLM 配置；
  `test_model` 无会话时回可读引导）。长耗时动作（init_graph/import_metadata/env_check）边跑边发
  `onboarding_progress`；凭据类 payload 不进任何日志，异常过 `redactForLog`。
- `server/govio-installer.ts`：`MIN_GOVIO_CLI_VERSION` 0.7.1 → **0.8.0**（X33 发版）；
  新增 `govioSkillsReady()`（skills 就绪检测，供状态复用）。
- `tests/integration/ws-protocol.test.ts`：合法样本补 `onboarding_action` ×4（status/add_datasource/
  test_model/import_metadata payload 变体）与 `onboarding_progress`/`onboarding_result` ×3；
  漂移防护计数 20→21 / 29→31（用例数不变）；models-config mock 补 `modelsConfigExists`。
- `tests/integration/ws-handler.test.ts`：models-config mock 补 `modelsConfigExists`（onboarding.ts
  新依赖，防 mock 缺导出）。
- `docs/specs/07-websocket-protocol.md`：消息全集 20→21 / 29→31 + 新增「Onboarding 协议（X34 P1b）」
  小节（payload 判别联合、凭据纪律、config_required 态可用性）；版本化「实例」补记 P1b 属加法、
  `PROTOCOL_VERSION` 保持 1。
- `docs/tasks/X34-onboarding-gui/design.md`：遗留 1（测试连接探测手段 → stdin wrapper 探测）、
  4（`--backend`+`--remove-datasource` 组合实测结论）、5（MIN_GOVIO_CLI_VERSION 提升）结案；
  新增遗留 9（test_model 只能测已保存配置，草稿即时测试归 P2 裁决）。
