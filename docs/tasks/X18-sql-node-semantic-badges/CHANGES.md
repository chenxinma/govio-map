# X18 · CHANGES.md（文件清单 + 每处摘要）

分支：`chenxinma/x18-semantic-badges`（Orca worktree，单写者）
规模：11 个文件（2 新增 / 9 修改），`git diff --stat` 见文末。

## 新增

| 文件 | 摘要 |
|---|---|
| `src/utils/semantic-refs-ui.ts` | 「口径」徽标区的**展示模型**（纯函数、无 React 依赖）：`MAX_VISIBLE_SEMANTIC_REFS = 3`、`SEMANTIC_ENTITY_TYPE_LABELS`、`semanticRefTypeLabel()`、`semanticRefLabel()`（`code ?? name`，都缺 → `null`）、`semanticRefTitle()`（hover 全文：类型/编码/名称/图谱 ID，缺项省略）、`semanticRefBadges()`（脏元素过滤 → `entityType:id` 去重 → 丢无短名 → Metric 优先稳定排序）。画布与导出共用，色值不在此模块。 |
| `tests/integration/semantic-refs-ui.test.ts` | 展示模型单测 **19 例**：类型名与未知值兜底、code 优先 / name 回退 / 纯空白回退 / 都缺 → null、hover 全文四项与缺项省略、Metric>Dimension>Col 排序且同类型保持注入原序、非指标前缀类型名、Col 无短名整条跳过、重复注入去重、不同 entityType 同 ID 不互吞、无 ID 时 key 序号兜底、脏元素与非数组入参、徽标字段完整性、折叠基准 = 3。 |

## 修改

