# 产品演示视频脚本 — Govio Map 0.7.0 × Chocolate 销售数据

> 目标：4 分钟产品演示，主题 **「结果可信、口径可溯」**（0.7.0 发布主题），
> 展示「自然语言 → 元数据 → 数据 → 洞察 → 血缘 → 交付」完整闭环，
> **重点突出 0.6.0 之后的新特性（0.6.1 + 0.7.0）**。
> 全程围绕 chocolate 元数据与 `chocolate.db`（DuckDB）真实数据演示，不使用虚构数据。
> 录制形式：屏幕录制（画布 + 对话面板）+ 旁白 + 字幕。

---

## 素材事实（演示前核对，勿凭记忆）

| 项目 | 事实 |
|---|---|
| 数据源 | `chocolate`，DuckDB 文件 `chocolate.db`，表全限定名三段式 `chocolate.chocolate.<table>` |
| 表 | `fact_sales`（200,000 行，11 列）、`dim_product`（12 行）、`dim_country`（5 行）、`dim_channel`（3 行），星型模型，3 条多对一外键 |
| 时间范围 | 2022-01-01 ~ 2023-12-31（24 个月），总额 ≈ 1.026 亿元，25 名销售员 |
| 维度取值 | 国家：Australia / Brazil / Germany / India / Japan；渠道：Online / Retail / Wholesale；产品：70% Dark Bar、Truffle Gift Box 等 12 款 |
| 指标（元数据） | m_sales_amount 销售额（= sum(amount)，按 order_date 统计）、m_boxes_shipped 出货箱数、m_marketing_spend 营销投入、m_order_count 订单数、m_avg_box_price 平均每箱售价、m_marketing_roi 营销 ROI |
| 可复用产物 | EDA 报告 `docs/govio/eda-reports/2026-07-04-eda-chocolate-sales.md`；实录产出 DataFrame：`df_country_sales_2022_2023`（5×3）、`df_hnmnpa`（25×3）、`df_channel_marketing_roi`（3×5）、`df_country_sales_2023_price_x_boxes`（5×2） |
| 数据质量彩蛋 | `boxes_shipped` 最小值 -1,642（负数出货量），EDA 已发现，可作数据质量演示点 |
| 版本要求 | govio-cli ≥ 0.7.1（口径冲突检测依赖 `sql caliber`）；录制机已装 uv，启动自动校验/升级 |

---

## 0.7.0 新特性 × 场景覆盖表（导演用）

| 新特性（0.6.0 之后） | 版本 | 出场场景 |
|---|---|---|
| 分析留痕（Analysis Manifest） | 0.7.0 | 场景 2（节点固化 SQL/行数/校验和） |
| 一键复跑与漂移提示 | 0.7.0 | 场景 4 |
| 权限确认审计 | 0.7.0 | 场景 2（读样本数据确认弹窗，顺带展示） |
| 交付导出 HTML 报告 | 0.7.0 | 场景 5（收尾压轴） |
| 图谱定义自动注入（公司口径） | 0.7.0 | 场景 3 |
| 口径溯源 + 数据/语义血缘双色边 | 0.7.0 | 场景 4 |
| 口径冲突检测（黄色警示） | 0.7.0 | 场景 3（冲突演示） |
| SourceTable 标注（全限定名） | 0.7.0 | 场景 1 |
| 元数据增量导入与校验报告 | 0.7.0 | 备选镜头 A |
| 对话提亮 / 过程消息折叠 / tool 行可展开 | 0.7.0 | 全程自然呈现 |
| 流式中插队发送（pi steering） | 0.6.1 | 场景 2（边流式边追问） |
| Chat 一键展开 / 宽内容全屏 | 0.6.1 | 场景 3（全屏看图表） |
| govio-cli 自动安装/升级、中英切换 | 0.6.1 | 备选镜头 B |

---

## 素材映射与剪辑时间轴（实录版，2026-11-08）

素材目录：`D:\Work\videos\govio-map0.7.0素材`
实录会话：`2026-11-08T13-18-37-004Z_01a1bb4f-93cc-7740-bd93-e220c291966d`

