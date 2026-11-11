# BUGFIX: 合并后 `canvas-store` 丢失 `lineageEdge` 导入（build + verify 阻断）

- 发现时间：2026-11-11（PR #28 / #29 / #30 合并入 main 后，主会话按验收协议在合并后的 main 上复跑门槛）
- 影响面：**P0 阻断** —— `npm run build` 失败（TS2304 ×4）、`npm run verify` 在 `verify:semantic-lineage` 崩在第 6 个脚本（后续 5 个子脚本与 vitest 全部未执行）
- 引入方式：合并冲突解决错误（不是任何单个 PR 自身的缺陷）
- 修复 commit：见文末

## 症状

合并后 main 上：

```
$ npm run build
src/store/canvas-store.ts(190,33): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(285,25): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(305,25): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(323,23): error TS2304: Cannot find name 'lineageEdge'.
（×2：app 与 server 两个 tsconfig project 各报一次）

$ npm run verify   # 前 5 个脚本绿，第 6 个崩
D:\Work\gov-io\govio-map\src\store\canvas-store.ts:323
        newEdges.push(lineageEdge("semantic", {
                 ^
ReferenceError: lineageEdge is not defined
    at Object.createGovioNode (src\store\canvas-store.ts:323:18)
    at create (scripts\verify-semantic-lineage.ts:236:31)
```

## 根因

两条独立变更在 `src/store/canvas-store.ts` 的**同一处 import 行**相撞，合并时取错了边：

1. main 上的 hotfix `5af8555`（*血缘边 type/animated/style 收束到 lineage.ts APPEARANCE 统一配置*）把
   ```diff
   -import { lineageEdgeAppearance } from '../utils/lineage';
   +import { lineageEdge } from '../utils/lineage';
   ```
   并把 4 处建边全部改成走 `lineageEdge(kind, {id, source, target})` 工厂（形状/样式/`data.lineageKind` 由 `lineage.ts` 的 `APPEARANCE` 唯一派生）。
2. X10 分支（PR #29，基于 `940c2f2`，早于该 hotfix）仍是 `import { lineageEdgeAppearance }`，其新增的表间语义边块自行拼 `type/animated/style`。

`4aee3bc Merge branch 'main' into chenxinma/x10-table-semantic-edges` 解决冲突时，**调用点取了 main 侧**（4 处 `lineageEdge(...)`），**import 行取了 X10 侧**（`lineageEdgeAppearance`）→ 符号未定义。`lineageEdge` 一直在 `src/utils/lineage.ts:47` 正常导出，纯粹是导入丢失。

> 三个 PR（#28 X12 / #29 X10 / #30 chat 折叠）文件集本身不相交，冲突发生在 #29 分支**主动合并 main** 时，因此「文件不相交 ⇒ 合并无风险」的预判在这里不成立：**同一文件同一行的语义冲突不会体现为文件级重叠**。

## 修复

按 hotfix `5af8555` 的既定意图（`lineageEdge` 是建边唯一工厂）收敛，而不是把 import 补成两个符号：

```diff
-import { lineageEdgeAppearance } from '../utils/lineage';
+import { lineageEdge } from '../utils/lineage';
```

```diff
     if (event.nodeType === "sourceTable") {
       const candidates = tableSemanticEdgeCandidates(nodes, { id: nodeId, data: newNode.data }, edges);
-      if (candidates.length > 0) {
-        const sem = lineageEdgeAppearance('semantic');
-        for (const { sourceId, targetId } of candidates) {
-          newEdges.push({
-            id: `e-${sourceId}-${targetId}-sem`,
-            source: sourceId, target: targetId,
-            type: "smoothstep",
-            animated: sem.animated,
-            style: { stroke: sem.stroke, strokeWidth: sem.strokeWidth, strokeDasharray: sem.strokeDasharray },
-            data: { lineageKind: "semantic" },
-          });
-        }
-      }
+      for (const { sourceId, targetId } of candidates) {
+        newEdges.push(lineageEdge("semantic", {
+          id: `e-${sourceId}-${targetId}-sem`,
+          source: sourceId,
+          target: targetId,
+        }));
+      }
     }
```

要点：
- X10 的表间语义边改走工厂后，**边形状逐字段等价**（`type:"smoothstep"`、`animated:false`、`style.stroke/strokeWidth/strokeDasharray:'6 4'`、`data.lineageKind:'semantic'`），既有断言（含 X10 的 37 例新用例）全部不变即通过
- `lineageEdgeAppearance` 在 `canvas-store.ts` 内**再无引用**，故必须从 import 移除 —— `tsconfig.app.json` 开了 `noUnusedLocals`，留着会变成 TS6133 新错误
- 同步修正该块注释（不再声称样式取自 `lineageEdgeAppearance`）
- `src/utils/export-report.ts` 仍合法使用 `lineageEdgeAppearance`（导出 SVG 需要裸色值），未受影响

## 验证（修复后，合并态 main）

```
build=0  lint=0  verify=0     （build+lint+verify 合计 233s）
verify:manifest          92 项断言，失败 0
verify:rerun             71 项断言，失败 0
verify:audit            119 项断言，失败 0
verify:export           126 项断言，失败 0
verify:source-table      39 项断言，失败 0
verify:semantic-lineage  45 项断言，失败 0   ← 崩溃点恢复
verify:caliber-conflict  46/46 checks passed
verify:cwd               13 项断言，失败 0
verify:prompt-injection  58/58 通过
verify:integration       Test Files 11 passed (11) / Tests 143 passed (143)
verify:ui                Test Files 2 passed (2)  / Tests 16 passed (16)
```

脚本断言合计 **609 项 0 失败**（与 X10/X12 派发前基线逐项一致）；vitest 由基线 7 文件/83 例 → **11 文件/143 例**（X10 +1 文件/+37 例、X12 +2 文件/+16 例、PR #30 chat-fold +1 文件/+7 例）。verify 全跑后 `git status --porcelain` 仅本次修复文件。

## 教训 / 后续

1. **并行 PR 合并后必须在合并态 main 上复跑完整门槛**——本 bug 在任一单独分支上都测不出来（X10 分支自洽、main 自洽），只在合并态暴露。本次正是靠验收协议第 1 步「独立复跑」拦下，未流入用户手里。
2. **文件级不相交 ≠ 无冲突**：`git merge` 的行级冲突解决可能「调用点取一边、import 取另一边」，产生编译期才暴露的符号缺失。合并含 import 行改动的分支时，冲突解决后应至少跑一次 `npm run build`（`tsc -b`）再 push。
3. 建议在 X12 建立的 UI/组件测试基建之外，把 `npm run build` 作为 PR 合并前的强制门（当前 verify 链已含 build 之外的全部脚本，但 GitHub 侧未设 CI 检查）。是否需要引入 CI（Actions 跑 build+lint+verify）→ 待用户裁决，暂记于此。
