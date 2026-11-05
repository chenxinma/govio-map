# T2.1 变更清单：图谱定义自动注入 Prompt

## 新增文件

| 文件 | 摘要 |
|---|---|
| `server/graph-query.ts` | `govio-cli query -c` 最小执行器：`execFile` **参数数组**调用（`agent.ts` 的 `runGovioCli` 按空格 split 不可用于 Cypher）、6s 超时、stdout 结果行（状态行 + 紧凑 JSON 数组）解析为 `GraphRow[]`；独立模块便于 `vi.mock` 与注入 fake runner |
| `server/prompt-injection.ts` | 注入核心：`resolveTableFacts`（消息 ref.data + canvas sidecar 合并表事实，缺啥省啥）、`buildInjectionContext`（4 条 Cypher 并行取指标/维度/字段标准，问题实体∪引用表命中筛选，永不 throw）、`composePrompt`（REF envelope 逐字保持 + `CTX:<json>` 单行注入 + 内容）、注入留痕（`buildTraceEntry`/`recordInjectionTrace`/`readInjectionTrace`/`deleteInjectionTrace`，`<session>.injection.jsonl` append-only sidecar） |
| `scripts/verify-prompt-injection.ts` | 47 项断言：REF/CTX 序列化（acceptance 1）、表事实解析、图谱注入与四路降级（acceptance 4）、留痕读写/删除（acceptance 2）、口径命中率测量 fixture（acceptance 3，2 hit/1 miss/1 unrelated + 无 CTX 轮次跳过）、transcript CTX 剥离；另附 `.govio/sessions` 真实抽样信息性输出 |
| `docs/tasks/T2.1-graph-prompt-injection/{design,CHANGES,verification}.md` | 本三件套 |

## 修改文件

| 文件 | 摘要 |
|---|---|
| `server/ws-handler.ts` | ① `makePrompt()` 函数体：改为 `async makePrompt(msg, session)`，组装 `buildInjectionContext`（表事实取 `loadCanvas(sessionFile)` sidecar + 消息 data）→ `composePrompt` → 有注入内容时 `recordInjectionTrace`；② `:211` 调用点周边：prompt 派发改异步 IIFE（注入查询不阻断语义，流式判定推迟到派发时刻），失败只 log 不打断会话；③ 顶部加 1 行 import。**`WSMessage` 界面与 `ws.send` 消息形态未动**（X2 协议类型化无冲突面） |
| `server/session-history.ts` | ① `parseRefPrefix`：REF 前缀之后（或无 REF 时）剥离单行 `CTX:` 注入块——留痕保留在 jsonl 原文、上屏不显 JSON 噪声；② `deleteSession()` 连带 `deleteInjectionTrace`（sidecar 与会话同生命周期）；③ import 时自检补 3 个 CTX 剥离断言 |
| `tests/integration/ws-handler.test.ts` | +2 用例（38→40）：「prompt 注入：CTX 含 qualifiedName/datasourceType」（mock graph-query，断言 session.prompt 收到的 prompt）；「图谱不可达降级：prompt 照常派发、CTX 标记 degraded」；顶部新增 `vi.mock("../../server/graph-query.js")`（测试不 spawn 真实 govio-cli） |
| `package.json` | 新增 `verify:prompt-injection`，并插入 `verify` 聚合（source-table 之后、integration 之前） |

## 未动（范围纪律）

- `WSMessage` 界面 / `ws.send` 消息形态（X2 并行做协议类型化）
- `src/components/`（UI）、`src/store/canvas-store.ts`（前端 ref.data 增强见 design.md 遗留 1）
- `docs/task-plan.json`（主会话记账）
- steer/followUp 消息路径、govio-canvas 扩展、图谱 schema
