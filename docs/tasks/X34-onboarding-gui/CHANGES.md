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
  同款 append-only；只记 sessionId/时间/类别/内容 SHA-256，零明文）。
- `server/ws-handler.ts`：prompt/steer 分支**最早处**（buildInjectionContext 之前、
  任何 console.* 之前）跑 `detectSecretLeaks`；命中即不调用 session.prompt/steer，
  落审计后回 `secret_redirect`（拒绝执行 + 可读引导）。日志防泄露：makePrompt 的
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
