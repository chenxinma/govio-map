# T2.2 设计：口径溯源与语义血缘

> 任务书见同目录 `DISPATCH.md`；验收契约见 `docs/task-plan.json → T2.2.acceptance`
> （①边类型可视化区分 ②节点属性含语义引用列表）。上游：T2.1 注入管线
> （`docs/tasks/T2.1-graph-prompt-injection/design.md`）。

## 1. 目标

1. **口径溯源**：SQL 节点记录「本次口径引用了哪些图谱实体」——`node.data.semanticRefs`
   （指标/维度/字段标准的 entityType + id + code/name）；
2. **语义血缘**：画布血缘边区分「数据血缘」（数据流）与「语义血缘」（口径沿袭）——
   `Edge.data.lineageKind: "data" | "semantic"`，画布与导出 HTML 均可视化区分。

## 2. 类型模型（acceptance ②）

`src/types/semantic.ts`（前后端共享，与 `./manifest.ts` 同款模式）：

- `SemanticEntityType = "Metric" | "Dimension" | "Col"`——`server/prompt-injection.ts` 的
  `GraphEntityType` 改为别名复用（server 依赖 src/types，方向单向，避免反向依赖）；
- `SemanticRef { entityType, id, code?, name? }`——code/name 缺失即省略键；
- `LineageKind = "data" | "semantic"`。

`SQLQueryNodeData.semanticRefs?: SemanticRef[]`——**缺失省略键**（T2.0 同款模式）：
无注入（steer/followUp/图谱无实体/归因缺失）不建键，旧节点形状不变，UI 回退旧显示。

## 3. 语义引用归因链路（acceptance ②）

```
makePrompt（server/ws-handler.ts）
  └─ buildInjectionContext → ctx.graphEntities
  └─ setSessionSemanticRefs(session.sessionId, toSemanticRefs(ctx.graphEntities))   ①暂存
message_end（server/extensions/govio-canvas.ts）
  └─ getSessionSemanticRefs(piSessionContext(ctx).sessionId)                        ②取用
  └─ pushGovioNode({nodeType:"sqlQuery", semanticRefs})（一消息多代码块共享）
prompt 结束（ws-handler finally）→ clearSessionSemanticRefs(session.sessionId)      ③清除
```

- **暂存介质取舍：内存 map（`server/semantic-context.ts`，sessionId 为 key）而非落
  jsonl 再读**。prompt → message_end 是一对一（一次 prompt 一条 assistant 消息，主会话
  实证），无需持久化中间态；审计职责已由 T2.1 的 `<session>.injection.jsonl` 承担。
  代价：进程重启丢暂存——但重启即新会话，无跨进程归因需求。
- **生命周期与 `currentReferencedNodes`（govio-node-queue）完全一致**：注入时写入、
  本轮 prompt 结束清除。steer/followUp 不走 makePrompt、从不写入 → 其产出的 SQL
  节点自然没有 semanticRefs（**禁止猜测补全**，与全仓「缺失省略」纪律一致）。
- 归因 key 用 `piSessionContext(ctx).sessionId`（与 makePrompt 侧 `session.sessionId`
  同源）；key 不匹配 / getSessionId 抛错（piSessionContext 兜底空串）→ 不写键。
- 映射 `toSemanticRefs`：GraphEntity → SemanticRef 只保留 entityType/id/code/name，
  code/name 缺失省略键。

## 4. 血缘边分类与可视化（acceptance ①）

### 4.1 分类

`Edge.data.lineageKind`：

| 边 | 来源 | lineageKind |
|---|---|---|
| 数据血缘 | 自动边（referencedNodes/sourceRefs/dupDf 回填）、手动 onConnect | `"data"`（显式标记） |
| 语义血缘 | 新 sqlQuery 的 semanticRefs 与既有 sqlQuery 相交（entityType+id 判等）→ 旧→新 | `"semantic"` |
| 旧边 | 历史 sidecar、无 data 字段 | 回退 `"data"`（`lineageKindOf`） |

