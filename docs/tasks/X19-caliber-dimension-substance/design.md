# X19-W5b 设计：口径维度实质比对——map 侧消费与收尾

> 跨仓任务 X19 的 **map 侧（W5b）**。govio 侧（W5a）已交付并合入 govio main：交付 commit
> `c621de9` → PR #24 → merge `a92a291`（2026-11-14）。
> 验收契约：`docs/task-plan.json → crossCutting[X19]` 的 note/scope/acceptance。
> 定调原文：`docs/PENDING-DISCUSSION.md` PD-2（2026-11-14 用户裁决：口径判定以**计算表达式**和
> **维度限定条件**为实质判据）。维度判定的算法事实源是 govio 仓
> `docs/tasks/X19-caliber-dimension-substance/design.md`（只读引用，本文件不复制其实现细节）。

## 1. 分工与本次范围

| 层 | 归属 | 本次动作 |
|---|---|---|
| 维度限定结构化比对（三元组 vs 声明） | govio 仓 `src/govio/metadata/caliber.py` | 已在 W5a 完成并合并，本任务只引用 |
| CLI 输出 JSON 解析面 | map `server/caliber-check.ts` | **零改动**（契约未变，见 §4） |
| 展示名与状态映射 | map `src/utils/caliber.ts` | **零改动**（aspect 集合已覆盖，见 §4） |
| 警示区展示 | map `src/components/Nodes/SQLQueryNode.tsx` | **零改动**（现状已覆盖维度条目与 reason，见 §5） |
| 消费侧回归断言 | map `scripts/verify-caliber-conflict.ts` | 46 → 77（+31，见 §7 与 verification.md） |
| 文档 | `docs/PENDING-DISCUSSION.md`、本目录三件套 | PD-2 标注已定调并落地 + 三件套 |

## 2. 判定矩阵（govio design.md §3 的 map 侧视角）

维度差异全部落在既有 `filter` aspect（时间粒度落在 `time_scope`），条目形状不变。
map 侧不重复判定，只消费 `results[].status` 的汇总（conflict > unknown > consistent）。
下表是 map 侧断言按「能否在 node.data 里看到」重新归类的视图：

| govio 判定矩阵条目 | status | 差异条目 aspect | map 侧可见性 |
|---|---|---|---|
| #1 声明取值已被 SQL 限定命中 | consistent | 不产条目 | 不打扰 |
| #2 命中但取值超出声明 | unknown | `filter` | 数据在，画布不打扰 |
| #3 限定到同维度其它声明枚举值 | **conflict** | `filter` | 黄灯 + 展开明细 |
| #4 同列限定但取值不可枚举 | unknown | `filter` | 数据在，不打扰 |
| #5 该列只出现在 GROUP BY | unknown | `filter` | 数据在，不打扰 |
| #6 有无法归属声明维度的等值限定 | unknown | `filter` | 数据在，不打扰 |
| #7 整条 SQL 无任何等价落点 | **conflict** | `filter` | 黄灯 + 展开明细 |
| #8 SQL 只取声明剔除的取值 | **conflict** | `filter` | 黄灯 + 展开明细 |
| #9 用 `!=`/`NOT IN` 实现剔除 | consistent | 不产条目 | 不打扰 |
| #10 指标无维度声明 | consistent | 不产条目 | 不打扰（降噪边界） |
| #11 SQL 附加未声明限定 | unknown | `filter` | 数据在，不打扰 |
| 时间粒度 T1-T3（声明月度、SQL 年度） | conflict / 不产条目 | `time_scope` | 黄灯 + 展开明细 |

## 3. 三态边界（map 侧必须遵守的一条纪律）

govio `compare_metric`（`src/govio/metadata/caliber.py:1272`，commit `c621de9`）明确：**判定收在
`status`，单条差异不带判定**——`differences` 里 conflict 级与存疑级条目形状完全相同，只有
`status` 与 reason 文案的措辞不同（「实质矛盾」vs「存疑/无法确认/未确证」）。

由此 map 侧的边界是：

- **不得**按 aspect 或 reason 关键词在 map 侧重推状态（那会把 govio 的判定纪律稀释成第二套判定）；
- 汇总只认 `results[].status` 的 conflict > unknown > consistent 优先级（既有实现，未改）；
- unknown 的差异条目**必须完整保留**在 `node.data.caliberCheck`（画布不打扰，但可追溯）——
  这是 W5b 新增断言的主张之一（`scripts/verify-caliber-conflict.ts` 的 [2b]/[4] 段）。

## 4. 输出契约核对：为什么 map 解析面零改动

W5a 验收与本次独立核查一致（证据见 verification.md）：

- 单行 JSON `{results: [{metric, status, differences}]}` 形状不变；
- `differences` 条目键仍 ⊆ `{aspect, expected, found, detail}`；
- 三态取值不变；**aspect 未新增**：扫描 `c621de9` 版 `caliber.py` 全部 `_diff(` 调用点，实际产出
  集合为 `aggregation / column / filter / sql / time_scope`（`metric` 无产出，属历史保留）。

因此 `parseCaliberOutput`（`server/caliber-check.ts:66`）无需容错扩展，`CALIBER_ASPECT_LABELS`
（`src/utils/caliber.ts:20`）既有 6 条展示名已覆盖全部实际产出维度 → **零改动**，并把该结论固化为
回归断言（新增检查「W5a 实际产出 aspect 全部已有展示名」）。将来 govio 若新增 aspect，该断言会先红，
提示按 §8 流程先改 map 再改 CLI。

