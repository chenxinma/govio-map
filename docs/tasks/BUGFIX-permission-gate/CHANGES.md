# CHANGES：取数/读数据确认门缺口修复

## 源码

| 文件 | 变更 |
|---|---|
| `server/extensions/govio-canvas.ts` | 新增 `OBSERVE_INFO_RE`；`shouldAskPermission` 从「load -o」扩展为「load -o ∨ info 样本行 ∨ 危险命令」；导出 `readsDataContent(cmd)`（返回 `load-output`/`info-sample`/null）与 `observeInfoTarget(cmd)`（提取 df 名）；`tool_call` 处理器接入条件放行短路（`isReadAccepted(infoDf)`）；`tool_result` 处理器在命令真正执行后 `acceptRead(readDf)` 记账（仅当 `decisionIdForExecution` 命中，即确认过） |
| `server/permission-manager.ts` | 新增 `readAccepted: Set<string>` 字段 + `acceptRead(dfName)` / `isReadAccepted(dfName)` 方法（有界，上限 `DECISION_INDEX_LIMIT`，随 `clearAll()` 失效） |
| `src/hooks/useChat.ts` | `pendingPermission` 单槽 → FIFO 队列（`pendingPermissionQueueRef`）+ `pendingPermissionRef` 镜像；新增 `showNextPendingPermission()`（弹出下一个）与 `clearPendingPermissions()`（统一本地清理）；`respondPermission`/`acceptAllPermission` 用 ref 取卡、处理完弹队列；Accept All 清空队列；`abort`/`clearSession`/`openSession` 改用 `clearPendingPermissions()`，不再 `setPendingPermission(null)` 单点丢卡 |

## 测试

| 文件 | 变更 |
|---|---|
| `scripts/verify-permission-audit.ts` | 导入 `readsDataContent`、`observeInfoTarget`；第 8 节扩为「load -o + info 样本行」触发条件断言（+10 项：info --rows 5/10/省略/0/=0/abc、readsDataContent 分类、observeInfoTarget 提取）；新增第 9 节「条件放行 + 确认队列」（+9 项：同 df 首次确认/执行后登记豁免/同 df 免确认/不同 df 仍确认/被拒命令被阻断且不产生豁免/acceptRead 登记/clearAll 清空豁免/-o 不受 info 豁免）。verify:audit 97 → 116 |

## 文档

| 文件 | 变更 |
|---|---|
| `docs/specs/10-observe-load-permission.md` | 标题/背景改为「取数确认门」；触发条件扩为 A(load -o) + B(info 样本行) 两类，标注 `--rows 0`/`-oxxx` 缺口；新增「条件放行」「确认队列」两节；补充 `readsDataContent`/`observeInfoTarget` 实现说明 |
| `docs/tasks/BUGFIX-permission-gate/{design,CHANGES,verification}.md` | 本任务三件套 |

## 未改动（有意）

- `server/permission-audit.ts`：审计留痕与命令匹配解耦，新闸门自动获得请求/决策记录，无需改
- `server/ws-handler.ts`：`clear`/`session_open`/`abort` 已有 `clearAll()`/`denyPending()` 拒绝挂起请求并留痕，P2 只需前端不再静默丢卡，协议零改动
- `.pi/APPEND_SYSTEM.md`：软约束文字已正确（「读取前先向用户确认」），本次是补机器闸门，无需改提示词