- 语义边 id 加 `-sem` 后缀（`e-<旧>-<新>-sem`），与同对节点的数据边**两线并存**互不冲突；
- 边创建后随 canvas sidecar 整体落盘，`Edge.data` 原样往返（session-history 无 schema
  校验），`hydrateSession` 整体恢复，不丢。

### 4.2 样式（唯一取值来源：`src/utils/lineage.ts`）

| kind | stroke | 线型 | animated | 说明 |
|---|---|---|---|---|
| data | `#1db954`（brand 绿） | 实线 | 是 | 与现状逐字一致，不改样式 |
| semantic | `hsl(270, 60%, 55%)` | 虚线 `6 4` | 否 | report 系 violet 色相（green-deck token `hsl(270,60%,...)`）加深至 55% 保描边对比；口径沿袭是静态关系，不流动 |

- **画布**：语义边虚线紫色；角落新增轻量图例 `src/components/Canvas/LineageLegend.tsx`
  （ReactFlow `<Panel position="bottom-left">`），两项说明两种边的线型/色相；
- **导出 HTML**（`export-report.ts`）：`LineageEdgeView.lineageKind` 随布局带出，
  `lineageSvg` 按 kind 取 stroke/虚线/箭头 marker（语义边专属 `govio-arrow-sem`
  紫色箭头），血缘图图例追加两种边说明；数据边渲染输出逐字不变（verify:export
  既有断言零回归）。

## 5. 省略纪律（贯穿）

- graphEntities 为空 / steer / followUp / 归因缺失 → `semanticRefs` **不写键**；
- SemanticRef 的 code/name 缺失 → 该键省略；
- 旧节点/旧边形状一律不变，未知 `lineageKind` 值回退 `"data"`。

## 6. 验证（`scripts/verify-semantic-lineage.ts`，45 项断言）

1. 归因模块：映射（code/name 省略）、暂存/读取/清除、空注入不建键；
2. 归因链路：stub pi 驱动 message_end——注入 → 事件带 semanticRefs（一消息多代码块
   共享）；无注入/跨会话/getSessionId 抛错 → 不建键；
3. 透传：事件 JSON → createGovioNode → node.data；旧事件不建键；
4. 往返：saveCanvas/loadCanvas、hydrateSession semanticRefs 深度相等；
5. 边分类：交集建语义边（-sem id 不冲突、与数据边并存）、无交集不建、旧边/手动边
   回退 data、lineageKind → 样式映射断言；
6. 导出：LineageEdgeView 分类 + HTML 两种边样式可观测。

## 7. 遗留问题（新发现，不在本任务实施）

1. **Standard 节点未注入**（T2.1 遗留 5 同源）：schema.md 中 Standard 无边，注入只覆盖
   Metric/Dimension/Col → semanticRefs 只能溯源到这三类；「标准 ID」（ROADMAP KR2 措辞）
   待图谱给 Standard 挂边后随注入补齐，届时 SemanticEntityType 扩枚举即可。
2. **steer-dispatch 路径的归因窗口**：prompt 消息在流式中派发时走 `session.steer()`
   （ws-handler），steer 排队即返回 → `.finally` 提前清暂存，该轮 message_end 可能
   拿不到 semanticRefs（与 currentReferencedNodes 自动边同款竞态，现状接受）。若需
   精确，应等 X2 协议给出轮次边界再收口。
3. **SQL 节点 UI 暂不展示 semanticRefs 列表**：验收②为「节点属性含语义引用列表」（数据
   模型层面），节点卡片渲染留待 UI 任务（可与 T2.3 口径警示展示一起做）。
4. **语义边不进 Manifest**：Analysis Manifest 的溯源字段（KR1 范畴）未含 semanticRefs；
   如需导出附录披露「本 SQL 的口径引用」，另立任务（T2.1 遗留 2 同类）。
5. **语义边匹配是精确键相交**（entityType+id）：同义指标（不同 id）不会连语义边；
   与 T2.1 遗留 4（子串匹配漏同义词）同根源，待图谱侧消歧机制。
6. **语义边方向按创建先后**（旧节点 → 新节点）：手动补建节点（createManualSQLNode
   不带 semanticRefs）不参与语义血缘；若后续允许手动挂口径，需补连线方向规则。
