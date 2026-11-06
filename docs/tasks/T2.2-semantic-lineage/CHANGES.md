# T2.2 变更清单（口径溯源与语义血缘）

分支 `task/T2.2-semantic-lineage`，单次 commit（前缀 `T2.2: `）。设计见同目录 `design.md`。

## 新增文件

| 文件 | 内容 |
|---|---|
| `src/types/semantic.ts` | 共享类型：`SemanticEntityType` / `SemanticRef` / `LineageKind`（前后端同源） |
| `server/semantic-context.ts` | 归因暂存：`toSemanticRefs`（GraphEntity→SemanticRef，code/name 缺失省略键）、`set/get/clearSessionSemanticRefs`（内存 map，sessionId 为 key） |
| `src/utils/lineage.ts` | `lineageEdgeAppearance(kind)`（色值/线型/动画/图例文案唯一来源）+ `lineageKindOf(edge)`（旧边/未知值回退 "data"） |
| `src/components/Canvas/LineageLegend.tsx` | 画布角落血缘图例（ReactFlow Panel，说明两种边） |
| `scripts/verify-semantic-lineage.ts` | 45 项断言：归因链路 / 透传 / 边分类 / 导出区分 |

## 修改文件

| 文件 | 每处摘要 |
|---|---|
| `src/types/index.ts` | re-export semantic.ts；`SQLQueryNodeData.semanticRefs?: SemanticRef[]`（缺失省略键，T2.0 同款模式） |
| `server/prompt-injection.ts` | `GraphEntityType` 改为 `SemanticEntityType` 别名（单向依赖 src/types，枚举同源） |
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent.semanticRefs?: SemanticRef[]` |
| `server/ws-handler.ts` | `makePrompt` 在 buildInjectionContext 后 `setSessionSemanticRefs(sessionId, toSemanticRefs(ctx.graphEntities))`；prompt 派发 `.finally` 增加 `clearSessionSemanticRefs` |
| `server/extensions/govio-canvas.ts` | `message_end` 建 sqlQuery 节点时取 `getSessionSemanticRefs(piSessionContext(ctx).sessionId)`，非空才写键 |
| `src/services/canvas-service.ts` | `CanvasEvent.semanticRefs?: SemanticRef[]` |
| `src/store/canvas-store.ts` | ① sqlQuery 分支透传 semanticRefs（有值才写键）② 新增语义边：semanticRefs 与既有 sqlQuery 相交（entityType+id）→ 旧→新 `lineageKind:"semantic"` 边（id 加 `-sem` 后缀，与数据边并存）③ 三处自动边 + onConnect 显式标 `data.lineageKind:"data"`（样式不变） |
| `src/utils/export-report.ts` | `LineageEdgeView.lineageKind`；`lineageSvg` 按 kind 取 stroke/虚线/箭头（语义边专属 `govio-arrow-sem` 紫 marker），数据边输出逐字不变；血缘图图例追加两种边说明；说明文案标注实线/虚线语义 |
| `src/components/Canvas/Canvas.tsx` | 挂载 `<LineageLegend />` |
| `package.json` | 新增 `verify:semantic-lineage`，接入 `verify` 聚合链（verify:source-table 之后） |
| `docs/task-plan.json` | 仅 T2.2 条目：status → done + history + 顶层 updatedAt |

## 不改（范围纪律）

WS 协议（X2）/ REF/CTX prompt 格式 / 节点类型集合 / T2.3 冲突检测 / verify-prompt-injection
/ Standard 注入 / agent SQL 注释协议——见 design.md「遗留问题」。
