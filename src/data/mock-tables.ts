import type { MockTable } from '../types';

export const MOCK_TABLES: MockTable[] = [
  {
    tableName: 'billing',
    database: 'govio_dw',
    rowCount: 12340,
    fields: [
      { name: 'bill_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '账单ID' },
      { name: 'customer_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'customer', field: 'customer_id' }, description: '客户ID' },
      { name: 'sales_group_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'sales_group', field: 'sales_group_id' }, description: '销售组ID' },
      { name: 'amount', type: 'DECIMAL(12,2)', nullable: false, description: '账单金额' },
      { name: 'bill_date', type: 'DATE', nullable: false, description: '账单日期' },
      { name: 'due_date', type: 'DATE', nullable: true, description: '到期日期' },
      { name: 'status', type: 'VARCHAR(20)', nullable: false, description: '状态' },
    ],
  },
  {
    tableName: 'customer',
    database: 'govio_dw',
    rowCount: 2450,
    fields: [
      { name: 'customer_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '客户ID' },
      { name: 'name', type: 'VARCHAR(100)', nullable: false, description: '客户名称' },
      { name: 'region_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'region', field: 'region_id' }, description: '区域ID' },
      { name: 'department_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'department', field: 'department_id' }, description: '部门ID' },
      { name: 'tier', type: 'VARCHAR(20)', nullable: true, description: '客户等级' },
      { name: 'created_at', type: 'TIMESTAMP', nullable: false, description: '创建时间' },
    ],
  },
  {
    tableName: 'department',
    database: 'govio_dw',
    rowCount: 45,
    fields: [
      { name: 'department_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '部门ID' },
      { name: 'dept_name', type: 'VARCHAR(100)', nullable: false, description: '部门名称' },
      { name: 'manager', type: 'VARCHAR(50)', nullable: true, description: '负责人' },
      { name: 'cost_center', type: 'VARCHAR(20)', nullable: true, description: '成本中心' },
    ],
  },
  {
    tableName: 'sales_group',
    database: 'govio_dw',
    rowCount: 120,
    fields: [
      { name: 'sales_group_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '销售组ID' },
      { name: 'group_name', type: 'VARCHAR(100)', nullable: false, description: '组名' },
      { name: 'department_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'department', field: 'department_id' }, description: '所属部门' },
      { name: 'leader', type: 'VARCHAR(50)', nullable: true, description: '组长' },
    ],
  },
  {
    tableName: 'product',
    database: 'govio_dw',
    rowCount: 580,
    fields: [
      { name: 'product_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '产品ID' },
      { name: 'product_name', type: 'VARCHAR(200)', nullable: false, description: '产品名称' },
      { name: 'category', type: 'VARCHAR(50)', nullable: true, description: '分类' },
      { name: 'unit_price', type: 'DECIMAL(10,2)', nullable: false, description: '单价' },
    ],
  },
  {
    tableName: 'billing_item',
    database: 'govio_dw',
    rowCount: 35600,
    fields: [
      { name: 'item_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '明细ID' },
      { name: 'bill_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'billing', field: 'bill_id' }, description: '账单ID' },
      { name: 'product_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'product', field: 'product_id' }, description: '产品ID' },
      { name: 'quantity', type: 'INT', nullable: false, description: '数量' },
      { name: 'subtotal', type: 'DECIMAL(12,2)', nullable: false, description: '小计' },
    ],
  },
  {
    tableName: 'region',
    database: 'govio_dw',
    rowCount: 32,
    fields: [
      { name: 'region_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '区域ID' },
      { name: 'region_name', type: 'VARCHAR(50)', nullable: false, description: '区域名称' },
      { name: 'country', type: 'VARCHAR(50)', nullable: false, description: '国家' },
      { name: 'timezone', type: 'VARCHAR(30)', nullable: true, description: '时区' },
    ],
  },
  {
    tableName: 'payment',
    database: 'govio_dw',
    rowCount: 11800,
    fields: [
      { name: 'payment_id', type: 'INT', nullable: false, isPrimaryKey: true, description: '付款ID' },
      { name: 'bill_id', type: 'INT', nullable: false, isForeignKey: true, references: { table: 'billing', field: 'bill_id' }, description: '账单ID' },
      { name: 'amount', type: 'DECIMAL(12,2)', nullable: false, description: '付款金额' },
      { name: 'payment_date', type: 'DATE', nullable: false, description: '付款日期' },
      { name: 'method', type: 'VARCHAR(30)', nullable: true, description: '付款方式' },
    ],
  },
];
