# T3.1+T3.2 任务书：画布团队存储抽象（逐画布 S3）+ 只读分享与 fork 续写

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → phases[] | select(.id=="P3")` 的 T3.1 / T3.2 条目（scope/acceptance 即验收契约）。
> **合并任务**：用户决策 2026-11-14 将 T3.1、T3.2 合并为单 worker 串行两阶段（存储抽象 → 分享/fork）。

## 1. 背景与动机

govio-map 是无限画布数据治理工具（React 19 + TS + Vite + @xyflow/react + Zustand；后端是 Vite 插件里的 HTTP/WS 服务 + pi AgentSession）。P3 阶段目标是「成果可交接」（画布复用率 ≥30%）：当前会话与画布数据全部落在**本机** `.govio/sessions/` 下，团队之间无法共享画布成果，复用无从谈起。

- **T3.1 画布团队存储抽象**：把 session-history 存储层从「写死本地文件」抽象为可插拔后端。**用户决策（2026-11-14）**：原则上**不新作文件服务后端**；技术方案为**逐个画布配置 S3 存储地址**来实现画布协作（每个画布可配置独立的 S3 bucket/prefix/凭据引用，多端指向同一地址即共享画布数据）。你必须**先做技术可行性评估**（见 §4.1），结论可行才继续实施。
- **T3.2 只读分享与 fork 续写**：只读分享链接（打开时含 Analysis Manifest，且可在只读态触发复跑）；从分享视图 fork 出可写副本并保留派生血缘。

两任务合并原因：T3.2 硬依赖 T3.1（分享的落地形态取决于存储/共享后端），同域单 worker 避免存储接口中途二次返工。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、合入 main 纪律、Orca SOP）
2. `.pi/APPEND_SYSTEM.md`（运行时硬约束：SQL 生成纪律、govio-cli 输出禁止截断、取数最小化）
3. `docs/task-plan.json → phases[] | select(.id=="P3")` 的 T3.1、T3.2 条目全文（note/scope/acceptance）
4. `server/session-history.ts` **全文**（245 行，存储层现状全貌：getSessionDir、sidecar、transcript 构建）
5. `server/ws-handler.ts`（`saveCanvas`/`loadCanvas`/`listSessions`/`deleteSession`/`buildTranscript` 调用点：166、423、565 附近）、`server/parquet-api.ts`（18、72）、`server/permission-audit.ts` + `server/prompt-injection.ts`（sidecar 与会话同生命周期的删除联动）
6. `server/analysis-manifest.ts` 与 `docs/tasks/T1.1-analysis-manifest/design.md`（Manifest 是分享内容的组成部分）、`docs/tasks/T1.2-dataframe-rerun-drift/design.md`（复跑语义，只读态复跑要对齐它）
7. `docs/tasks/X2-ws-protocol-schema/`（WS 协议契约：新增消息类型如何走版本化 schema + 双端类型生成）
8. `src/store/canvas-store.ts`（前端状态与 localStorage 持久化）、`src/services/canvas-service.ts`、`src/components/Chat/ChatPanel.tsx`（会话列表 UI 现状）
9. `docs/tasks/X10-table-semantic-edges/DISPATCH.md`（本仓任务书体例，供你写三件套参照）

## 3. 实证事实（主会话已取证，避免你重复踩坑）

**存储层现状**（main 2026-11-14）：

- `getSessionDir()` = `<cwd>/.govio/sessions`；会话 `.jsonl` 由 pi `SessionManager`（`@earendil-works/pi-coding-agent`）**直接写本地目录**——外部依赖，不可修改其写入方式
- 每会话三类 sidecar（全部是我们自己的代码）：`.canvas.json`（`saveCanvas`/`loadCanvas`，形状 `{nodes, edges}`，`loadCanvas` 校验双数组，坏 JSON 返回 null）、权限审计 sidecar（`permission-audit.ts` 的 `auditPathFor`）、注入留痕 sidecar（`prompt-injection.ts`）；`deleteSession` 级联删除全部 sidecar
- **调用面很窄**：`listSessions / deleteSession / saveCanvas / loadCanvas / buildTranscript / assertValidSessionPath` 仅被 `ws-handler.ts` 与 `parquet-api.ts` 引用 → 接口化改动面可控
- 画布真源是服务端 `.canvas.json` sidecar；前端 `canvas-store` 的 localStorage（`govio-canvas-state`）只是本地缓存
- 会话文件路径校验 `assertValidSessionPath`（防目录穿越）已有，抽象后必须保持等价安全边界

**S3 方案的已知约束（可行性评估的起点，不是结论）**：

- pi SessionManager 只写本地 → 会话 jsonl 只能「本地写 + 同步上传 S3」或「S3 作为交换/归集层 + 本地缓存」；sidecar 是自有代码，可直接读后端
- S3 无原子 rename、无文件锁 → 并发写冲突策略（最后写入胜出 / ETag If-Match 乐观锁 / 画布级租约）必须在 design.md 做出取舍
- 凭据安全：S3 凭据**禁止**落入画布 JSON、导出 HTML、日志、分享链接；只能是 env 引用或服务端配置引用
- `canvas.json` 可能 MB 级；分享/加载延迟需评估（用户可接受秒级加载，不可接受交互卡死）
- 「逐画布配置 S3 地址」的配置粒度、谁来配、多端如何发现同一画布（画布 ID ↔ S3 key 映射）——你来定方案并论证

**本机验证基线（主会话 2026-11-14 实测，你的改动必须零回归）**：

| 门槛 | 基线 |
|---|---|
| 脚本断言 | **624 项**（manifest 92 / rerun 71 / audit 119 / export 138 / source-table 39 / semantic-lineage 48 / caliber 46 / cwd 13 / prompt-injection 58） |
| vitest | **15 文件 / 194 例** |
| UI 测试 | **4 文件 / 31 例** |
| ubuntu CI | 617（=624−7，`verify:cwd` caseDrift 闸门 SKIP，脚本既有设计） |

**并行任务提醒**：W2（X16，只动 `.github/workflows/`）、W3（X17，`server/table-relations.ts`、`src/utils/table-relations.ts`、`docs/specs/02-nodes.md`、`06-backend.md`）、W4（X18，`SQLQueryNode.tsx`、`tests/ui/sql-query-node*`、`docs/specs/02-nodes.md`）在别的 worktree 并行。**这些文件你一律不动**；spec 文档冲突由主会话 rebase 消解，你只写自己 scope 的小节。

## 4. 实现范围（逐项编号，对齐 acceptance）

**阶段 A（T3.1）**

1. **技术可行性评估**（design.md 首节，先于一切编码）：逐画布 S3 配置方案的架构（配置模型、画布 ID ↔ S3 key 映射、发现机制）vs 至少一个备选；依赖取舍（`@aws-sdk/client-s3` / 零依赖 SigV4 REST 自实现 / S3 兼容网关）；写入模型（本地写+异步同步 / 直写 S3+本地缓存）；并发写与一致性策略；凭据安全；对交互延迟的影响。**结论可行才继续；若发现重大不可行风险，用 `ask` 报主会话再定**
2. **存储接口化**：定义 StorageBackend 接口（会话 jsonl + 三类 sidecar 的 list/read/write/delete，或按「画布包」重新抽象——你定，但 `assertValidSessionPath` 等价安全边界必须保持）；LocalBackend 落地，**行为不回归**（既有 624/194/31 全绿不改断言）
3. **S3 后端**：逐画布配置 S3 地址/凭据引用（服务端配置/env 引用，不入画布数据）；`saveCanvas`/`loadCanvas` 及分享读写可走该后端；本地后端仍是默认（无配置即完全向后兼容）

**阶段 B（T3.2）**

4. **只读分享**：生成分享链接/令牌 → 打开只读画布视图（含 Manifest 信息展示；**含复跑**——只读=不可编辑源画布，但允许触发 T1.2 语义的复跑并生成新副本，具体交互你按 T1.2 语义设计并写 design.md）；只读态任何写操作不得回源画布
5. **fork 续写**：从分享视图 fork 出可写副本，保留**派生血缘**（新画布记录 forkFrom 元数据，画布级派生关系可追溯；不要动既有数据血缘边 `lineage.ts` 语义）
6. **测试**：存储接口契约测试（LocalBackend + S3 mock/stub，不依赖真实 S3）；分享只读断言（写操作被拒/不回源）；fork 血缘断言；既有断言零回归、不修改即通过
7. **文档与三件套**：WS 协议若新增消息类型，按 X2 契约走版本化 schema + 双端类型生成（是否 bump `PROTOCOL_VERSION` 按 X2 契约定，写 design.md）；`docs/specs/` 对应文档补分享/存储小节；三件套落 `docs/tasks/T3.1-canvas-team-storage/`（design.md 分「T3.1 / T3.2」两部分 + **「遗留问题」小节**；CHANGES.md；verification.md），T3.2 另在 `docs/tasks/T3.2-sharing-fork/` 落简版三件套（可引用 T3.1 design.md 章节，但验收证据须自述）

## 5. 范围纪律（明确不做）

- **不做** T3.3（多用户会话隔离/SSO）与 T3.4（Docker）；分享鉴权只做「链接+随机令牌」级，**不做账号体系**
- **不新作文件服务后端**（用户决策）
- S3 凭据禁止落入画布 JSON / sidecar / 导出 HTML / 日志 / 分享链接
- 不改 `docs/task-plan.json`（并行派发，记账由主会话统一执行）
- 不动 W2/W3/W4 的文件（见 §3 并行提醒）；不顺带重构 `buildRounds`/transcript 逻辑（除非接口化必需，且不改行为）
- 新依赖须在 design.md 论证（S3 客户端属合理候选，但要对比零依赖方案）；除 S3 相关外不引其它新依赖
- 新发现一律写 design.md「遗留问题」，不顺带修

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（`.agents/` 被 gitignore，fresh worktree 不含，约 350K）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，若 `node_modules` 未就绪自己 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、**不要以反斜杠结尾**；`python` 是 Windows Store 存根**不可用**（用 node/tsx）；JSON 解析用 `jq`（`/d/Work/jq/jq`）
- **禁止用 `head`/`tail`/`sed`/`grep` 截断 `govio-cli` 输出**（若验证中调 govio-cli，stdout 是 JSON，截断即无法解析；`npm run verify` 的人读摘要不受此限，但保留退出码与失败行）
- commit：**单次 commit**，message 前缀 `T3.1: ...`（message 注明 merged with T3.2）
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`，与 §3 基线零回归（新增用例导致断言数上涨须在 verification.md 逐项列出增量），verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态（主会话验收时统一置 done/accepted）
- 完成后**必须**发 orca 信号（只写终端不算完成）：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发，`--outcome` 用 `failed`/`blocked` 并说明缺口
- 需要真实 S3 环境验证的部分（若有）：留「待主会话补录」小节列出验证步骤，不要求你持有真实凭据
- 阻塞（依赖装不上、工具不可用、可行性重大风险）：`ask` 主会话，不要自行换方案或降级目标；收到 `send` 消息若正在做事，**先完成当前任务再处理**

