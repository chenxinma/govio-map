# EDA 探查报告: Chocolate 销售数据

**探查时间**: 2026-07-04
**数据源**: chocolate
**探查范围**: fact_sales, dim_product, dim_country, dim_channel

---

## 1. 数据集画像

### fact_sales（销售事实表）

| 维度 | 值 |
|------|-----|
| 来源 | chocolate |
| 行数 | 200,000 |
| 列数 | 11 |
| 时间范围 | 2022-01-01 ~ 2023-12-31（24 个月） |

**字段详情**:

| 字段 | 类型 | 非空率 | 基数 | 说明 |
|------|------|--------|------|------|
| order_id | VARCHAR | 100% | 200,000 | 订单号（主键） |
| product_id | BIGINT | 100% | 12 | 产品ID → dim_product |
| country_id | BIGINT | 100% | 5 | 国家ID → dim_country |
| channel_id | BIGINT | 100% | 3 | 渠道ID → dim_channel |
| salesperson | VARCHAR | 100% | 25 | 销售人员 |
| order_date | DATE | 99.78% | 730 | 订单日期 |
| discount_pct | DOUBLE | 99.76% | 2,517 | 折扣率(%) |
| price_per_box | DOUBLE | 99.77% | — | 每盒单价 |
| marketing_spend | DOUBLE | 99.77% | — | 营销费用 |
| boxes_shipped | BIGINT | 100% | — | 发货箱数 |
| amount | DOUBLE | 100% | — | 销售金额 |

**数值字段统计**:

| 字段 | 均值 | 标准差 | 最小值 | 中位数 | 最大值 |
|------|------|--------|--------|--------|--------|
| discount_pct | 13.11% | 6.37 | 0.0% | 12.6% | 38.3% |
| price_per_box | 5.91 | 4.95 | 2.04 | 3.28 | 21.65 |
| marketing_spend | 95.45 | 66.24 | 4.30 | 78.85 | 798.22 |
| boxes_shipped | 139.58 | 118.67 | **-1,642** | 113.0 | 3,811 |
| amount | 512.86 | 365.48 | 28.81 | 417.30 | 12,138.09 |

**分类字段 Top 分布**:

| 产品 | 占比 | 国家 | 占比 | 渠道 | 占比 |
|------|------|------|------|------|------|
| 70% Dark Bar | 32.40% | Australia | 46.30% | Retail | 58.25% |
| Truffle Gift Box | 16.15% | Brazil | 26.48% | Wholesale | 29.62% |
| Mixed Assortment Box | 10.73% | Germany | 12.63% | Online | 12.13% |
| Milk Classic Bar | 8.09% | India | 8.76% | | |
| Pralines Gift Box | 6.37% | Japan | 5.83% | | |

Top 销售人员: Arjun Mehta (33.79%), Priya Sharma (14.66%), Emily Clarke (8.90%)

---

### dim_product（产品维度表）

| 维度 | 值 |
|------|-----|
| 来源 | chocolate |
| 行数 | 12 |
| 列数 | 2 |
| 字段 | product_id (BIGINT), product_name (VARCHAR) |

### dim_country（国家维度表）

| 维度 | 值 |
|------|-----|
| 来源 | chocolate |
| 行数 | 5 |
| 列数 | 2 |
| 字段 | country_id (BIGINT), country_name (VARCHAR) |
| 国家 | Australia, Brazil, Germany, India, Japan |

### dim_channel（渠道维度表）

| 维度 | 值 |
|------|-----|
| 来源 | chocolate |
| 行数 | 3 |
| 列数 | 2 |
| 字段 | channel_id (BIGINT), channel_name (VARCHAR) |
| 渠道 | Online, Retail, Wholesale |

---

## 2. 关联分析

### 候选关联清单

| # | 类型 | 源表.字段 | 目标表.字段 | 置信度 | 审查结果 |
|---|------|----------|------------|--------|---------|
| 1 | 外键 | fact_sales.product_id | dim_product.product_id | 100% | ✅ 确认 |
| 2 | 外键 | fact_sales.country_id | dim_country.country_id | 100% | ✅ 确认 |
| 3 | 外键 | fact_sales.channel_id | dim_channel.channel_id | 100% | ✅ 确认 |

### 关系图谱

```
                    ┌──────────────┐
                    │  dim_product │
                    │  (12 种产品) │
                    └──────┬───────┘
                           │ product_id
                           ▼
┌──────────┐    ┌──────────────────┐    ┌─────────────┐
│ dim_country◄───│   fact_sales     │───►│ dim_channel │
│ (5 个国家)│    │  (200,000 条)    │    │ (3 个渠道)  │
└──────────┘    └──────────────────┘    └─────────────┘
```