| 段落 | 素材文件 | 素材时长 | 成片时间码 | 剪辑要点 |
|---|---|---|---|---|
| 开场 | （新增包装；可借场景 1 素材开头空镜） | — | 0:00–0:20 | 空画布推进 + 字幕 |
| 镜头 1 元数据 | `场景 1 · 元数据问数.mp4` | 64.7s | 0:20–1:25 | 4 张表落下 + 悬停全限定名 |
| 镜头 2 加载与留痕 | `场景 2 · 自然语言加载 + 分析留痕（1）.mp4` | 86.7s | 1:25–2:35 | 剪掉权限弹窗等待；Manifest 面板特写 |
| 镜头 2b 插队 | `场景 2 · 自然语言加载 + 分析留痕（2）.mp4` | 14.0s | 2:35–2:50 | 保留排队气泡 + df_hnmnpa 落下 |
| 镜头 3 口径 | `场景 3 · 公司口径 + 口径冲突检测.mp4` | 76.4s | 2:50–4:05 | 3A 无警示 → 3B 黄灯特写 → 差异说明全屏 |
| 镜头 4 血缘 | `场景 4 · 数据血缘 × 语义血缘 + 一键复跑.mp4` | 55.5s | 4:05–5:00 | 全景拉 + 紫虚线揭示 + 复跑 |
| 镜头 5 导出 | `场景 5 · 一键导出交付报告.mp4` | 31.7s | 5:00–5:32 | HTML 报告四区块滚动 |
| 结尾 | （新增包装；定格全景） | — | 5:32–5:45 | 三条价值点浮现 |

总素材 329.0s（5:29），成片目标 **5:45**（含开场/结尾包装）。

---

## 场景总览（实录版）

| # | 场景 | 成片时段 | 实录时长 | 画布累计节点 |
|---|---|---|---|---|
| 0 | 开场钩子：「这个数敢不敢交给领导」 | 0:00–0:20 | — | 0 |
| 1 | 元数据问数（SourceTable 标注） | 0:20–1:25 | 64.7s | 4 × sourceTable |
| 2 | 自然语言加载 + 分析留痕 | 1:25–2:50 | 86.7 + 14.0s | + 2 SQL + 2 DataFrame |
| 3 | 公司口径：正确不打扰 + 偏离亮灯 | 2:50–4:05 | 76.4s | + 2 SQL + 2 DataFrame + ⚠ 黄灯 |
| 4 | 数据血缘 × 语义血缘 + 复跑 | 4:05–5:00 | 55.5s | 全图 13 节点 / 12 边 |
| 5 | 一键导出交付报告 | 5:00–5:32 | 31.7s | 导出 HTML 全屏 |
| 6 | 结尾总结 | 5:32–5:45 | — | 定格全景 |

---

## 场景 0 · 开场钩子（0:00–0:20｜新增包装，无素材）

**画面**：Govio Map 空画布缓慢推近，右侧对话面板打字光标闪烁。

**旁白**：
> 「20 万行巧克力销售数据。问题是——你算出来的每个数，敢不敢直接交给领导？口径对不对？来源查不查得到？0.7.0，Govio Map 把『可信』做进了产品里。」

**字幕**：`结果可信 · 口径可溯 — Govio Map 0.7.0`

**操作**：无。静帧 + 轻微缩放动画。

---

## 场景 1 · 元数据问数（0:20–1:25｜素材 64.7s）★ 0.7.0：SourceTable 标注

**画面**：对话面板输入 → 回答流式输出 → 画布自动落下 sourceTable 节点。过程消息自动折叠为「已处理」（0.7.0 对话体验）。

**操作与台词**：

1. 对话输入（自然语言；**这句同时给后续定好节奏**——先出 SQL 节点再加载 DataFrame）：
   > 「加载 chocolate 表结构和指标定义，后续处理先生产 SQLQuery 再加载 DataFrame」

2. agent 查询知识图谱后回答，画布依次出现 **4 个 sourceTable 节点**（实测 gov-31~34：fact_sales / dim_product / dim_country / dim_channel，紫左边框）：
   - 节点头标注（0.7.0 新增）：**数据源 `chocolate` · DuckDB · schema `chocolate` · 全限定名 `chocolate.chocolate.fact_sales`**——SQL 引用从此有据可依
   - 字段结构：`order_id`、`amount`、`boxes_shipped`、`discount_pct`、`price_per_box`、`marketing_spend`……

