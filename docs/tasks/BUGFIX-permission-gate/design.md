# BUGFIX：取数/读数据确认门缺口（P1 读数据无闸门 + P2 确认卡静默悬死）

> 状态：实现完成，`npm run build` / `npm run lint` / `npm run verify` 全绿（verify:audit 97 → 116）
> 关联：`docs/specs/10-observe-load-permission.md`（已同步）、`.pi/APPEND_SYSTEM.md`「非必要不读取数据内容」

## 1. 现象与动机

用户报告：查询「销量top3的产品」（会话 `2026-10-31T16-22-57-713Z_01a192c5...`）时**未触发权限确认**。

逐层取证后确认这不是确认门代码 bug，而是**命令形态不在设计覆盖范围内**，但暴露了两个真实缺口：

### P1 · 读数据内容完全没有机器闸门（本次实证踩到）

该会话 agent（deepseek-v4-flash）的执行序列：
1. `govio-cli observe load --name df_top3_products ... LIMIT 3`（**不带 `-o`**）→ 不触发确认门（按设计）
2. `govio-cli observe info --name df_top3_products --rows 5` → 把 **sample 数据行拉进上下文**
3. `govio_show_chart` 内嵌数据值、答复贴出明细

而 `.pi/APPEND_SYSTEM.md`「非必要不读取数据内容」明确写「不要主动用 `observe info --name` 拉取样本数据行……读取前先向用户确认」，`govio-observe/SKILL.md` 亦然——但这些只是**给模型看的软约束**，本次被完全绕过。等价于：任何数据内容的读取，换个命令形态就不经确认、零审计。

### P2 · 确认卡静默悬死

`useChat` 的 `pendingPermission` 是**单槽**（`setPendingPermission` 后来者覆盖），且 `abort`/`openSession`/`clearSession` 只 `setPendingPermission(null)` 丢弃本地卡片。并发多请求会丢弃旧卡；切换会话时卡片消失但服务端 Promise 永久挂起——用户体感与「没触发确认」完全相同。

## 2. 修复

### P1：把「读数据内容」纳入确认门 + 按 df 条件放行（用户选定方案 B）

`server/extensions/govio-canvas.ts`：
- 新增 `OBSERVE_INFO_RE`，`shouldAskPermission` = `isDangerousCommand` ∨ `load -o` ∨ `info 样本行`
- 导出 `readsDataContent(cmd) -> "load-output" | "info-sample" | null`（判定 + 分类）与 `observeInfoTarget(cmd) -> df名 | null`
- `info` 样本行判定：`observe info` 子命令且 `--rows` 值 > 0；省略 `--rows`（CLI 默认 10 行）也触发；`--rows 0` / `--rows=0` 仅结构不触发；非法数值保守当作读数据

**条件放行（方案 B，避免 EDA/chart 高频弹卡）**：同一 DataFrame 的数据内容读取在本会话内确认过一次（allow / Accept All）后，后续同 df 样本读取免确认。
- `PermissionManager` 新增 `acceptRead(dfName)` / `isReadAccepted(dfName)`（有界集合，随 `clearAll()` 失效）
- 豁免在 `tool_result`（命令真正执行）后由 `acceptRead` 记账——被拒绝/被修改的命令不产生豁免
- `tool_call` 里 `isReadAccepted(infoDf)` 短路后续同类读取
- 豁免仅限 `info-sample`：`load -o` 导出、危险命令、不同 df 仍逐次确认

审计留痕无需改：`requestPermission` 内部留痕与命令匹配解耦（T1.3 设计），新闸门自动获得请求/决策记录。

### P2：确认队列 + 清理路径不再静默丢卡

`src/hooks/useChat.ts`：
- `pendingPermission` 单槽 → **FIFO 队列**（`pendingPermissionQueueRef`）+ `pendingPermissionRef` 镜像（避免闭包旧值），`showNextPendingPermission()` 逐个弹卡
- 新增 `clearPendingPermissions()` 统一清理；`abort`/`clearSession`/`openSession` 改用它，**只清本地队列**——后端 `clearAll()`/`denyPending()` 已拒绝所有挂起请求并留痕（`reset`/`abort` 来源），前端不重复发 deny（避免同一请求双记决策）
- `respondPermission`/`acceptAllPermission` 用 ref 取当前卡、处理完弹出队列下一个；Accept All 清空队列（放行模式下剩余请求后端自动允许，无需逐个弹卡）

## 3. 取舍

1. **条件放行按 df 而非按命令**：同一 df 重复 `observe info --rows N` 是同一份数据的重复暴露，确认一次即可；不同 df 是新数据集，须重新确认。代价：用户对「某 df 第二次读取不再弹卡」可能意外——已在 specs/10 与本文明示。
2. **豁免记账在 tool_result（执行后）而非 tool_call（确认时）**：被拒绝/被修改的命令不应产生豁免（用户没同意读取）。代价：豁免生效晚一个事件，无实际影响（同 df 下一次读取才用到）。
3. **清理路径不重复发 deny**：后端 `clearAll`/`denyPending` 是拒绝的唯一事实源（已留痕 `reset`/`abort`）；前端只丢本地队列。若前端也发 deny 会给同一请求写两条决策记录（一条 `reset`、一条 `user`），污染审计。
4. **`--rows abc` 保守当作读数据**：无法解析为数字时按「可能读数据」处理，宁可多确认不漏。

## 4. 遗留问题

1. **`-oxxx`（短选项紧跟值）仍不触发**：既有已知缺口（specs/10 已标注），本任务未扩大范围。
2. **`compare`/`explore`/chart 取数仍不设门**：按既有产品决策（compare 的数据消费属任务必需）；若后续要收紧，`readsDataContent` 可扩展子命令枚举。
3. **条件放行的 df 名依赖命令文本解析**（`observeInfoTarget`）：命令被 jq/管道改写导致取不到名时不豁免（保守逐次确认），不影响正确性。
4. **P2 队列仅覆盖 WS 推送路径**：若未来有多个 WS 客户端并发，`permissionManager.onRequest` 的广播语义需重新审视（当前单客户端架构无此问题）。
5. **前端队列无持久化**：刷新页面丢队列——但后端 Promise 会超时（5 分钟）自动 deny 留痕，不会永久悬死。