---

## 3. 关联验证

### 关联 #1: fact_sales.product_id → dim_product.product_id

| 指标 | 值 |
|------|-----|
| 源表总行数 | 200,000 |
| 匹配行数 | 200,000 |
| 匹配率 | 100% |
| **判定** | ✅ 强关联 |

### 关联 #2: fact_sales.country_id → dim_country.country_id

| 指标 | 值 |
|------|-----|
| 源表总行数 | 200,000 |
| 匹配行数 | 200,000 |
| 匹配率 | 100% |
| **判定** | ✅ 强关联 |

### 关联 #3: fact_sales.channel_id → dim_channel.channel_id

| 指标 | 值 |
|------|-----|
| 源表总行数 | 200,000 |
| 匹配行数 | 200,000 |
| 匹配率 | 100% |
| **判定** | ✅ 强关联 |

---

## 4. 一致性核查

### 规则 1: 发货箱数负值检查

| 状态 | 数量 | 占比 |
|------|------|------|
| 正常（≥0） | 198,044 | 99.02% |
| **异常（< 0）** | **1,956** | **0.98%** |

boxes_shipped 中存在 1,956 条负值记录（范围 -1,642 ~ -3），可能代表退货/冲销。

### 规则 2: 折扣率范围检查

| 状态 | 数量 | 占比 |
|------|------|------|
| 正常（0~100%） | 200,000 | 100% |
| 异常 | 0 | 0% |

✅ 折扣率全部在合理范围内（0%~38.3%）。

### 规则 3: 金额公式一致性检查

| 状态 | 数量 | 占比 |
|------|------|------|
| 一致（amount = price × boxes × (1-discount)） | 521 | 0.26% |
| **偏差过大** | **199,022** | **99.74%** |

⚠️ 99.74% 的记录中 amount 不等于 price_per_box × boxes_shipped × (1-discount_pct)，表明 amount 可能是独立录入而非公式计算得出。

### 规则 4: 空值检查

| 字段 | 空值数 | 占比 |
|------|--------|------|
| order_date | 444 | 0.22% |
| discount_pct | 489 | 0.24% |
| price_per_box | 457 | 0.23% |
| marketing_spend | 461 | 0.23% |

⚠️ 少量字段存在空值（约 0.2%~0.24%），占比很低，影响小。

---

## 5. 发现汇总

### 5.1 关键发现

| # | 发现 | 严重度 | 说明 |
|---|------|--------|------|
| 🔴 | boxes_shipped 存在负值 | 中 | 1,956 条（0.98%）记录发货箱数为负，需确认是否为退货冲销 |
| 🟡 | amount 与单价×数量×折扣不一致 | 低 | 99.74% 的记录不满足公式，说明 amount 为独立录入，非计算字段 |
| 🟢 | 3 个外键关联 100% 匹配 | — | 主外键关系完整，无孤子记录 |
| 🟢 | 折扣率均在合理范围内 | — | 0% ~ 38.3%，无异常值 |
| 🟢 | 数据时间跨度完整 | — | 2022-01 ~ 2023-12，覆盖 24 个月 |

### 5.2 异常清单

| 异常项 | 记录数 | 异常文件 |
|--------|--------|---------|
| boxes_shipped 负值（退货/冲销） | 1,956 | eda_chocolate_boxes_负值_异常.json |
| 空值记录（order_date/discount/price/spend） | ~460/项 | eda_chocolate_空值_异常.json |

### 5.3 建议

1. **核实负值含义**：确认 boxes_shipped 负值是否为退货/冲销，如是则需在分析中注意区分正常销售与退货
2. **空值处理**：建议在 ETL 层补充缺失的 order_date、discount_pct、price_per_box、marketing_spend 字段
3. **保留独立金额**：amount 作为独立录入字段，与计算口径可能不同，分析时需根据场景选择合适的口径

---

## 附录: 异常数据集

如需导出异常数据，可按以下规则提取：
- `eda_chocolate_boxes_负值_异常.json`: `SELECT * FROM fact_sales WHERE boxes_shipped < 0`
- `eda_chocolate_空值_异常.json`: `SELECT * FROM fact_sales WHERE order_date IS NULL OR discount_pct IS NULL OR price_per_box IS NULL OR marketing_spend IS NULL`