3. **关联关系以 agent 文字回答 + 字段标注呈现**（⚠ 表间关系连线未实现，见文末「功能缺口」）：回答中列出 3 条多对一外键：fact_sales.product_id → dim_product、fact_sales.country_id → dim_country、fact_sales.channel_id → dim_channel。

**旁白**：
> 「先认识数据。表节点带着完整的出身证明——数据源、类型、全限定表名，外键关系也在回答里说清楚了，SQL 引用再也不用猜。」

**字幕**：`SourceTable 标注 · 表引用有据可依`

**运镜**：鼠标悬停节点头的全限定名标注，停留 2 秒；再扫过 fact_sales 的外键字段。

> **导演注意**：若「表间关系连线」在录制前实现（见文末功能缺口），本场景升级为——节点间自动连出 3 条外键边，画面效果显著增强，优先采用。

---

## 场景 2 · 自然语言加载 + 分析留痕（1:25–2:50｜素材 86.7s + 14.0s）★ 0.7.0：Manifest / 权限审计 ★ 0.6.1：steering 插队

**画面**：对话输入一句分析请求 → SQL 节点 → DataFrame 节点依次出现并连线。

**操作与台词**：

1. 对话输入：
   > 「按国家统计 2022–2023 年的销售额和订单数。」

2. **趁 agent 流式输出时，直接追加第二句**（0.6.1 新能力：流式中插队发送，气泡显示「已排队/已送达」）：
   > 「顺便看看澳大利亚的月度趋势。」
   ——不用等回复说完，任务自动排队执行。实录产物：`gov-39` SQL + `df_hnmnpa`（25 行 × 3 列：month / sales_amount / order_count）。

3. agent 生成 SQL 并执行，画布出现 **sqlQuery 节点**（实测带 `caliberCheck=consistent`）→ **dataFrame 节点** `df_country_sales_2022_2023`（5 行 × 3 列：country_name / sales_amount / order_count）。
   打开节点详情，**Analysis Manifest 留痕**（0.7.0 核心）逐项可见：
   - SQL 全文、数据源、执行模型
   - 行列数：5 × 3、**结果校验和**（checksum）
   - 权限确认记录：取数确认留痕（命令改前/改后可回查）

4. 点击「预览」，弹出权限确认（读数据）→ 确认后面板打开，5 个国家数据一行行扫过。**确认动作本身也进了审计留痕。**

**旁白**：
> 「说需求，不说 SQL。更关键的是——每个结果都带着留痕：SQL 原文、行数、校验和、连你每一次确认都有据可查。这个数怎么来的，随时回查。」

**字幕**：`分析留痕 Manifest · 每个数可回查`

**运镜**：Manifest 面板逐项扫过 3 秒；预览数据滚动 2 秒后关闭。

---

## 场景 3 · 公司口径：正确不打扰 + 偏离亮灯（2:50–4:05｜素材 76.4s）★ 0.7.0：图谱定义注入 / 冲突黄色警示

**实录依据**：会话 `13-18-37`，节点 `gov-46`（consistent）、`gov-48`（**conflict**）。

### 3A 正确口径：不亮灯（≈35s）

1. 对话输入：
   > 「按渠道算营销 ROI，营销投入花得值不值？」

2. **图谱定义自动注入**：回答展开 tool 调用行可见本次注入的 `m_marketing_roi` 指标定义、维度码值、字段标准。

3. 画布落 **sqlQuery `gov-46`**（**无任何警示**）+ **DataFrame `df_channel_marketing_roi`（3 × 5）**：
   `channel_name` / `sales_amount` / `marketing_spend` / `marketing_roi` / `order_count`

4. 实录 SQL 形态（旁白不念细节，供剪辑时确认画面）：
   ```sql
   SUM(f.amount) AS sales_amount,
   SUM(f.marketing_spend) AS marketing_spend,
   SUM(f.amount) / NULLIF(SUM(f.marketing_spend), 0) AS marketing_roi,
   COUNT(f.order_id) AS order_count
   ```
   → 与 `m_marketing_roi` 口径一致 ⇒ `caliberCheck.status = consistent`，**节点保持干净**。

