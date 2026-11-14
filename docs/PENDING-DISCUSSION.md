# 待讨论事项（Pending Discussion）

> 尚未列入 `docs/task-plan.json` 任务清单的议题记录。讨论定调后再决定是否立项（并补 scope/acceptance）。

## PD-1 指标在画布的体现

- **记录**：2026-11-06，T2.2 验收后用户提出
- **背景**：T2.2（PR #23）已让 SQL 节点携带 `semanticRefs`（引用的图谱指标/维度/字段标准），血缘边可区分数据/语义血缘。但指标**不显示在画布上**——只存在于节点属性里，且 SQL 节点卡片 UI 尚未渲染 refs 列表（T2.2 design.md 遗留问题 3）。用户问「指标也能显示在画布上？」由此引出本议题。
- **诉求**：口径/指标在画布上可见（现状只能查节点数据，紫虚线也不标注共用的指标名）。
- **候选方案（三档，成本递增）**：
  1. **SQL 节点卡片渲染 refs 徽标**（最小）：节点上显示「口径：销售额、订单数」徽标；与 T2.3 口径警示 UI 合并做的自然候选（T2.2 遗留 3）
  2. **语义边悬停显示共用指标**：紫虚线 tooltip「口径沿袭：销售额」（涉及 ReactFlow edge label/tooltip）
  3. **新增"指标/口径节点"类型**（最大）：引用的指标/标准作为节点上画布，SQL ─ ╌▶ 指标节点连语义边，口径溯源成为可见的图；涉及节点类型、dagre 布局、导出三处扩展，属新功能需立项走 PR
- **状态**：✅ **已裁决并立项**（2026-11-14 用户选定**方案 1**）→ `docs/task-plan.json → crossCutting[X18]`（SQL 节点卡片渲染 semanticRefs 徐标，status=pending，含完整 scope/acceptance）。方案 2（语义边悬停显示共用指标）与方案 3（新增指标/口径节点类型）**不做**；若将来要升级到方案 3 须单独立项（涉及节点类型、dagre/方案B 布局、导出三处扩展）。
- **待定**：无（原「做到哪一档」已定：方案 1；与 T2.3 警示的视觉分工已写进 X18 scope：警示优先于徐标，`caliberNodeAppearance` 仍是警示配色唯一来源）。按用户指令「先不要做实际开发」，X18 仅完成立项定稿，**暂不派发**。

## PD-2 口径检测的别名感知与存疑噪声

- **记录**：2026-11-08，演示视频场景 3 实测（BUGFIX-caliber-has-star 修复后）用户提出
- **背景**：P0 修复 `has_star` 误判乘法后，`SUM(price*boxes) AS sales_amount` 这类「用别的算法冒充指标」已能判 conflict（黄灯亮）。但实测暴露两个残余问题：
  1. **别名改名可绕过**：agent 把计算列改名 `calc_sales_amount`、同时保留 `SUM(amount) AS stored_amount` 做对照时，CLI 判 `unknown`——因为 `_compare_columns` 只扫「SQL 里出现过哪些列」，`amount` 出现过就算计量列已用，**不比对「别名=指标名」的那个表达式到底用了什么列**
  2. **存疑噪声**：`dimension_ref` 列（product_id / channel_id / salesperson）未引用一律产出 `column` 存疑项，导致连「正确口径」的 SQL（`SUM(amount) AS sales_amount`）也是 `unknown` 而非 `consistent`；状态信号被稀释
- **诉求**：口径偏差要按「输出列语义」判定，而不是按「列名是否出现在 SQL 任意位置」判定；同时减少无关存疑项。
- **候选方案**：
  1. **别名感知比对（核心）**：解析 SELECT 列表 `expr AS alias`，当 alias 命中指标 code/name 或常见指标列名时，比对该 expr 的聚合签名与引用列（vs 指标 formula + REFERS_COLUMN measure）；不一致 → conflict
  2. **指标按输出列对齐 SPJ 语义**：为指标定义补「输出列名」声明（元数据侧），使比对有明确钩子
  3. **存疑降噪**：dimension_ref 缺失默认不计入 differences（或仅在 role=measure 时产出），让 `consistent` 可达
  4. **unknown 可见性**：UI 完全不显示 unknown（`src/utils/caliber.ts` 设计取舍）——是否给一个更轻的提示（如节点角标小圆点）待定
