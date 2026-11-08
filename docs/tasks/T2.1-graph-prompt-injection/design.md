# T2.1 设计：图谱定义自动注入 Prompt

> 任务书见同目录 `DISPATCH.md`；验收契约见 `docs/task-plan.json → T2.1.acceptance`。
> 动机案例：`docs/tasks/BUGFIX-load-parse.md`（agent 盲猜表名三次试错）。

## 1. 目标

在 prompt 组装时**自动注入**语义上下文，替代 agent 主动查图谱：

1. 被引用 sourceTable 节点的 `qualifiedName/datasourceType/datasource/schema`（T2.0 产物，
   SQL 表引用一律以 `qualifiedName` 为准，禁止猜测——`docs/specs/11-datasource-schema-conventions.md`）；
2. 图谱中与「问题实体 / 引用表」相关的指标定义（Metric）、字段标准（Col）、枚举码值
   （Dimension.values_example），来源 `govio-cli query`（Cypher 属性名以
   `.agents/skills/govio/assets/schema.md` 为准，已实测 ladybug 后端）。

注入内容随消息留痕（记录注入的节点与图谱实体 ID 列表），保证口径可追溯。

## 2. 注入形态与时序

### 2.1 prompt 布局

```
REF:[{"dim_product":"{...}"}]        ← 原有 envelope，逐字节不变（session-history 解析依赖）
CTX:{"tables":[...],"graphEntities":[...],"graphStatus":"ok","instructions":"..."}
<用户内容>
```

- `CTX:` 为**单行 JSON**：可断言、可解析、可整行剥离；
- `instructions` 内含表引用纪律（「SQL 表引用必须使用 tables[].qualifiedName 原文，禁止猜测或试错表名」）
  与实体类型口径说明；X5 的提示词规则与此一致；
- 无可注入内容（无表事实且无图谱实体）时 **不出现 CTX 行**，prompt 与现状逐字一致（acceptance 4）。

### 2.2 时序（对「会话启动/引用节点变更」的落地解释）

注入在**每条 prompt 组装时**无状态求值（`makePrompt`），因此：
- 会话启动后的首条消息即带注入（问题实体命中的图谱上下文）；
- 引用节点变更后的消息自动携带新引用表的事实；
- 注入始终反映当下节点与图谱状态，无需会话级失效逻辑。
`steer`/`followUp` 不走注入（仅 `prompt` 路径组装 REF，行为不变）。

### 2.3 注入管线（`server/prompt-injection.ts`）

```
ws-handler makePrompt(msg, session)
  ├─ resolveTableFacts(referencedNodes, loadCanvas(session).nodes)   ①表事实
  ├─ buildInjectionContext({content, refs, canvasNodes, runQuery})   ②图谱实体
  │    └─ runGraphQuery = server/graph-query.ts（govio-cli query -c，参数数组调用）
  ├─ composePrompt(msg, ctx) → REF + CTX + content（纯函数，可断言）
  └─ recordInjectionTrace(sessionFile, buildTraceEntry(...))        ③留痕
```

## 3. 表事实来源（取数纪律：缺啥省啥，禁止猜测）

字段优先级：**消息内 `ref.data` JSON**（前端 `addReference` 序列化）> **canvas sidecar 节点数据**
（`loadCanvas()`，含 T2.0 全套标注字段）> 省略。

- 历史命名注意：`addReference` 现行序列化为 `{full_table_name: <表名>, fields}`，
  该 `full_table_name` 实为表名；sidecar 的 `tableName` 才是规范来源，解析链两者都收。
- 认不出 `tableName` 的引用直接跳过，不注入半截事实。
- 仅 `type === "sourceTable"` 的引用产事实（sqlQuery/dataFrame 的 ref.data 是 SQL/dfName）。

**为什么不在前端 `addReference` 里补字段**：§5 范围纪律要求 WS 消息形态一律不动（X2 并行做协议
类型化）；sidecar 查找是纯服务端方案。代价与缓解见「遗留问题 1」。

## 4. 图谱实体选择（`govio-cli query`，4 条 Cypher 并行）

| 查询 | 用途 | schema.md 溯源 |
|---|---|---|
| `MATCH (m:Metric) RETURN ... LIMIT 300` | 指标定义（business_definition/formula/unit/type） | Metric 节点属性 |
| `MATCH (m:Metric)-[:USES_TABLE]->(t:PhysicalTable) ...` | 引用表 → 指标归属 | `(:Metric)-[:USES_TABLE]->(:PhysicalTable)` |
| `MATCH (m:Metric)-[r:DIMENSION_USED]->(d:Dimension) ...` | 指标维度 + `values_example`（枚举码值） | `(:Metric)-[:DIMENSION_USED]->(:Dimension)` |
| `MATCH (c:Col) WHERE c.full_table_name = "<schema.table>" ...` | 引用表字段标准（data_type/precision/scale） | Col 属性、PhysicalTable.full_table_name 两段式 |

选择规则：`引用表命中（USES_TABLE 的 full_table_name = schema.table）∪ 问题实体命中
（问题文本包含指标/维度的 name 或 code，长度≥2）`；维度再并上选中指标的维度。上限
指标 15 / 维度 15 / 每表字段 40，防 prompt 膨胀。Cypher 纪律：以 MATCH 开头、必带 LIMIT 300、
属性值双引号（govio-query skill 规则）。

