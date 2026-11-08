# T2.2 任务书：口径溯源与语义血缘（DISPATCH）

> 执行者：pi subagent worker（fresh context，自包含任务书）。完成定义见 AGENTS.md「worker：完成定义」。

## 1. 背景与动机

Phase 2 的目标是「口径是不是公司口径」：AI 生成的 SQL 要能追溯到知识图谱中的指标/标准定义。
T2.1（已合并，PR #20）已在 prompt 组装时自动注入图谱实体（Metric/Dimension/Col）并在
`<session>.injection.jsonl` 留痕，但注入结果**没有落到画布产物上**——SQL 节点看不出本次用了
哪套口径，画布血缘边也无法区分「数据流」与「口径沿袭」。

本任务（ROADMAP Phase 2 KR2）落地两件事：

1. SQL 节点记录「本次口径引用了哪些图谱实体」（指标 ID / 标准 ID），即 `semanticRefs`；
2. 画布血缘边区分「数据血缘」与「语义血缘」（`lineageKind`）并可视化区分。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、完成定义、验证门槛）
2. `docs/task-plan.json → T2.2` 条目（scope/acceptance 契约）
3. `docs/ROADMAP.md` Phase 2 KR2 行（口径溯源节点属性）
4. `docs/tasks/T2.1-graph-prompt-injection/design.md`（注入管线与留痕形态，本任务的语义引用来源）
5. `src/types/index.ts`（SQLQueryNodeData、SourceTableNodeData 的「缺失省略键」既有模式）
6. `server/govio-node-queue.ts`（GovioNodeCreateEvent 形状）
7. `server/extensions/govio-canvas.ts:279-289`（extractSqlCodeBlocks）与 `:891-933`（message_end 建 sqlQuery 节点）
8. `server/ws-handler.ts:537-557`（makePrompt：buildInjectionContext + recordInjectionTrace 调用点）
9. `server/prompt-injection.ts`（`GraphEntity`/`GraphEntityType`、`InjectionTraceEntry`、`recordInjectionTrace`/`readInjectionTrace`）
10. `src/store/canvas-store.ts:140-320`（createGovioNode：节点落库与自动建边）、`:85`（onConnect）
11. `src/utils/export-report.ts:268`（LineageEdgeView）、`:406`（导出边固定绿色 stroke）
12. `scripts/verify-source-table.ts`（verify 脚本的链路断言模式）、`package.json → scripts.verify*`

## 3. 实证事实（主会话已调研，避免重复踩坑）

- **语义引用的确定性来源是 T2.1 注入留痕**：`makePrompt`（`server/ws-handler.ts:537`）每条 prompt
  调 `buildInjectionContext` 得到 `ctx.graphEntities`（`{entityType, id, code}`，entityType ∈
  `"Metric" | "Dimension" | "Col"`，定义在 `server/prompt-injection.ts:47-53`），随后
  `recordInjectionTrace` 追加写 `<session>.injection.jsonl`。
- **SQL 节点在 `message_end` 创建**（`server/extensions/govio-canvas.ts:891`）：从 assistant 文本
  抽 SQL 代码块逐个 `pushGovioNode({nodeType:"sqlQuery", ...})`，一个消息多个代码块共享同一份
  message 级上下文。会话 ID 可取 `piSessionContext(ctx).sessionId`（`server/analysis-manifest.ts:128`），
  与 `makePrompt` 侧 `session.sessionId` 同源，可作归因 key。
- **归因可行性**：prompt → message_end 是一对一的（一次 prompt 产出一条 assistant 消息）。
  注意 `steer`/`followUp` 不走注入（T2.1 design §2.2），其产出的 SQL 节点应无 semanticRefs。
  留痕仅在 `ctx.tables.length > 0 || ctx.graphEntities.length > 0` 时写入（`ws-handler.ts:551`），
  仅 tables 无实体时 graphEntities 为空 → 不产 semanticRefs。
- **边的现状**：`canvas-store.ts:271-308` 自动边统一 `type:"smoothstep", animated:true,
  style:{stroke:"#1db954", strokeWidth:2}`，id 形如 `e-${source}-${target}`；重复 df 去重用同款
  id 判断（`canvas-store.ts:182`）。`onConnect`（`:85`）手动连线走 `addEdge` 默认形状。
- **持久化**：edges 随 canvas sidecar 整体落盘（`server/session-history.ts` saveCanvas/loadCanvas），
  `hydrateSession`（`canvas-store.ts:495`）整体恢复——`Edge.data` 原样往返，无 schema 校验。
- **可选字段省略模式**（T2.0 先例）：`...(event.datasource ? { datasource: event.datasource } : {})`
  ——缺失不写键、旧节点形状不变、UI 回退旧显示。`SQLQueryNodeData` 有 `[key: string]: unknown`
  索引签名，但请像 `manifest` 一样**显式声明**字段。
- **导出**：`src/utils/export-report.ts` 的 LineageEdgeView/边渲染固定 `stroke="#1db954"`。
- **图谱 schema**（`.agents/skills/govio/assets/schema.md`）：`Metric{id,code,name,...}`、
  `Col{id,column,...}`、`Standard{id,standard_id}`；注入只覆盖 Metric/Dimension/Col，
  `Standard` 节点未注入——不在本期范围（写入 design.md 遗留问题）。
- **verify 脚本模式**：`scripts/verify-*.ts` 自包含断言脚本（`check(label, cond)` 计数、
  失败退出码 1），注册 `package.json` `verify:xxx` 并追加进 `scripts.verify` 聚合链。
