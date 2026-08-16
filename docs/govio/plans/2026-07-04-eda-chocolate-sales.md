# EDA 探查计划: Chocolate 销售数据

**目标**: 对 fact_sales 事实表及关联维度表（dim_product、dim_country、dim_channel）进行全面探查，了解数据全貌、验证关联关系、检查数据一致性
**数据源**: chocolate
**涉及表**: fact_sales, dim_product, dim_country, dim_channel
**阶段**: 标准（Phase 1-4）
**创建时间**: 2026-07-04

---

## Phase 1: 数据集画像

- [ ] 加载数据集: fact_sales, dim_product, dim_country, dim_channel
- [ ] 执行画像分析（行数、列数、空值、数值统计、分类分布、日期范围）
- [ ] 产出数据集卡片

## Phase 2: 推断关联

- [ ] 运行关系探索
- [ ] 生成关系图谱
- [ ] 筛选候选关联

## Phase 3: 核查关联

- [ ] 验证每个候选关联（匹配率、缺失键、重复键）
- [ ] 记录匹配率和异常

## Phase 4: 一致性核查

- [ ] 选择适用规则模式
- [ ] 实例化并执行规则
- [ ] 导出异常数据（JSON，后续合并为 Excel）

## 汇总

- [ ] 生成 EDA 报告 (Markdown)
- [ ] 整理异常数据集