**旁白（3A）**：
> 「先看口径对的时候。系统提问前就把公司指标定义注进来了，生成的就是公司口径。检测跑完——干净，什么都不提示。对了不打扰，这是检测可信度的前提。」

### 3B 偏离口径：亮黄灯（≈40s，全片高点）

5. 对话输入（实录成功措辞，**必须含后半句**）：
   > 「用每箱单价乘发货数量，算一下 2023 年各国家的销售额。只用这两列，不要引用 amount，也不要加对照列。」

   > **为何必须禁对照列**：agent 天性会额外给一列 `SUM(amount) AS sales_amount_std` 做对照——官方口径一旦在 SQL 里存在，`sql caliber` 就判 `consistent`，**黄灯不亮**（gov-48 上一版实证）。
   > **为何不写「出货箱数」**：检测范围是「问题点名的指标」；写成指标全名会同时点名 `m_boxes_shipped`，导致误报。

6. 画布落 **sqlQuery `gov-48`**，节点亮 **⚠ 黄色警示**（描边 + 徽标）＋ **DataFrame `df_country_sales_2023_price_x_boxes`（5 × 2）**：`country_name` / `sales_amount`。

7. 展开差异说明（实录原文，字幕/特写直接可用）：

   | 项 | 内容 |
   |---|---|
   | 指标 | `m_sales_amount`（销售额） |
   | 差异维度 | 引用列（`aspect=column`） |
   | 应有 | `amount(measure)` |
   | 实际 | `…、price_per_box、boxes_shipped、sales_amount` |
   | 说明 | **计量列 amount 未在 SQL 中引用** |

**旁白（3B）**：
> 「现在故意偏一点：用单价乘箱数算销售额，不碰公司口径里的 amount。它没装看不见——黄灯亮了，还告诉你差在哪：计量列 amount 没被引用。宁可存疑，不静默放行。」

**字幕**：`口径冲突检测 · 对了不打扰，错了不放过`

**运镜**：3A 结果停留 2s（干净状态）→ 3B 节点黄灯特写 3s → 差异说明全屏 2s。

> **剪辑提示**：语义血缘紫虚线在本段已出现（`gov-35→gov-46`、`gov-35→gov-48`、`gov-46→gov-48`），建议**本段不给全景**，留给场景 4 揭示。

---

## 场景 4 · 数据血缘 × 语义血缘 + 一键复跑（4:05–5:00｜素材 55.5s）★ 0.7.0：语义血缘 / 复跑漂移

**实录依据**：画布 13 节点 / 12 条边，其中**语义血缘 3 条**（`e-gov-35-gov-46-sem`、`e-gov-35-gov-48-sem`、`e-gov-46-gov-48-sem`），数据血缘 9 条。

**画面**：镜头拉远揭示全景——**绿色实线**（数据血缘）× **紫色虚线**（语义血缘，口径沿袭）交错，左上角图例（0.7.0 图例置于画布左上角）。

实录拓扑（剪辑可直接照此画外音分段）：

```
fact_sales gov-31 ─┬─▶ gov-35 SQL ─▶ gov-36 df_country_sales_2022_2023 ─▶ gov-50 chart
dim_country gov-33 ┘        │
                            ├╌╌semantic╌╌▶ gov-46 SQL（渠道 ROI）─▶ gov-47 df_channel_marketing_roi
                            └╌╌semantic╌╌▶ gov-48 SQL（⚠ 冲突口径）─▶ gov-49 df_country_sales_2023_price_x_boxes
                                              ▲
                            gov-46 ╌╌semantic╌╌┘（口径沿袭，同样引用 m_* 指标）
fact_sales/dim_country ─▶ gov-39 SQL ─▶ gov-41 df_hnmnpa（月度趋势）
```

**操作与讲解**：

1. 全景拉远 3s，图例入画：绿实线 = 数据血缘（表 → SQL → DataFrame → 图表），紫虚线 = 语义血缘（几个 SQL 引用了同一批图谱指标/维度）。
2. 沿链路从左到右平移 2s，鼠标停在紫虚线上：`gov-35`（销售额/订单数口径）→ `gov-46`（ROI 口径）→ `gov-48`（偏离口径但仍引用同一指标）。
3. 点 `df_country_sales_2022_2023`（`gov-36`）的 **「复跑」**：按固化 SQL 重执行，对比 `rowCount=5` + `checksum` —— **一致，无漂移**；Manifest 保留 `firstExecutedAt` 与 `executedAt`，可见复跑痕迹。
4. 旁白顺势讲漂移场景（画面不给失败态，仅口述）。

