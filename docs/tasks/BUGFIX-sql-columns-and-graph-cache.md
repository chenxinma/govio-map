# BUGFIX-sql-columns-and-graph-cache：SQL 输出列名被逗号切碎 + 图谱注入冷启动超时

- **日期**：2026-11-08
- **现象**：① sqlQuery 节点 outputColumns 出现 `amount)`、`0)`、`marketing_spend)` 等碎片；② 会话 `2026-11-08T03-09-10-797Z_01a1b921-*` 仍未获预期效果（口径检测不亮）

## ① 输出列名被逗号切碎

**根因**：`extractSelectColumns`（`server/extensions/govio-canvas.ts`）按 `,` 硬切 SELECT 段，
函数内逗号（`ROUND(x, 0)`、`ROUND((a-b)/c, 4)`）把表达式切碎，尾部碎片被当作列名：

```
实测 gov-105: ["channel_name","order_year","marketing_spend)","marketing_spend","amount)",
                "sales_amount","marketing_spend)","0)","roi_ratio","order_id)","0)",...]
```

**修复**：
- `splitTopLevelCommas`：按括号深度切分 SELECT 项（函数内逗号不切）
- `columnNameOf`：显式 `AS alias`（含引号/反引号/方括号）→ 隐式别名（前段以 `)` 结尾）→ 裸列（可带限定）
- 无别名的表达式不产名字（返回 null，交由调用方回退 `tableName.*`），不再产垃圾名

**验证**：`tests/integration/select-columns.test.ts` 6 用例（含 gov-105 真实坏例，断言无 `)` 结尾列名）

## ② 图谱注入冷启动超时（口径检测静默跳过）

**证据**（新诊断格式已生效）：留痕 08:07/08:11/08:12 三条均为

```
metrics: ... | killed=true | signal=SIGTERM ;; metricTables: ... killed=true ;; metricDims: ...
```

即 **12s 超时被杀**，三条并发全部超时 → `graphEntities` 空 → `semanticRefs` 空 → 口径检测跳过。
实测单条 govio-cli 冷启动 2.5~4.3s（Python 启动 + 图库连接），四并发在 agent 负载下即撞阈值；
且 CLI 无 `--output` 参数，并发调用会撞同一 `.govio/output-<ts>.json` 文件名。

**修复（结构性）**：
- `graph-query.ts` 新增结果缓存（TTL 10min，按 Cypher 文本）+ 同 Cypher in-flight 去重
- 过期缓存 **stale-while-revalidate**：先返回旧值后台刷新，绝不阻塞 prompt
- `prewarmGraphCache` / `prewarmInjectionGraphCache`：backend 启动后台预热三条指标查询
  （`server/backend.ts` 调用，不阻塞启动、失败静默）
- 失败仍重试一次；`describeExecError` 保留退出码/信号/stderr

**实测**：冷启动 4330ms → 命中缓存 0ms；预热后首轮即 0ms。

## 验证

- `npm run build` / `npm run lint` 全绿
- `npm run verify` 全绿：manifest 92 / rerun 71 / audit 119 / export 126 / source-table 39 /
  semantic-lineage 45 / caliber-conflict 46 / cwd 13 / prompt-injection 58 / 集成 65
- 新增 `tests/integration/select-columns.test.ts`（6 用例）

## 遗留问题

1. **旧节点不自愈**：画布 sidecar 里已固化的 `marketing_spend)` / `0)` 等列名不会自动修正，
   需重新生成节点或清画布重录。
2. 缓存 TTL 10min 内元数据导入不自动失效（现仅测试可 `clearGraphQueryCache`）；
   若需「导入后即时生效」应在导入流程调用失效。
3. 并发 `govio-cli` 的输出文件同名风险仍在 CLI 侧（无 `--output` 参数）；缓存已大幅降低频次，
   根治需 govio-cli 支持唯一输出路径。

---

## ③ 补充：流式排队导致口径引用被提前清空（2026-11-08 复测发现）

**现象**：新会话 `2026-11-08T08-34-00-306Z_01a1ba4b-*` 注入已 `graphStatus=ok`（缓存修复生效，
CTX 里能看到 `m_sales_amount` 等实体），但所有 sqlQuery 节点 `semanticRefs` 为空、
`caliberCheck` 缺失 → 黄灯仍不出现。

**根因**：`ws-handler` 的 prompt 派发链在 `.finally` 里 `clearSessionSemanticRefs`。而
**流式中发送的消息走 `session.steer(prompt)` 排队，steer/prompt 会「入队后立即 resolve」**，
`finally` 在 message_end 之前就执行了 → 引用被清空 → 延后触发的 `message_end` 取不到口径引用。
非流式路径（prompt 在 agent_end 后 resolve）不受影响——所以单测/脚本全绿、真实会话恒失败。

**修复**（`server/ws-handler.ts`）：
- prompt 派发的 `finally` **只清 referencedNodes，不再清 semanticRefs/caliberMetrics**
- 改为「下一轮 makePrompt 覆盖」+「不注入的 `steer`/`followUp` 分支显式清理」（避免错归因）

**回归断言**（`tests/integration/ws-handler.test.ts`）：模拟 `isStreaming=true`，
prompt 走 steer 排队后断言 `getSessionSemanticRefs` / `getSessionCaliberMetrics` 仍非空。

## ④ 补充：steer 也属于本轮运行，不得清空口径引用（2026-11-08 二次复测）

**现象**：会话 `2026-11-08T08-53-51-741Z_01a1ba5d-*`：注入 `ok`（`m_sales_amount` 已注入）、
outputColumns 已干净（`["country","sales_amount","boxes_shipped"]`），但 sqlQuery 节点仍无
`semanticRefs`/`caliberCheck`。

**证据链**：
- 08:55:26 用户 prompt「用每箱单价乘发货数量…销售额。」→ 注入 ok、点名 `m_sales_amount`
- 08:56:01 一条 **steer** 消息 `sales_2023_by_country_price_x_boxes sql`
- 08:56:04~06 才生成 sqlQuery 节点（gov-132）→ 该 SQL 属于 steer 之后的同一次运行

**根因**：③ 的修复把「清理」挪到了 steer/followUp 分支，但 steer 是**同一次 agent 运行**的
补充指令，其后续产出仍应归因到本轮注入上下文；清了就丢口径。

**修复**：生命周期统一到 `agent_end`（所有 message_end 已派发完）——
`ws-handler` 的 `agent_end` 分支 `clearSessionSemanticRefs`；prompt finally、steer、followUp
一律不清（steer/followUp 不再清）。

**回归断言**（`tests/integration/ws-handler.test.ts`）：
- `isStreaming=true` 走 steer 后引用仍保留
- steer 之后仍保留；派发 `agent_end` 后才清空（下一轮未注入不继承旧口径）
