# T2.2 验证记录（口径溯源与语义血缘）

环境：Windows Git Bash，Node v24。全部命令在 `task/T2.2-semantic-lineage` 分支本地执行（不 push）。

## 命令与结果

```bash
npm run build   # tsc -b + vite build
# ✓ 通过（tsc 无错误，vite 构建成功）

npm run lint    # eslint .
# ✓ 通过（无输出，零告警）

npm run verify  # 聚合链（含新增 verify:semantic-lineage）
```

`npm run verify` 关键输出（逐脚本断言数）：

```
verify:manifest          共 92 项断言，失败 0 项   PASS（基线 92，零回归）
verify:rerun             共 71 项断言，失败 0 项   PASS（基线 71，零回归）
verify:audit             共 119 项断言，失败 0 项  PASS（基线 119，零回归）
verify:export            共 126 项断言，失败 0 项  PASS（基线 126，零回归）
verify:source-table      共 39 项断言，失败 0 项   PASS（基线 39，零回归）
verify:semantic-lineage  共 45 项断言，失败 0 项   PASS（新增 45）
verify:cwd               共 13 项断言，失败 0 项   PASS（基线 13，零回归）
verify:prompt-injection  47/47 通过                （基线 47，未改动）
verify:integration       Test Files 5 passed / Tests 59 passed（基线 59，未改动）
```

断言数变化：脚本断言 **507 → 552**（+45，全部来自 `scripts/verify-semantic-lineage.ts`），
vitest 59 不变；既有断言零回归（逐脚本计数与基线一致）。

## 新增 verify:semantic-lineage 覆盖（45 项）

1. **归因模块（7）**：GraphEntity→SemanticRef 映射（code/name 缺失省略键）、暂存/读取/
   清除、空 refs=清除、空 sessionId 不可归因；
2. **归因链路（10）**：stub pi 驱动 govio-canvas `message_end`——注入上下文 → sqlQuery
   事件带 semanticRefs（深度相等、manifest 不受影响、一消息两代码块共享）；无注入
   （steer/followUp 形态）/ 从未写入 / 跨会话 sessionId 不匹配 / getSessionId 抛错
   均不产生 semanticRefs 键；
3. **透传（2）**：事件 JSON → createGovioNode → node.data 深度相等；旧事件不建键；
4. **往返（4）**：saveCanvas→loadCanvas、hydrateSession 后 semanticRefs 深度相等，
   旧节点/旧边兼容；
5. **边分类（17）**：semanticRefs 交集建语义边（`-sem` id 与数据边并存不冲突、按
   entityType+id 判等、无交集不建）；手动 onConnect/旧边/未知值回退 "data"；
   lineageKind→样式映射（绿色实线动画 vs 紫虚线静态）与实际边样式一致；
6. **导出区分（5）**：LineageEdgeView 按 lineageKind 分类、旧边回退 data、导出 HTML
   语义边紫虚线+专属 marker、数据边样式逐字不变、图例含两种边说明。

## 全跑后工作树状态

```bash
git status --porcelain
# 仅本任务的变更文件与交付物（无验证残留物、无未预期文件）；commit 后干净
```