**旁白**：
> 「拉远看全貌。绿色是数据从哪来——表、SQL、DataFrame、图表；紫色是口径从哪来——这几个结论引用的是同一批公司指标。一条结论，两层血缘。还能一键复跑：数据变了它会亮漂移警告，但原来的留痕永远保留，绝不静默覆盖。」

**字幕**：`数据血缘 × 语义血缘 · 一键复跑守护结论`

**运镜**：全景 3s → 沿链路平移 2s → 紫虚线停 2s（可加「口径沿袭」小标注）→ 复跑按钮特写 → 「无漂移」结果停 2s。

> **剪辑注意**：实录里存在 1 条早期手动连的边（`edge-gov-39-gov-41`，无 `lineageKind`，按数据血缘显示）。若画面里显得杂乱，可在剪辑时裁掉该局部，不影响叙事。

---

## 场景 5 · 一键导出交付报告（5:00–5:32｜素材 31.7s）★ 0.7.0：自包含 HTML 导出（压轴）

**画面**：画布工具栏点「导出」→ 新标签打开自包含 HTML 报告，缓慢滚动四区块。

**操作与讲解**：

1. 导出本会话画布，报告在新标签打开。
2. 依次滚过四区块（各约 1.5s）：
   - **节点与结论总览**（13 个节点摘要）
   - **血缘图**：数据/语义双色边随导出保留（绿实线 + 紫虚线，与画布一致）
   - **Manifest 附录**：SQL 全文、`rowCount`/`columnCount`、`checksum`、执行模型、`firstExecutedAt`
   - **权限审计附录（附录 B）**：取数/读数据确认记录（`permissionDecisionId` 可回查 `.audit.jsonl`，本会话实录含多条确认记录）
3. 关掉 Govio Map / 断网后报告仍可打开（真机演示 3s）。

**旁白**：
> 「最后一键交付。一个自包含的 HTML 报告——结论、血缘、留痕、附录，连你每一次取数确认都在里面。发给谁都能离线打开。从提问到交付，全程可信。」

**字幕**：`一键导出 · 离线可看的可信交付`

**运镜**：四区块各 1.5s 滚动；最后 3s 真机断网/关窗展示。

---

## 场景 6 · 结尾总结（5:32–5:45）

**画面**：切回画布全景 + Logo，三条 0.7.0 价值点逐条浮现。

**旁白**：
> 「Govio Map 0.7.0：结果可信，口径可溯。你的数据，说一句话就开始。」

**字幕（逐条浮现）**：
- `分析留痕 · 复跑漂移 · 一键交付`
- `公司口径自动注入 · 冲突亮灯`
- `数据血缘 × 语义血缘`

---

## 录制准备清单

- [ ] `govio-cli ≥ 0.7.2`（口径检测表达式等价 / measure-first 判定依赖）；`govio-cli --version` 确认
- [ ] **dev server 已重启**（加载最新注入超时与 CLI）；确认 `.govio/sessions/*.injection.jsonl` 最新条目 `graphStatus=ok`
- [ ] 场景 3B 问句**只点名目标指标**：「用每箱单价乘发货数量，算一下 2023 年各国家的销售额。」（实测 `caliberMetrics=[m_sales_amount]`）
- [ ] 图谱中已导入 chocolate **指标定义**（m_sales_amount / m_marketing_roi 等）与维度/标准——场景 3 的口径注入与冲突检测依赖它们
- [ ] 清空画布（场景 0 需要空画布开场）；确认 localStorage 中无残留节点
- [ ] **提前释放已有 DataFrame**（历史会话产物）：场景 2/3 需现场生成才有完整链路，录制前 `observe release` 清理（实录产出名见上「可复用产物」）
- [ ] `chocolate.db` 无其他进程占用（录制前关闭其它连接，避免 IO Error）
- [ ] 浏览器 1920×1080、100% 缩放、隐藏书签栏；DM Sans / JetBrains Mono 字体加载完成
- [ ] 画布背景 #f5f5f5、节点配色为 Green Deck 默认；血缘图例在左上角不遮挡缩放控件
- [ ] 场景 3 的「错误口径」请求已实测稳定触发黄色警示（用词避免被 agent 自动纠正口径）
- [ ] 场景 3A 正确口径请求已确认**无黄色警示**（consistent）——这是「不误报」的对照镜头
- [ ] 场景 3B 若 agent 把列改名为 `revenue_calc` 等非指标名 → 判定降为 unknown（不亮灯，属 PD-2 边界）→ 重录该句
- [ ] 场景 1 不出现表间连线（未实现）——旁白与画面均不宣称「自动连线」，除非功能缺口已实现
- [ ] 旁白稿按本脚本校时；字幕文件按场景时间码导出

