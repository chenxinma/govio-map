# X19-W5b 文件清单（map 侧消费与收尾）

分支 `chenxinma/x19-caliber-map`，单次 commit（前缀 `X19:`）。运行时代码零改动。

## 1. `scripts/verify-caliber-conflict.ts`（改，46 → 77 项）

| 位置 | 摘要 |
|---|---|
| 文件头「覆盖链路」 | 新增第 8 条：X19-W5b 维度限定三态全链路透传（CLI JSON → 事件 → node.data → UI 映射）+ 空输出/空 results 两类降级输入 |
| `check()` 之后 | 新增内部助手 `caliberReasonHas(cliJson, needle)`：核对差异 reason 是否随条目透传，map 侧不改写文案本体 |
| `CLI_CONSISTENT` 之后 | 新增 6 个按 govio `c621de9` 实测文案构造的夹具：`CLI_DIM_CONFLICT`（矩阵 #3）、`CHECK_DIM_CONFLICT`（期望解析结果）、`CLI_DIM_UNKNOWN`（#4/#11 存疑两条目）、`CLI_DIM_CONSISTENT`（#10 无声明零条目）、`CLI_GRAIN_CONFLICT`（时间粒度，aspect `time_scope`）、`CLI_DIM_MIXED`（维度存疑 + 聚合冲突共存） |
| 新增 `[2b]` 段（13 项） | 维度差异三态解析：conflict 汇总与深度相等、aspect 复用 `filter`、三元组取值逐字透传、reason 原样保留且 conflict/存疑可区分、存疑不误报为 conflict、unknown 下条目不丢不合并、无声明不产条目、时间粒度 aspect、conflict 优先于 unknown 共存、条目形状纪律（缺 `found` → undefined）、reason 非空 |
| `[3] runCaliberCheck`（+5 项） | 维度 conflict 成功透传（深度相等）、维度存疑透传不升级；降级补强：空输出、空 `results`、维度差异形状非法均 → undefined（不抛错不阻断） |
| `[4] message_end`（+5 项） | 维度 conflict 事件深度相等；维度存疑事件仍建键且条目/reason 完整；维度无声明建键但零条目；空输出与空 `results` → 省略键且不阻断建节点 |
| `[5]`/`[6]`（+2 项） | 新增第三个节点事件 `dimWireJson`（`Q: dimension`）：WS JSON → `createGovioNode` 透传深度相等；sidecar `saveCanvas → loadCanvas` 往返后维度条目与 reason 完整保留 |
| `[7] UI 状态映射`（+6 项） | W5a 实际产出 aspect 全部已有展示名（零新增的回归门）、`filter`/`time_scope` 展示名核对、维度 conflict 亮警示 + 徽标 + 同一警示色、维度存疑不打扰、维度 consistent 不打扰、明细可渲染字段齐全（标签 + expected/found/reason） |

## 2. `docs/PENDING-DISCUSSION.md`（改）

PD-2 状态行追加「已定调**并落地**」标注：维度限定结构化比对随 govio PR #24（交付 `c621de9`、
merge `a92a291`）上线，map 侧消费收尾为 X19-W5b；并记录 aspect/三态契约未变、方案 C 仍挂起。

## 3. `docs/tasks/X19-caliber-dimension-substance/`（新增三件套）

| 文件 | 摘要 |
|---|---|
| `design.md` | map 侧视角的判定矩阵（11 条 + 时间粒度，逐条标注 status/aspect/画布可见性）；三态边界纪律（判定收在 status，map 不重推）；输出契约核对与 aspect 集合实测；展示核对结论（hover title + 展开明细已覆盖，零改动）；与方案 C 的界限；降级契约「空 differences」二分口径澄清；跨仓合并顺序；遗留问题 6 条 |
| `CHANGES.md` | 本文件 |
| `verification.md` | govio 版本与 commit（`c621de9` / PR #24 / merge `a92a291`）与关键函数行号；本机 CLI 版本核查（0.7.2，未含 W5a）；govio 侧 42 例分段证据 + 契约单例；8 档逐档判定记录表（含用例 SQL 原文，真实 CLI 标「待发版补录」）；+31 断言按三组逐项清单；门槛执行记录（build/lint/verify 与 655/194/31） |

## 4. 未改动（范围纪律）

`server/caliber-check.ts`、`src/utils/caliber.ts`、`src/types/semantic.ts`、
`src/components/Nodes/SQLQueryNode.tsx`、`server/extensions/govio-canvas.ts`、`src/utils/lineage.ts`、
`PROTOCOL_VERSION`、`docs/task-plan.json`（主会话记账）、govio 仓（只读引用）、
`tests/ui/sql-query-node.test.tsx`（与 X18 PR #39 同域，避免冲突）。