## 7. 时间预算

- 总预算 **120 分钟**（`--timeout-ms 7200000`）
- **到期前 15 分钟为 checkpoint 点**（≈105min）：未完成则先把已改文件与三件套当前状态 commit（前缀 `T3.1: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」。**超时不是变更安全边界**
- 建议节奏：读档 ≤15min → 可行性评估定案 ≤20min → 存储接口化 + LocalBackend ≤20min → S3 后端 ≤25min → 分享/fork ≤25min → 测试与三件套 ≤15min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/T3.1-canvas-team-storage/{design.md,CHANGES.md,verification.md} + docs/tasks/T3.2-sharing-fork/ 三件套 + <代码文件摘要>
commit: <hash> <message>
可行性结论: <可行/有条件可行/不可行>（一句话：写入模型 + 并发策略 + 依赖取舍）
存储抽象: <接口名/文件>；S3 后端配置模型: <一句话>；凭据注入方式: <env/配置引用>
分享: <链接形态/令牌>；只读复跑语义: <一句话>；fork 血缘: <记录在哪/如何追溯>
断言数: 脚本 624 → <k>（增量逐项）；vitest 15 文件 194 例 → <..>；UI 4 文件 31 例 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>
新依赖: <无|包名+理由>
待主会话补录: <真实 S3 验证步骤 / PR 号 / 其它>
遗留: <design.md 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报验证结果。