## 备选镜头

1. **A · 元数据增量导入（0.7.0，+20s）**：govio-cli 侧重复导入 chocolate 元数据 → 校验报告（计数 + 新增/更新/跳过 + 重复 ID/孤儿边校验）——展示「导入幂等、变更可核」。
2. **B · 数据质量彩蛋（+30s）**：对话问「数据里有什么异常？」→ 引用 EDA 报告：`boxes_shipped` 存在负数（最小 -1,642）→ report 节点上画布，展示「发现 → 留痕」闭环。
3. **C · 中英切换（0.6.1，+10s）**：界面一键切英文——面向国际化受众的宣传片花。

## 功能缺口（截至 govio-cli 0.7.2 实测）

| 缺口 | 现状 | 影响 |
|---|---|---|
| sourceTable 之间无关系连线 | 建边逻辑只覆盖数据血缘（引用/来源）与 sqlQuery↔sqlQuery 语义血缘；外键仅字段级 `references`/FK 徽标，`observe explore` 外键发现只出文字报告 | **已立项 X10（方案2：图谱 rel → 语义血缘紫虚线），本期录制暂不实现**；场景 1 按现状口径录制，功能落地后可升级为亮点镜头 |
| 口径检测的别名归一（方案 C） | 检测范围 = 「问题点名的指标」；agent 主动把计算列改名（如 `revenue_calc`）则不算声称 → unknown 不亮灯 | PD-2 待讨论；录制期用干净措辞规避，遇改名则重录（见场景 3B 录制注意） |

## 风险与规避

| 风险 | 规避 |
|---|---|
| agent 生成的 SQL 与脚本示意不一致 | 脚本 SQL 仅作分镜示意，旁白不念 SQL 细节，画面以实际节点为准 |
| 表引用报 Catalog/Binder 错误 | 全程使用三段式 `chocolate.chocolate.*`，录制前跑通一遍全流程 |
| 「错误口径」请求被 agent 主动纠正而不触发警示 | 先录 3A 正确口径作对照（本就不应亮灯）；3B 若被纠正，改用「**只用**单价×数量算，不要用 amount」的硬缺失措辞（实测必 conflict） |
| 问句同时点名多个指标（如写「乘出货箱数」） | 会把计算成分当诉求 → 正确 SQL 也亮灯；录制时禁用带指标全名的成分描述（用「发货数量」代替「出货箱数」） |
| 校验和/Manifest 字段展示样式与脚本不符 | 以实际 UI 为准，旁白只讲「SQL、行数、校验和、确认记录」四个概念 |
| 画布节点自动布局位置重叠 | 录制前实测 dagre 布局，必要时手动拖开后再录 |
| 复跑出现真实漂移（数据被其它进程改动） | 录制前确保 chocolate.db 只读、无并发写入 |

---

## 录制前环境预检（2026-11-08 实测通过）