## 5. 展示核对（沿用 X15.1「画布轻、详情 hover/展开」取舍）

SQL 节点警示区现状已覆盖维度差异，无需改动：

- **hover**：conflict 徽标带 `title="口径与图谱指标定义存在冲突，点击查看差异说明"`
  （`src/components/Nodes/SQLQueryNode.tsx:112`）——措辞是维度中立的，维度矛盾同样适用；
- **展开明细**：徽标 click 展开后逐条渲染 `CALIBER_ASPECT_LABELS[d.aspect] ?? d.aspect` +
  期望 + 实际 + `detail`（reason）（同文件 :170-188），维度条目与聚合条目共用同一渲染路径，
  reason 全文可见（`filter` 显示为「过滤/统计范围」）；
- **配色唯一来源**仍是 `caliberNodeAppearance`（X18 立项时确认的分工），本任务未触碰。

刻意不做（避免越界与冲突）：

- 不为 `unknown` 增加画布可见性——PD-2 候选 4（角标小圆点）仍未裁决，且「宁可 unknown 不误报」
  的既有取舍明写轻提示会训练用户忽略警示；
- 不动徽标区代码：X18（PR #39）正在合并流程且改同一文件，任何展示改动都留给主会话协调 rebase。

## 6. 与方案 C（别名归一）的界限

方案 C 未获授权，本任务两侧都没做：

- map 侧检测范围仍由 `caliberMetrics`（问题点名的指标）决定，`semanticRefs` 只管溯源，
  既有 [4b] 段断言继续锁住「同表注入指标不参检」；
- 不引入同义词典/`calc_`、`m_` 修饰剥离；govio 侧的列绑定只是「元数据自带名字的字面 token 匹配」
  （govio design.md §6），匹配不到即落 unknown（矩阵 #6）；
- 「不误报」由 govio 三类反例测试锁定（不可归属列 / 跨语种取值 / 取值超集），map 侧不重复实现，
  只在 [2b] 断言存疑条目不会被汇总成 conflict。

## 7. 降级契约（本次补强断言的口径澄清）

任务书把「空 differences」与 CLI 失败/非 JSON/空输入并列为降级输入，但既有契约里它分两类，
断言按实际行为固化（不新增行为）：

- **省略 `caliberCheck` 键**（不抛错、不阻断建节点）：CLI reject/超时、非 JSON、空输出、
  `{}`/`{"results":[]}`（空 results）、status 越界、差异条目缺 `aspect/expected/found`；
- **保留键但零条目**：`status: consistent` + `differences: []`——这是「无维度声明」（矩阵 #10）的
  **合法**结果，不是降级；若把它当降级省略，会丢掉「这条 SQL 口径干净」的正向信号。

将来若要让 consistent 也不建键，属 CLI/节点形状契约变更，须先 ask 主会话再动 `parseCaliberOutput`。

## 8. 跨仓协同与合并顺序

- 已按「先合 govio（PR #24）→ 再派 map W5b」执行；两仓改动互相独立可跑绿：govio 未合入时
  map 断言用 stub 注入仍绿，map 未合入时 govio 侧行为不变（新逻辑只在有维度声明数据时产条目）。
- map 侧本次只改验证脚本 + 文档，**不改任何运行时代码**，因此不存在需要与 CLI 发布同步的兼容窗口。

## 9. 遗留问题

1. **真实 CLI 的 8 档输出待发版补录**：本机 `govio-cli` 仍是 0.7.2（`uv` 安装产物里的
   `metadata/caliber.py` 808 行，不含 `_compare_dimensions`），W5a 未进发布产物。verification.md
   以 govio 侧 `tests/test_caliber_dimension_compare.py`（42 例，含 `PD2_SAMPLES` 逐档断言）为证据；
   发版后应补一列真实 CLI 输出对照。
2. **unknown 维度存疑在画布完全不可见**：徽标只在 conflict 渲染，因此矩阵 #2/#4/#5/#6/#11 的
   reason 用户看不到（数据在 `node.data.caliberCheck`）。彻底解法依赖 PD-2 候选 4 的单独裁决，
   不建议在 X19 里顺手加视觉元素。
3. **维度差异条目的展示没有「维度」专属标签**：`filter` 显示为「过滤/统计范围」，与剔除词弱证据
   路径共用一个展示名。若元数据侧后续把维度限定升级为显式字段（govio design.md §7-2），
   可考虑拆分 aspect 并补展示名——届时属契约变更，须先改 map 解析面。
4. **verify 脚本头部注释与实现漂移（既有）**：文件头第 3 条仍写「不抛错、不重试」，而
   `runCaliberCheck` 已实现失败重试一次并有对应断言（历史改动遗留，非本任务引入）；
   为避免与本任务断言混淆，新增段落单独标注为 X19-W5b，未顺带重写旧注释正文。
5. **维度判定的实际产出依赖元数据质量**：`values_example` 不完整即无声明可比对（govio design.md
   §7-2/§7-3），生产图库里维度 conflict 条目可能长期偏少；map 侧「维度差异有展示」的验收只能靠
   stub 断言，不能靠真机演示。
6. **未加 UI 层测试**：`tests/ui/sql-query-node.test.tsx` 目前没有口径警示区用例，且该文件与 X18
   PR #39 高度重叠，本任务不补，留待 X18 合并后单独安排（展示核对结论见 §5）。