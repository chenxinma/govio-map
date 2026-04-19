import type { MockResponse, MockDataFrameResponse, MockReportResponse } from '../types';

const MOCK_RESPONSES: MockResponse[] = [
  {
    tables: ['billing', 'customer', 'department', 'sales_group'],
    sql: `SELECT
  DATE_FORMAT(b.bill_date, '%Y-%m') AS month,
  c.name AS customer_name,
  d.dept_name AS department,
  sg.group_name AS sales_group,
  SUM(b.amount) AS total_amount
FROM billing b
JOIN customer c ON b.customer_id = c.customer_id
JOIN department d ON c.department_id = d.department_id
JOIN sales_group sg ON b.sales_group_id = sg.sales_group_id
GROUP BY month, customer_name, department, sales_group
ORDER BY month DESC, total_amount DESC`,
    explanation: '已为您分析需求，需要关联 billing、customer、department、sales_group 四张表。通过 JOIN 关联后按月、客户、部门、销售组进行金额聚合统计。已在画布上创建对应的表节点和 SQL 节点。',
    outputColumns: ['month', 'customer_name', 'department', 'sales_group', 'total_amount'],
  },
  {
    tables: ['billing', 'customer', 'region'],
    sql: `SELECT
  r.region_name,
  COUNT(DISTINCT c.customer_id) AS customer_count,
  SUM(b.amount) AS total_amount,
  AVG(b.amount) AS avg_amount
FROM billing b
JOIN customer c ON b.customer_id = c.customer_id
JOIN region r ON c.region_id = r.region_id
GROUP BY r.region_name
ORDER BY total_amount DESC`,
    explanation: '按区域统计客户账单，需要 billing、customer、region 三张表。',
    outputColumns: ['region_name', 'customer_count', 'total_amount', 'avg_amount'],
  },
  {
    tables: ['billing', 'payment'],
    sql: `SELECT
  DATE_FORMAT(b.bill_date, '%Y-%m') AS month,
  SUM(b.amount) AS billed,
  SUM(p.amount) AS paid,
  SUM(b.amount) - SUM(p.amount) AS outstanding
FROM billing b
LEFT JOIN payment p ON b.bill_id = p.bill_id
GROUP BY month
ORDER BY month DESC`,
    explanation: '统计每月账单与收款情况，需要 billing 和 payment 表。',
    outputColumns: ['month', 'billed', 'paid', 'outstanding'],
  },
];

export function matchQuery(input: string): MockResponse {
  const lower = input.toLowerCase();
  if (lower.includes('区域') || lower.includes('region')) {
    return MOCK_RESPONSES[1];
  }
  if (lower.includes('收款') || lower.includes('付款') || lower.includes('payment')) {
    return MOCK_RESPONSES[2];
  }
  return MOCK_RESPONSES[0];
}

export function generateDataFrame(_sqlNodeId: string): MockDataFrameResponse {
  void _sqlNodeId;
  const months = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05'];
  const customers = ['张伟科技', '李明集团', '王芳实业', '赵强网络', '陈静商贸', '刘洋物流', '周杰传媒', '吴敏金融'];
  const departments = ['华东大区', '华南大区', '华北大区', '西南大区'];
  const groups = ['A组', 'B组', 'C组', 'D组'];

  const previewData: Record<string, unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    previewData.push({
      month: months[i % months.length],
      customer_name: customers[i % customers.length],
      department: departments[i % departments.length],
      sales_group: groups[i % groups.length],
      total_amount: Math.round((Math.random() * 500000 + 10000) * 100) / 100,
    });
  }

  return {
    dfName: 'df_bill_agg',
    sourceName: 'hive://dw_primary',
    totalRows: 245,
    totalColumns: 5,
    memoryUsage: '38.2 KB',
    columns: [
      { name: 'month', nonNull: 245, dtype: 'object' },
      { name: 'customer_name', nonNull: 245, dtype: 'object' },
      { name: 'department', nonNull: 245, dtype: 'object' },
      { name: 'sales_group', nonNull: 245, dtype: 'object' },
      { name: 'total_amount', nonNull: 245, dtype: 'float64' },
    ],
    previewData,
  };
}

let nodeIdCounter = 0;
export function nextId(prefix: string): string {
  nodeIdCounter++;
  return `${prefix}-${nodeIdCounter}`;
}

export function resetIdCounter() {
  nodeIdCounter = 0;
}

export function generateReport(
  refs: { label: string }[],
  content: string
): MockReportResponse {
  const lower = content.toLowerCase();
  const isCorrelation = lower.includes('相关') || lower.includes('correlation');

  if (isCorrelation) {
    return {
      reportType: 'correlation',
      title: '相关性分析报告',
      content: `## DataFrame 相关性分析

**数据源**: ${refs.map((r) => r.label).join(' vs ')}

### Pearson 相关系数矩阵

- total_amount 与 billed: **0.96** (强正相关)
- total_amount 与 paid: **0.89** (强正相关)
- billed 与 outstanding: **0.42** (中等正相关)

### 关键发现

1. **total_amount 与 billed 高度相关** (r=0.96)，说明账单金额能有效预测应收额度，业务流程一致性强。
2. **paid 相关性偏弱** (r=0.89)，存在约 11% 的回款偏差，可能与客户付款周期有关。
3. **outstanding 与其他指标呈中等相关**，建议关注逾期账龄超过 60 天的异常记录。

### 建议

- 对 outstanding > 50,000 的客户进行回款催收跟踪
- 按 department 维度拆分相关性，排查是否存在区域性差异`,
    };
  }

  return {
    reportType: 'diff',
    title: '差异比较报告',
    content: `## DataFrame 差异比较

**数据源**: ${refs.map((r) => r.label).join(' vs ')}

### 结构差异

| 维度 | ${refs[0]?.label || 'A'} | ${refs[1]?.label || 'B'} |
|------|------|------|
| 行数 | 245 | 238 |
| 列数 | 5 | 5 |
| 内存 | 38.2 KB | 36.7 KB |

### 数据差异摘要

- **新增记录**: 12 条 (主要来自 2024-04 华东大区)
- **缺失记录**: 5 条 (2024-01 西南大区 B组 已被移除)
- **变更记录**: 23 条 (total_amount 值变化超过 5%)

### 主要变动

1. 张伟科技 2024-03 金额从 ¥128,450 调整为 ¥142,800 (+11.2%)
2. 李明集团 华南大区 新增 B组 业务线
3. 西南大区整体金额下降 8.3%，可能与季节性因素有关

### 结论

差异主要集中在华东大区的新增业务和西南大区的缩减，整体偏差率 **3.1%**，在可接受范围内。`,
  };
}