| 检查项 | 命令 | 期望 |
|---|---|---|
| CLI 版本 | `govio-cli --version` | `govio 0.7.2`（0.7.0/0.7.1 会把正确口径判成 unknown） |
| 数据源 | `govio-cli observe info --datasource` | `["chocolate","sales"]` |
| 偏离口径判定 | `govio-cli sql caliber --sql "<price*boxes 无 amount 的 SQL>" --metric m_sales_amount` | `conflict` |
| 正确口径判定 | `govio-cli sql caliber --sql "SELECT ROUND(SUM(amount),2) ..." --metric m_sales_amount` | `consistent`（不误报，3A 的前提） |
| 注入健康度 | 看最新 `.govio/sessions/*.injection.jsonl` 的 `graphStatus` | `ok`；若 `degraded` 看 `graphError`（已含退出码/信号/stderr） |
| 服务端代码 | `npm run dev` 重启后再录 | 未重启会带旧注入超时/旧 CLI 行为 |

---

## 口径冲突触发条件（govio-cli 0.7.2 实测，录制必须遵守）

检测范围 = **问题点名的指标**（问句里出现指标名/编码）；判定依据 = SQL 事实 vs 指标 `formula` + `measure` 列。

| SQL 形态 | 判定 | 黄灯 | 备注 |
|---|---|---|---|
| `SUM(price_per_box*boxes_shipped) AS sales_amount`，**不含 amount** | conflict | ✅ **必中** | 计量列 amount 未引用（推荐的 3B 形态） |
| `SUM(amount*(1-discount_pct/100)) AS sales_amount`，amount 被修饰 | conflict | ✅ | 聚合参数与 formula 不一致 |
| `AVG(amount)` | conflict | ✅ | 聚合函数不一致 |
| `SUM(price*boxes) AS sales_amount` **+ 另给 `SUM(amount) AS std`** | **consistent** | ❌ | **实测踩坑点**：官方口径存在即视为按口径实现 |
| `ROUND(SUM(amount),2)` | consistent | ❌ | 正确口径本就不打扰（3A 用） |
| 问句点名指标但 SQL 完全没算它 | conflict | ✅ | 计量列全部未引用 |

**录制纪律（三B）**：措辞必须同时满足 ——
1. 只点名目标指标（不要写「出货箱数」等指标全名，用「发货数量」）
2. **禁止 `amount` 出现**（写「不要引用 amount」）
3. **禁止对照列**（写「不要加对照列」）

## 实测流程参照（会话 2026-11-08T13-18-37Z 最终态，剪辑核对用）

| 节点 | 类型 | 内容 | 判定 |
|---|---|---|---|
| gov-31~34 | sourceTable | fact_sales / dim_product / dim_country / dim_channel（带 qualifiedName） | — |
| gov-35 | sqlQuery | 各国销售额+订单数（2022–2023） | `consistent`（无警示） |
| gov-36 | dataFrame | `df_country_sales_2022_2023`（5×3） | — |
| gov-39 | sqlQuery | 澳大利亚月度趋势 | 无 check（steer 轮次） |
| gov-41 | dataFrame | `df_hnmnpa`（25×3） | — |
| gov-46 | sqlQuery | 渠道营销 ROI | `consistent`（无警示） |
| gov-47 | dataFrame | `df_channel_marketing_roi`（3×5） | — |
| **gov-48** | sqlQuery | 2023 各国销售额（单价×数量） | **`conflict`（⚠ 黄灯）**：计量列 amount 未在 SQL 中引用 |
| gov-49 | dataFrame | `df_country_sales_2023_price_x_boxes`（5×2） | — |
| gov-50 | chart | 柱图「2022–2023 各国销售额（含订单数参照）」 | — |

边（12 条）：数据血缘 9（含 1 条早期手连 `edge-gov-39-gov-41`）+ **语义血缘 3**（`gov-35→gov-46`、`gov-35→gov-48`、`gov-46→gov-48`）。

**录制成败要点（已固化在代码，勿再重蹈）**：
1. caliber 检测超时 6s→12s + 失败重试一次 + 失败告警（`[caliber] 检测失败…`），不再静默缺失黄灯
2. 口径引用生命周期统一在 `agent_end` 清理；流式 steer 不再清空（曾导致 refs 恒空）
3. 3B 措辞必须「只用这两列、不要引用 amount、不要加对照列」——带对照列会判 consistent
4. 录制后核对：`.govio/sessions/<session>.jsonl.canvas.json` 里目标 sqlQuery 节点应有
   `caliberCheck.status = "conflict"`，且 `differences[].detail` 含「计量列 amount 未在 SQL 中引用」
