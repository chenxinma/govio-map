# T2.3 设计：口径冲突检测

> 任务书见同目录 `DISPATCH.md`；验收契约见 `docs/task-plan.json → T2.3.acceptance`
> （①冲突检测有 CLI 命令支撑 ②SQL 节点黄色警示态）。上游：T2.1 注入管线、
> T2.2 semanticRefs 归因（`docs/tasks/T2.2-semantic-lineage/design.md`）。

## 1. 目标

AI 生成 SQL 后与所引指标的图谱口径定义**事后校验**：不一致时在 SQL 节点上给黄色
警示与差异说明。比对逻辑下沉 govio-cli（ROADMAP KR3「比对逻辑下沉 govio-cli，
前端只展示」），map 侧只做调用编排与展示，**不解析 SQL**。

## 2. CLI 形态（acceptance ①）

**命名**：`govio-cli sql caliber`。任务书建议 `query caliber`，但 `query` 是平铺
单命令（`-c/--code`），非命令组；`sql` 组（「指标 SQL 组装」）是既有 argparse
子命令组且主题相邻，加 `caliber` 子命令不动既有命令组（范围纪律）。

- 输入：`--sql <文本>` 或 `--sql-file <路径>` + `-m/--metric <code|id>`（可重复）；
- 输出：stdout 单行 JSON `{"results": [{metric: {id?,code?,name?}, status, differences: [{aspect, expected, found, detail?}]}]}`
  （ensure_ascii 转义，免疫 Windows 控制台编码差异——沿用 query.py 内联 JSON 先例）；
- 退出码（沿用 `tests/test_exit_codes.py` 契约）：比对完成（含 conflict/unknown）0；
  坏输入（缺 SQL / 缺 --metric / 文件不存在）、配置/图后端错误 1，错误只落 stderr
  （stdout 必须纯 JSON）。**未知指标降级为单指标 `status:"unknown"` 不算命令失败**——
  多指标场景保住其余结果，map 侧也无需整体降级。

## 3. 比对内核（`src/govio/metadata/caliber.py`，纯 stdlib 可单测）

SQL 事实（`extract_sql_facts`）：聚合调用（函数 + DISTINCT + 参数）、引用列
（字面量等长掩蔽保偏移后提标识符）、WHERE 原文与谓词段、时间窗字面量
（`INTERVAL '7' DAY` 等）。文本级解析，不做完整 SQL 语法分析。

比对维度与判定（每项差异带「确定/存疑」，**宁可 unknown 不误报 conflict**）：

| aspect | 期望来源 | conflict（确定） | unknown（存疑） |
|---|---|---|---|
| aggregation | formula/定义中显式 `FUNC(col)` | 聚合签名（函数+DISTINCT）不匹配 | 仅中文语义提示（合计→SUM 等）不匹配 |
| filter | 定义中剔除类限定（「剔除 X」） | —（本维度不判 conflict） | WHERE 未见 X / 见 X 但无否定算子 |
| time_scope | 定义明确时间窗（「近30天」） | 双侧明确窗口不相交 | SQL 未见明确窗口（可能参数化） |
| column | REFERS_COLUMN(role) 列 + 聚合参数列 | measure 列缺失且 SQL 无 `*` | 非 measure 列缺失 / 含 `*` / 引用列不可解析 |

- 「统计周期内」等参数化表述**不产出时间窗期望**（SQL 自选窗口不是冲突）；
- `COUNT(*)` 计数对象无法确认 → measure 列缺失降级 unknown；
- formula 显式聚合参数列按 measure 计入期望（补 REFERS_COLUMN 缺失的派生指标）；
- 指标侧 status：任一确定差异 conflict → 仅存疑 unknown → 无差异 consistent。

图读取（`read_metric_caliber(graph, ref)`）：图对象由调用方注入（GraphFactory），
NetworkX 走 `.G`、Cypher 后端（FalkorDB/Ladybug）走 `.query`；按 code 或节点 ID
匹配（图节点均有 `id` 属性），REFERS_COLUMN 边取 `role`。

## 4. map 侧链路（acceptance ②）

```
message_end（server/extensions/govio-canvas.ts，async）
  ├─ 逐 SQL 块构造事件 → pushGovioNode（同步部分，行为不变）
  └─ semanticRefs 含 Metric → await runCaliberCheck(sql, metricRefs)
       └─ runGovioCliWithArgs(["sql","caliber","--sql",...,"--metric",...], 6000ms)
       └─ 成功 → 事件.caliberCheck = 结果（补挂已入队事件）
       └─ 失败/超时/非 JSON/形状非法 → 省略键、不阻断、不重试
```

