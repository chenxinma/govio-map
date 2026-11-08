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
- **状态**：⏸ 待讨论（暂不列入任务清单）
- **待定**：做到哪一档；若做 3，挂 P2 还是 crossCutting，与 T2.3 的展示如何分工

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
- **状态**：⏸ 待讨论（暂不列入任务清单）
- **待定**：1+3 是否一起做（1 是功能、3 是调判定口径，可能影响既有 45 项 assert）；若做 4 需与「宁可 unknown 不误报」纪律对齐；是否挂 P2 语义层还是 crossCutting