- 环境：Windows Git Bash，正斜杠路径；`jq` 可用，`python` 不可用；`node -e` / `tsx` 备选。

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **类型模型**（`src/types/index.ts`）：
   - 新增 `SemanticRef { entityType: "Metric" | "Dimension" | "Col"; id: string; code?: string; name?: string }`
     （entityType 与 `server/prompt-injection.ts` 的 `GraphEntityType` 对齐；注意避免 server↔前端
     反向依赖，共享类型放 `src/types/`，server 侧 import 或复用）；
   - `SQLQueryNodeData.semanticRefs?: SemanticRef[]`——缺失省略键，旧节点兼容（T2.0 同款模式）。
2. **语义引用归因链路**（服务端）：
   - `GovioNodeCreateEvent` 增加 `semanticRefs?: SemanticRef[]`；
   - 归因：`makePrompt` 时把本轮 `ctx.graphEntities`（含 code/name，见 prompt-injection 现有取数）
     暂存为「本会话最近一次注入上下文」（sessionId 为 key，内存 map 即可；落 jsonl 再读亦可，
     取舍写 design.md），`message_end` 创建 sqlQuery 节点时取来填充；
   - 省略纪律：graphEntities 为空 / steer / followUp / 归因缺失 → **不写键**，禁止猜测补全。
3. **前端透传与持久化**（`src/store/canvas-store.ts`、sidecar）：
   - `createGovioNode` sqlQuery 分支透传 `semanticRefs`（有值才写键）；saveCanvas/loadCanvas、
     `hydrateSession` 往返不丢。
4. **血缘边分类与可视化**（`src/store/canvas-store.ts` + 边渲染）：
   - `Edge.data.lineageKind: "data" | "semantic"`；旧边无 data → 按 `"data"` 处理（兼容回退）；
   - **数据血缘边**：现有全部自动边（referencedNodes/sourceRefs）与手动 onConnect 连线，样式不变
     （绿色实线动画）；
   - **语义血缘边**（口径沿袭）：新建 sqlQuery 节点时，若其 `semanticRefs` 与既有 sqlQuery 节点的
     `semanticRefs` 有交集（按 entityType+id 判等），从旧节点连一条 `lineageKind:"semantic"` 边到
     新节点；同一对节点已存在数据血缘边时两线并存，edge id 加 `-sem` 后缀防冲突；
   - 可视化区分（acceptance 1）：语义边用虚线 + 不同色相（从 green-deck 设计 token 取，如
     report 系 violet/amber；具体色值与线型写 design.md）；画布上提供轻量图例（如角落 legend
     小组件）说明两种边；`export-report.ts` 导出 HTML 中同样区分（stroke/虚线样式随 lineageKind）。
5. **验证脚本**：新增 `scripts/verify-semantic-lineage.ts`（`npm run verify:semantic-lineage`），
   按 `verify-source-table.ts` 的链路模式断言至少覆盖：
   - 归因：stub 注入上下文 → message_end 建 sqlQuery 节点带 semanticRefs；无注入/steer 路径
     不产生 semanticRefs 键；
   - 透传：GovioNodeCreateEvent → createGovioNode → node.data → saveCanvas/loadCanvas 往返 →
     hydrateSession，semanticRefs 深度相等；旧事件不建键；
   - 边分类：semanticRefs 交集建语义边（id 不与数据边冲突）、无交集不建、旧边/手动边按 data
     处理、样式区分可观测（如 lineageKind → 样式映射函数的断言）；
   - 导出区分：LineageEdgeView 按 lineageKind 出不同样式。
   - `package.json` 追加 `verify:semantic-lineage` 并接入 `verify` 聚合链；既有断言零回归。

## 5. 范围纪律（明确不做）

- 不做口径冲突检测（T2.3）、不做命中率统计口径变更（T2.1 的 verify-prompt-injection 不动）；
- 不做 Standard 节点注入、不做 agent SQL 注释标注协议（如 `/* @metric: */`）——如调研中发现
  必要，落 design.md「遗留问题」；
- 不新增节点类型、不改 WS 协议消息形态（X2 契约不动）、不动 REF/CTX prompt 格式；
- 不顺带重构 canvas-store/export-report；新发现的缺陷一律记 design.md 遗留问题，不扩大范围。

## 6. 环境与协议

- **分支**：从 main 创建并停留 `task/T2.2-semantic-lineage`，本地 commit，**不 push**（PR 由主会话创建、用户合并）；
- Windows Git Bash：正斜杠路径、`jq` 解析 JSON、`python` 不可用；
- 状态协议：只改 `docs/task-plan.json → T2.2` 自己的条目（完成置 `done` + history 条目 +
  顶层 `updatedAt`），不碰其他任务；
- 交付物三件套必交：`docs/tasks/T2.2-semantic-lineage/design.md`（方案与取舍 + 「遗留问题」小节）、
  `CHANGES.md`（文件清单 + 每处摘要）、`verification.md`（验证命令与关键输出）；
- 验证门槛全绿方可提交：`npm run build`、`npm run lint`、`npm run verify`（含新脚本，既有断言
  零回归），且全跑后 `git status --porcelain` 干净；
- 单次 commit，message 前缀 `T2.2: `；禁止虚报验证结果，未完成项如实报告。

## 7. 时间预算

- 总预算 60 分钟；到期前 10 分钟必须 checkpoint：已改文件清单 / 验证状态 / 剩余工作（写入
  CHANGES.md 或直接在输出中报告），超时不是变更安全边界。

## 8. 最终输出格式（≤15 行摘要）

```
status: done | partial
交付物: design.md / CHANGES.md / verification.md（路径）
commit: <hash> T2.2: ...
验证: build ✓ lint ✓ verify ✓（断言数 N→M，新增 verify:semantic-lineage K/K）
实现要点: <1-2 行>
遗留: <无 / 列表>
```
