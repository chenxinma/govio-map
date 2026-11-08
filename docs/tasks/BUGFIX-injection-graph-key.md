# BUGFIX-injection-graph-key：图谱注入表键拼接错误 + 空结果误判，口径冲突检测静默跳过

- **日期**：2026-11-08
- **发现**：产品演示视频脚本场景 3 实测——「错误口径」请求的 sqlQuery 节点未亮 ⚠ 黄色警示
- **证据**：`.govio/sessions/2026-11-08T03-09-10-797Z_01a1b921-*.jsonl.injection.jsonl` / `.canvas.json`

## 症状链

T2.3 口径冲突检测的前置是 `semanticRefs` 含 Metric（`server/extensions/govio-canvas.ts` message_end 钩子）。
该会话所有 sqlQuery 节点 `semanticRefs` 为空 → 检测整体静默跳过 → 无黄色警示。

注入留痕显示根因在上游：

```json
"tables": [{ "nodeId": "gov-73", "qualifiedName": "chocolate.chocolate.fact_sales" }],
"graphEntities": [],
"graphStatus": "degraded",
"graphError": "Command failed: govio-cli query -c MATCH (c:Col) WHERE c.full_table_name = \"chocolate.chocolate.chocolate.fact_sales\" ..."
```

## 根因（两个确定性 bug + 一个数据形态错位）

1. **graphTableKey 四段式表键**（`server/prompt-injection.ts`）：
   `graphTableKey` 无条件拼 `schema + "." + tableName`。历史 sourceTable 节点的 `tableName`
   存的就是限定名（`chocolate.chocolate.fact_sales`），拼出 **`chocolate.chocolate.chocolate.fact_sales`**
   四段式 → Col 查询恒空。且注释/测试假设「图谱 full_table_name 是 schema.table 两段式」**与实际不符**：
   ladybug 实测 `Col.full_table_name` = SQL 限定名形态（duckdb 三段式）。
2. **空结果被当失败**（`server/graph-query.ts`）：
   govio-cli 对无行查询打印 `Data not found.`（实测无 `[]` 行），`parseQueryRows` 找不到 `[` 行即抛错
   （docstring 假设「空结果会打印 []」有误）；旧版 govio-cli 对空结果还可能以非 0 退出码退出
   （留痕 `Command failed` 形态与该行为吻合）→ reject → `graphStatus=degraded`。
3. **指标表匹配段数错位**：`isReferencedMetric` 用 `tablesByMetric`（图谱 full_table_name）与
   `graphTableKey` 结果精确比对，2↔3 段（catalog 前缀）偏差即失联。

叠加效应：Col 查询恒空/报错 + 指标失联 → `graphEntities: []` → `semanticRefs` 空 →
T2.3 检测静默跳过。**且留痕条件要求 tables/entities 非空，纯问题命中场（场景 3 后两条消息）失败时完全无痕。**

## 修复

| 文件 | 改动 |
|---|---|
| `server/prompt-injection.ts` | `graphTableKey` 优先取 qualifiedName / 已带点号的 tableName，**禁止再拼 schema 前缀**；新增 `tableKeyCandidates` 双形候选（2↔3 段兼容），Col 查询改 `IN [双形]`；`isReferencedMetric` 后缀容错匹配 |
| `server/graph-query.ts` | `isEmptyResultOutput` 识别 `Data not found.`；`parseQueryRows` 空结果返回 `[]` 不抛错；`runGraphQuery` 错误分支遇空结果输出也返回 `[]`（旧版 CLI 非 0 退出码兜底） |
| `server/ws-handler.ts` | 注入留痕条件增加 `graphStatus === "degraded"`（失败必留痕，可诊断） |
| `scripts/verify-prompt-injection.ts` | 修正 2 处错误断言（graphTableKey/Col 查询的两段式假设）；fixture 改实测三段式；新增回归用例 5 项（四段式防护 / 空结果 4 断言 / 段数容错） |

## 验证

- `npm run verify:prompt-injection`：53/53（新增 6 断言全绿）
- `npm run build` / `npm run lint` / `npm run verify`：全绿零回归（集成测试 59/59）
- **真库冒烟**（修复前后对照，session 原始表事实形状）：
  - 修复前：`graphStatus=degraded`、`graphEntities: []`（会话留痕实证）
  - 修复后：`graphStatus=ok`、`entities=[Metric:m_sales_amount, ...4 Metric + 5 Dimension + 11 Col]`
  - 场景 3 无引用节点消息（「按渠道算营销 ROI…」）：命中 `m_marketing_roi`/`m_marketing_spend` →
    semanticRefs 含 Metric → 口径冲突检测可触发

## 遗留问题

1. 该会话四条查询全部 `Command failed`（含无字面量的指标查询）的确切成因未能复现
   （疑旧版 govio-cli 对空结果/图库瞬时状态的退出码行为；现版本实测 exit 0）。
   修复后空结果不再降级，且 degraded 必留痕，同类问题可从留痕直接诊断。
2. `govio_create_source_table` 工具描述仍写「full_table_name（schema.table）」，与 ladybug 实测
   三段式不符；本次实测环境的 `tableName` 传值也不统一（裸名/限定名混用）。工具描述与
   agent 传值约定建议另行校订（涉及 prompt 行为回归，不在本次 bugfix 范围）。
3. 各环境图谱 `full_table_name` 是否统一为 SQL 限定名形态未逐一验证；`tableKeyCandidates`
   双形 + 后缀容错已兜住 2↔3 段偏差，更极端的形态差异（如 mysql 裸名）待遇到再收敛。