| 文件 | 摘要 |
|---|---|
| `src/components/Nodes/SQLQueryNode.tsx` | ① lucide 增 `ChevronUp`、`Tag`；② 引入 `semantic-refs-ui`；③ 新增 `refsExpanded` 状态与 `semanticBadges` / `visibleSemanticBadges` / `remainingSemanticBadges`（折叠基准按上限固定计算，与字段区/关系小节同款）；④ 在 SQL 正文与「输出列」之间插入「口径」徽标区：`Tag` 图标 + 小节名 + 右侧计数 + 紫色 token 徽标（`bg-node-source/10 text-node-source font-mono`，带 hover `title`）+ `+N more refs` / `Collapse` 折叠按钮；⑤ `semanticBadges.length === 0` 时**整节不渲染**。未改标题行的 T2.3 警示逻辑与配色来源，未加任何内联色值。 |
| `src/utils/export-report.ts` | ① 引入 `semanticRefBadges`；② 新增 `semanticRefsBlock(d)`：「口径引用（N）」表（类型 / 编码 / 名称 / 图谱 ID，缺失渲染 `—`，内容经 `esc()` 转义），复用既有 `label()` / `table()` / `.scroll` 结构；③ `sqlQueryBody` 在「输出列」之后、Manifest 之前插入该块；④ 无徽标时返回空串（整节不渲染）。 |
| `scripts/verify-export-report.ts` | ① 样例 `SQL_NODE` 补 `semanticRefs`（Dimension+code/name、Metric code+name、Metric 仅 name、Col 无短名、重复 Metric、名称含 `XSS_SENTINEL` 的 Metric）；② 新增 `[3c]` 小节 **9 条断言**：计数只算可展示徽标（4）、Metric 排在 Dimension 前、name 回退、Col 整条跳过（ID 不进产物）、重复注入只渲染一条、注入内容被转义、无 refs 整节不渲染、只有 Col 整节不渲染、新增内容不破坏自包含；③ 文件头覆盖清单补第 10 条。**只增不削**（既有断言未改动）。 |
| `scripts/verify-semantic-lineage.ts` | ① 引入 `semanticRefBadges`；② 新增 `[7]` 小节 **6 条断言**：用贯穿全脚本的 `REFS`（归因链路写入 `node.data` 的同一份数据）验徽标取值（Metric 产出、Col 跳过）、hover 全文逐字、Metric 优先 + name 回退 + 非指标前缀、重复注入去重、空入参 → `[]`、导出 HTML 同步渲染「口径引用（1）」；③ 文件头覆盖清单补第 7 条。**只增不削**。 |
| `tests/ui/sql-query-node.test.tsx` | ① 引入 `fireEvent` 与 `SemanticRef` 类型；② 新增 `badgeCount()` 辅助（按结构取小节计数，避开 SQL 语法高亮拆出的数字 span 撞文本）；③ 新增 describe「口径徽标（X18 / PD-1 方案 1）」**6 例**：小节渲染（code 优先 + 维度前缀 + 计数）、hover 全文四项、code 缺失回落 name 与都缺跳过且无 `undefined`、无 refs 整节不渲染、超 3 条折叠与展开收起、与 T2.3 警示共存（警示文档顺序在前 + 徽标无内联色值 + 用 token class + 警示黄未被改写）。 |
| `docs/specs/02-nodes.md` | `SQLQueryNodeData` 表补 `semanticRefs?` 行；新增「口径徽标区（X18，PD-1 方案 1）」小节：取值与排序规则、N=3 与折叠范式、跳过与整节不渲染条件、hover 取舍、展示模型唯一来源、紫色 token 理由、与 T2.3 警示的分工、导出同步方式。（只改 sqlQuery 小节，未触碰 X17 正在改的表间关系小节。） |
| `docs/PENDING-DISCUSSION.md` | PD-1 状态由「已裁决并立项」改为「**已裁决并落地**」，补落地形态（徽标区 / 展示模型 / 导出同步 / 空态）与交付物路径；「待定」改为无，并留下 code vs 中文名的产品口径提示（指向 design.md 遗留 1）；顺带修正原文两处「徐标」错字。 |
| `docs/USER-MANUAL.md` | ① 5.1 节点一览表 SQL 行补「口径徽标（引用的图谱指标/维度）」；② 5.2「SQL 节点」新增一条：徽标含义、紫色与语义血缘边同色系、hover 看类型/编码/名称/图谱 ID、超 3 条折叠、哪些情况不显示、冲突时黄色警示优先且徽标不用警示黄。 |
| `docs/demo/video-script-chocolate.md` | 场景 4 末尾追加「**X18 更新**」引注：说明卡片现在直接渲染口径徽标，并**如实标注本节实录素材早于 X18、画面里没有徽标**，给出重录时的同框建议（不改分镜结构与时长）。 |

## 未改动（范围纪律自查）

- `src/utils/lineage.ts`、`src/types/**`、`src/store/canvas-store.ts`、`server/**`：零改动（不新增节点类型、不改边语义、不改 `PROTOCOL_VERSION`、不改节点数据形状）
- `package.json` / `package-lock.json`：零改动（无新依赖）
- `docs/task-plan.json`：零改动（并行模式，主会话记账）
- W1（session-history / 分享）、W2（`.github/`）、W3/X17（`server/table-relations.ts`、`src/utils/table-relations.ts`、`docs/specs/02-nodes.md` 表间关系小节）的文件：零改动

## diffstat

```
 docs/PENDING-DISCUSSION.md            |   4 +-
 docs/USER-MANUAL.md                   |   5 +-
 docs/demo/video-script-chocolate.md   |   2 +
 docs/specs/02-nodes.md                |  14 +
 scripts/verify-export-report.ts       |  56 +
 scripts/verify-semantic-lineage.ts    |  40 +
 src/components/Nodes/SQLQueryNode.tsx |  58 +-
 src/utils/export-report.ts            |  26 +
 tests/ui/sql-query-node.test.tsx      | 101 +-
 9 files changed, 299 insertions(+), 7 deletions(-)
 新增（未计入上表）：src/utils/semantic-refs-ui.ts、tests/integration/semantic-refs-ui.test.ts
```