- **状态**：✅ **已定调并立项**（2026-11-14 用户裁决：「以**计算表达式**和**维度限定条件**作为实质判断依据」）→ `docs/task-plan.json → crossCutting[X19]`（口径判定升级：维度限定条件的实质比对，status=pending，跳仓 govio + govio-map）。取证补充：**计算表达式部分已落地**（govio `src/govio/metadata/caliber.py` 的 `_canonical_expr`(406) + `_compare_aggregation`(424) 已按归一后的聚合参数表达式比对，即上文方案 1；`_compare_columns`(597) 已改 measure-first 即方案 2），**缺口在维度限定**：`_compare_filter`(522) 目前只做「剔除类词是否出现在 WHERE 段」的子串包含 + 否定算子检查，且一律只给 unknown 不判 conflict，未与指标侧维度声明（`statistical_scope` / `DIMENSION_USED` / `REFERS_COLUMN role=dimension`）做结构化比对。
- **落地状态（2026-11-14 收尾）**：✅ **已定调并落地**——维度限定条件升级为**结构化实质比对**（SQL 侧「列 / 算子 / 值集合」三元组 vs 指标侧维度声明，产出 `consistent`/`conflict`/`unknown` 三态，判定纪律仍是「宁可 unknown 不误报」），随 govio **PR #24** 合并（交付 commit `c621de9`，merge `a92a291`）。CLI 输出契约未变（差异条目仍 `aspect/expected/found/detail`，维度差异复用 `filter`、时间粒度复用 `time_scope`），故 map 解析面与展示名**零改动**，消费侧 stub 断言 46 → 77；map 侧记录见 `docs/tasks/X19-caliber-dimension-substance/`。
- **待定（已全部回答，2026-11-14）**：① worker 在哪个仓起——按「govio 为主（W5a）+ map 跟随（W5b）」执行，两仓各自走 PR；② `_compare_time_scope` 同批核查结论——时间**窗口**逻辑维持现状（已是双侧归一到天数的实质比对，非子串包含），但补上了原来完全看不到的**时间粒度**比对（声明月度 vs SQL 取年度），aspect 仍为 `time_scope`；③ 指标元数据「输出列名」声明——**未新增字段**，维度判定只用既有 `Dimension.values_example` / `DIMENSION_USED.usage_type` / `REFERS_COLUMN.role`，「限定取值升级为显式字段」留在 govio 侧遗留问题（其 design.md §7-2）。

### PD-2 补充（2026-11-08，govio 0.7.2 sqlparse 接入后实测）

**前置事实**：govio `caliber.py` 已改用 sqlparse 分词（PR #15，0.7.2）。实测（8 档 SQL，runtime 0.7.2 已确认）：

| 档 | SQL 要点 | 判定 |
|---|---|---|
| s1 | `SUM(price*boxes) AS sales_amount` | conflict ✓ |
| s2/t2 | `ROUND(SUM(f.amount),2) AS revenue_amount`（**正确口径**） | **unknown**（dimension_ref 噪声） |
| s3/t3 | 不含 amount | conflict ✓ |
| s4 | `AVG(amount)` | conflict ✓ |
| t1 | `AVG(amount) AS revenue_calc` | conflict ✓ |
| t4 | `SUM(f.amount*(1-discount_pct/100)) AS revenue_calc` | **unknown ← 真缺口** |

**关键判断：别名不是主要瓶颈**

1. sqlparse 已能稳定取出逐项 `alias` + 该项的聚合与列（原型实测：`revenue_calc` → `SUM(price_per_box*boxes_shipped)`）。技术上「别名感知」完全可行。
2. 但「不同别名实质相同」**不能靠别名同义词词典**（revenue→sales、calc 修饰等启发式必然误报）；可靠做法是**表达式规范化比对**：

   | 表达式 | canonical | 与 `sum(amount)` 等价 |
   |---|---|---|
   | `ROUND(SUM(f.amount), 2)` | `sum(amount)` | ✅ |
   | `SUM(f.amount * (1 - f.discount_pct/100))` | `sum(amount*(1-discount_pct/100))` | ❌ |
   | `SUM(f.price_per_box*f.boxes_shipped)` | `sum(price_per_box*boxes_shipped)` | ❌ |

   （规范化 = 剥外层 ROUND/CAST 展示包装 → 去表限定 → 压空白 → 小写；已原型验证）
