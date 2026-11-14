# X17 验证记录（2026-11-14，本机 Windows 沙箱 + Git Bash 约定分支 worktree）

分支 `chenxinma/x17-relation-match`，commit `X17: ...`（见 git log）。基线（主会话 2026-11-14）：
脚本 624 项 / vitest 15 文件 194 例 / UI 4 文件 31 例。**全部零回归 + 纯增量。**

## 1. 门槛结果

| 门槛 | 结果 |
|---|---|
| `npm run build`（tsc -b + vite build + compile:server） | exit 0（esbuild 步骤需非沙箱跑：`Cannot read directory: Access is denied` 为沙箱系统调用限制，非代码问题） |
| `npm run lint`（eslint .） | exit 0（无告警输出） |
| `npm run verify`（11 段全跑） | exit 0；日志 ✓ 断言合计 **624 项**（与基线一致，本任务未增删脚本断言） |
| `vitest run`（verify:integration） | **16 文件 210 例全绿**（基线 15/194 → +1 文件 +16 例，全部来自新增 `tests/integration/x17-relation-match.test.ts`） |
| `vitest run tests/ui`（verify:ui） | **4 文件 31 例全绿**（基线不变） |
| verify 后 `git status --porcelain` | 干净（无残留） |

## 2. 新增断言逐项（tests/integration/x17-relation-match.test.ts，16 例）

### 组 1：服务端落键（5 例）
1. 图谱主路径：关系带 `targetQualifiedName`（= `row.target` 原值，fake runner 按 src 过滤模拟 WHERE）
2. 缺失 target 列的行（仅 `tgt` 兜底形状）→ 有 `targetTable` **不建键**（禁止猜测）
3. 字段级降级路径：**不建键**（X10 行为一字不改，`Object.keys` 断言无该键）
4. 形状锁定：`relationsFromGraphRows` 本体不产 `targetQualifiedName`（落键只发生在取数层——守「既有用例不修改即通过」契约）
5. 边界：空关系数组原样返回；空白/非法 `target` 列不建键；命中 target 列集合才浅拷贝补键

### 组 2：前端三级匹配（9 例）
6. ①全等命中即止：边只连全限定名一致的同名节点 dim-a，dim-b 不误连（含候选带出关系原文）
7. 对照（X10 行为）：同场景去掉键 → 裸表名变体把 dim-a/dim-b 两张同名表**都**连上（误配基线实证）
8. 大小写归一：`Sales.A.Dim_Product` 对 `sales.a.dim_product` 全等命中，同样只连 dim-a
9. ②全等未命中退变体兜底：图谱段数与节点不一致（`dim_product` vs 三段式节点）时仍连边
10. ②旧节点兜底：节点无 `qualifiedName`（T2.0 旧形状）按裸表名连边、不报错
11. ③都不中不建边：全限定名与变体都和画布节点无交集 → 零候选
12. 反向（既有→新）：dim 表后上画布时，既有 fact 带键关系全等命中、只连 dim-a（命中即止跳过变体）
13. 键透传：`nodeTableRelations` 保留合法字符串键、过滤非法形状（数字 42 不建键）
14. 助手归一：`relationExactTargetKey` / `sourceTableQualifiedNameKey` 的空值/非法形状/大小写/非 sourceTable 边界

### 组 3：端到端跨库同名（2 例，任务书 §4.4 主断言）
15. fake runner 两行同名跨库（`sales.a.dim_product` / `sales.b.dim_product`）：fact_b 后上画布，
    唯一边连到 **dim-b**（正确目标），同名 dim-a 不误连
16. 两条跨库关系各自独立落键：fact-a→dim-a、fact-b→dim-b 互不串线

## 3. 既有用例零回归（不修改即通过）证据

- `tests/integration/table-relations.test.ts`：**27/27 通过**（基线复跑 + 合跑各一次；未改动，git diff 为空）
- `tests/integration/canvas-store.test.ts`（X10 星型/双向/去重）+ `tests/integration/table-relations-ui.test.ts`
  （X13/X15 展示与边 label）+ 其余 integration：全绿（210 = 194 + 16，无任何原用例修改）
- 合跑四文件：`94 passed (94)`（改动后直接验证）
- 对照实证「为什么落键不放 relationsFromGraphRows 本体」：在该函数加键 → `table-relations.test.ts:147`
  `toEqual` 失败（`expected { …(6) } to deeply equal { …(5) }`，1 failed | 26 passed）；
  本实现落点在 `resolveTableRelations`（`withGraphQualifiedNames`），27 例零改动通过（取舍见 design.md §2.2）

## 4. 未验证项（如实记录）

- live 图谱真实调用未跑（任务书：fake runner 断言为主，不写图不清图；当前图谱无重名，
  主会话取证已覆盖现实行为不变的结论）
- 画布目视交互（建边效果）不在 worker 门槛内；三级匹配为纯函数改动，由断言 6-16 覆盖