- **补挂时序安全**：pi 的 message_end 扩展钩子先于 WS 广播被 await
  （`agent-session`："Emit to extensions first, then notify public listeners"），
  故补挂先于 flush 序列化完成，节点建出即带结果；同步 push 保留了既有
  verify 脚本（verify-semantic-lineage）驱动 handler 后立即 flush 的行为。
- **--metric 只送 Metric 实体**（Col/Dimension 不参比对），code 优先于 id。
- `caliberCheck` 形态 `{status, differences}`（differences 带 metricCode/metricName
  归属）：CLI 逐指标 results 在 `parseCaliberOutput` 扁平化——UI 只需一张差异清单，
  单一事实源（逐指标明细在 CLI 输出里可查，不重复落盘）。
- 依赖注入：`govioCanvasExtension(pi, deps?)`，缺省真实 `runGovioCliWithArgs`
  （生产零配置）；verify 脚本注入 stub 保持 hermetic（verify-semantic-lineage
  注入恒失败 stub——其断言不变，仅不真调 CLI）。

## 5. UI（SQLQueryNode）

唯一取值来源 `src/utils/caliber.ts`（T2.2 `src/utils/lineage.ts` 同款模式）：

- `conflict`：节点描边 + 标题栏徽标（AlertTriangle + 「口径冲突」）用 warning token
  `#F59B23`（green-deck semantic warning）；点徽标展开差异清单（aspect 展示名 +
  metricCode + 期望/实际/说明）；
- `consistent`：不打扰（零视觉变化）；
- `unknown`：**不显示**（取舍见 §7 遗留 4）；
- 旧节点（无 caliberCheck）：`caliberNodeAppearance(undefined)` → 不显示。

## 6. 验证（`scripts/verify-caliber-conflict.ts`，43 项断言）

1. 调用参数：SQL 全文单参数（空格/换行/引号不拆）、`--metric` 按序重复、短超时；
2. 结果解析：汇总 status 优先级（conflict > unknown > consistent）、differences
   扁平化归属与省略键、非 JSON/形状非法 → undefined；
3. 降级：成功透传 / 拒绝 / 非 JSON / 空输入 → undefined，不抛错不重试；
4. message_end 钩子（stub pi + stub CLI）：Metric 才调 CLI（code 优先 id、Col 不送）、
   事件带结果、失败/非 JSON/无 Metric/无归因省略键、多代码块逐个挂载；
5. 透传：事件 JSON → createGovioNode → node.data；旧事件不建键；
6. 往返：saveCanvas → loadCanvas → hydrateSession 深度相等；
7. UI 状态映射：conflict 亮警示、consistent/unknown/旧节点不显示、色值与 aspect 表。

## 7. 遗留问题（新发现，不在本任务实施）

1. **「一键采纳图谱口径」改写 SQL**：ROADMAP KR3 措辞含「用户可选择采纳图谱口径」，
   本期只警示 + 差异说明（任务书范围纪律）；改写需 LLM 二次生成 + 回写节点，另立任务。
2. **比对是文本级启发式**：无 SQL 语法树（sqlglot 等），CTE/子查询内的过滤、
   表达式改写（`status=2` 代替「已支付」）无法穿透——按纪律降级 unknown，不误报。
   若误报/漏报成为实际痛点，CLI 侧引入 SQL parser 与值域映射（状态码↔语义值）。
3. **派生指标公式不解引用**：`formula: m_sales / m_boxes` 形态（指标码引用）不递归
   展开 DERIVED_FROM，聚合维度对派生指标基本跳过；待需要时沿 DERIVED_FROM 链展开。
4. **unknown 不展示的取舍**：不显示避免「警示疲劳」（比对不确定是常态），代价是
   「未校验」不可见；数据已在 node.data.caliberCheck，若后续需要可加轻提示开关。
5. **补挂窗口的极端竞态**：message_end 补挂前若另一触发点（parquet-api 执行 SQL）
   flush 了队列，节点可能先以无 caliberCheck 到达——概率极低，后果仅是缺警示，
   现状接受；如需严格可把 caliber 提前到注入期（拿不到 SQL）或改事件重发。
6. **semanticRefs 跨 SQL 块共享**：一消息多代码块共用 message 级指标列表（T2.2
   既有语义），各块独立比对；若块级归因出现需求，等 X2 轮次边界协议统一收口。