3. 真正的判定缺口是**聚合签名只比 `(func, distinct)`、不比参数表达式**（`_agg_signature`），所以 t4 这种「同一列被算术修饰」抓不到；sqlparse 已提供 arg 原文，补上即可。
4. 另一个缺口是**正确口径也判 unknown**（dimension_ref 列缺失一律产存疑项），令 `consistent` 对 chocolate 这类星型模型几乎不可达，状态信号被稀释。

**修订后候选方案（优先级）**

1. **聚合参数表达式比对**（推荐首要）：`_agg_signature` 增加 canonical(arg) 维度；指标 formula 为单列聚合时，SQL 同名聚合参数必须等价 → t4 关闭，且天然支持「不同写法实质相同」
2. **measure-first 判定**：measure 的期望聚合满足即忽略 dimension_ref 缺失去产项，让正确口径可达 `consistent`（消除噪声，比别名感知更影响体验）
3. **别名归一**（可选，用于展示而非判定）：画布节点标注「输出列 revenue_calc ↔ 指标 销售额」；词典+变体标记，保守输出 unknown

### PD-2 决策记录（2026-11-08）：方案 C 待讨论，演示期用干净措辞规避

**已落地（方案 1+2，govio `33080fd` / map `625260e`）**

1. `_canonical_expr` 表达式规范化：剥 `ROUND/CAST/::type` 展示包装、去表限定、压空白 → `ROUND(SUM(f.amount),2)` ≡ `sum(amount)`
2. `_compare_aggregation` 增加**聚合参数表达式**比对（旧实现只比 `(func, distinct)`，`SUM(amount*(1-discount))` 漏判）
3. `_compare_columns` 改 **measure-first**：`dimension_ref` 缺失不再产存疑项，正确口径可达 `consistent`
4. map 侧口径检测范围收紧为「问题点名的指标」（`caliberMetrics`），与 `semanticRefs`（含同表注入的参考指标）分离

**新发现的待讨论点：范围策略 C（别名归一 + 声称）**

- **问题**：当前按「问句出现指标名」判定检测范围。问句把指标当**计算成分**提及时会误报——「用每箱售价乘**出货箱数**，算一下销售额」会点名 2 个指标，导致正确口径的销售额 SQL 因「计量列 boxes_shipped 未引用」被判 conflict（实测）。
- **方案 C**：声称判定改为「表达式规范化匹配」∪「输出列别名归一匹配」：
  - 别名归一：去 `m_` 前缀、去 `calc_/computed_/derived_` 修饰、小写/下划线归一 → `sales_amount` ≈ `m_sales_amount`
  - 中英同义词典：`revenue/turnover/gmv → sales`、`qty/quantity → boxes` 等
  - 命中才检测；未命中 → `unknown`（存疑不亮灯），彻底消除「成分当诉求」误报
- **代价/风险**：同义词典是启发式，可能引入新误报（如 `net_roi` vs `m_marketing_roi`）；`calc_` 修饰剥离会改变「主动改名声明为替代算法」的语义判断
- **演示期规避**：改用干净措辞「用每箱单价乘发货数量，算一下 2023 年各国家的销售额。」（实测只点名 `m_sales_amount`），无需等 C 落地
- **状态**：⏸ 待讨论（C 不列入本期；演示按干净措辞录制）
- **补充（2026-11-14）**：用户定调 PD-2 主体（计算表达式 + 维度限定条件为实质判据）并立项 **X19** 时，**未对方案 C 表态** → C 仍挂起，且 X19 的 acceptance 已明写「未获授权前禁止引入别名同义词典/启发式改名归一」。若要推进 C，需单独裁决（其启发式与 X19 的「实质依据」纪律相冲突）。