## 5. 注入留痕（acceptance 2）

- `<session>.injection.jsonl` sidecar（与 `<session>.audit.jsonl` 同款模式）：
  **append-only、写失败只告警、坏行跳过、随 `deleteSession()` 一并删除**；
- 每条记录：`{v, at, sessionId, sessionFile, contentPreview, tables[{nodeId,label,qualifiedName,datasourceType}],
  graphEntities[{entityType,id,code}], graphStatus, graphError?}`——「被注入节点与图谱实体 ID 列表」齐备；
- 注入正文本身随消息写入会话 transcript（jsonl 原文含 REF/CTX），双通道可质证；
- 上屏时 `session-history.parseRefPrefix` 剥离 REF+CTX 行（留痕不上屏，UI 不被 JSON 噪声淹没）。

## 6. 降级矩阵（acceptance 4：永不阻断会话）

| 场景 | 表事实 | 图谱实体 | CTX 行 | graphStatus |
|---|---|---|---|---|
| 全部正常 | 注入 | 注入 | 出现 | ok |
| 图谱不可达（CLI 缺失/超时/Binder 错） | 注入 | 无 | 出现（仅 tables） | degraded + graphError |
| 单查询失败 | 注入 | 其余查询照常 | 出现 | degraded + graphError |
| 图谱无相关实体 | 注入 | 空 | 出现（仅 tables） | ok |
| 图谱空 + 无引用表 | 无 | 空 | **不出现（现状行为）** | — |

`buildInjectionContext` 永不 throw（Promise.allSettled + 全量 try/catch）；留痕写失败只告警。

## 7. 口径命中率测量（acceptance 3，`scripts/verify-prompt-injection.ts`）

抽样会话 jsonl，逐轮对比「生成 SQL 的表引用」与「注入的 qualifiedName」：

- SQL 来源：bash 工具命令的 `--sql "..."` 与工具参数 `sql` 字段；
- 表引用抽取：剥离字符串字面量后取 `FROM/JOIN` 后的限定名（含反引号/双引号标识符）；
- 分类：**hit** = 表引用与注入 qualifiedName 逐字一致（ci）；**miss** = 指向注入表却没用限定名
  （裸名/两段式，即 BUGFIX-load-parse 的试错形态）；其余（如 `--memory` CTE 名）**unrelated**，
  排除出分母；
- 命中率 = hits / (hits+misses)；fixture 会话走真实解析路径断言（2 hit / 1 miss / 1 unrelated）；
- 附带对 `.govio/sessions` 真实会话的抽样输出（信息性，不参与 verify 判定）。

## 8. 取舍记录

- **CTX 单行 JSON vs 可读多行块**：选单行——可 `^CTX:` 整行解析/剥离、可 JSON.parse 断言；
  LLM 对 JSON 载荷理解无障碍，`instructions` 字段补足指令语义。
- **注入进用户消息 vs 系统提示**：选随消息——「注入内容随消息留痕」直接由 transcript 承担，
  且 session-history 的 REF 前缀机制已有先例；系统提示注入需动 agent 启动配置，超范围。
- **查询无缓存**：每次 prompt 4+ 条 Cypher 并行（实测 ladybug 本地库单查 <2s、超时 6s 兜底）；
  简单优先，缓存见遗留问题 3。
- **命中率脚本自包含**：解析逻辑内联在脚本（不导出到 server），避免为测量给运行时代码开口子。

## 9. 遗留问题（新发现，不在本任务实施）

1. **前端 `addReference` 的 ref.data 不含 T2.0 字段**（只有 `full_table_name/fields`），生产环境
   表事实依赖 canvas sidecar（canvas_save 防抖 1s，理论上有极小窗口取到旧标注）。建议后续把
   `qualifiedName/datasourceType` 并入 ref.data JSON（`src/store/canvas-store.ts`，需与 X2 协议
   类型化对齐后做）。
2. **CTX 注入清单未进交付报告/会话导出**：`src/commands/export-session.ts` 与 `verify:export`
   附录暂不展示注入节点/实体 ID 列表（留痕 sidecar 已可查）；如需上交付报告附录另立任务。
3. **图谱查询无 TTL 缓存**：高频对话每条 prompt 都查 4 条 Cypher；如成瓶颈可加进程内缓存
   （失效策略：meta 导入后重启即自然失效）。
4. **问题实体匹配是子串包含**（name/code ≥2 字符），会漏同义词（「销售额」≠「账单收入」）；
   govio-query skill 的「歧义候选」机制（列候选让用户确认）未接入自动注入。
5. **Standard 节点在 schema.md 中无任何边**，「字段标准」以 Col（data_type/precision/scale）落地；
   图谱给 Standard 挂边（如 `(:Col)-[:COMPLIES_WITH]->(:Standard)`，Ladybug 参考文档提到过该边）
   后可补 Standard 注入。
6. **测量脚本抽不到间接 SQL**：`--sql "$(cat x.sql)"` 形态只抽到占位符，不计入样本（抽样覆盖面问题，
   不影响已抽样本的正确性）。
7. **steer/followUp 不注入**：仅 prompt 路径组装 REF/CTX；若用户在流式中途追问也需要上下文，另议。
