# X34 可用性测试 · Round 1（首个零环境试用）

> 测试者：Rachel WANG（零环境新机器）｜日期：2026-11-28｜版本：govio-map 0.8.0 + govio-cli 0.8.0
> 目标口径：TTFV ≤5 分钟（本地示例库）；全程 0 次聊天框粘贴凭据；SUS ≥ 68

## 1. TTFV 实测

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `npx govio-map` 安装 → 出入口地址 | **3 分 33 秒** | npx 冷缓存下载（plotly 等大依赖）为主要耗时 |
| 浏览器进入 → 图库初始化 + 数据源配置（chocolate.db）+ 元数据导入 → 开始第一个问题前 | **1 分 39 秒** | 首启向导全程 GUI，无卡点报告 |
| **TTFV 合计** | **≈ 5 分 12 秒** | 略超 5 分钟目标，瓶颈在 npx 下载而非向导（向导 1:39 远优于目标） |

- 聊天框粘贴凭据次数：**0**（目标达成；secret_redirect 未触发）
- 后续（导入表关系/指标定义）为 agent 对话式操作，未计入 TTFV

## 2. 发现缺陷（均为 govio-cli 0.8.0 侧，详见 `BUGFIX-govio-meta-rel-graph.md`）

1. **`meta rel` 与 `meta graph` 不兼容**：RELATES_TO.csv 表头带两个前置列 `source,target`
   （值恒为空），`meta graph` 导入报 `Binder exception: Table source does not exist`；
   端点列 `:START_ID(PhysicalTable),:END_ID(PhysicalTable)` 放最前可正常导入（已验证 3 条边入库）
2. **`--mode update` 旧库不兼容**：报 `Cannot find property node_id for n`（旧 lbdb 的
   PhysicalTable/Col 缺 `node_id` 属性，旧版 DDL 遗留）；`--mode rebuild` 全量重建可绕过

## 3. 绕行现场（测试机留档）

- `C:\Work\output\RELATES_TO.csv`：CLI 原样输出（未手改，遵守「不编辑 --output 下 CSV」）；
  重跑 `meta graph --output ./output` 会再次失败
- `/tmp/gtest2`：修正表头版本（端点列最前），可复现验证通过
- 原库备份：`C:\Users\Rachel WANG\.govio\ontology.lbdb.bak-143424`、`ontology.lbdb.old`
  （`--mode rebuild` 前）

## 4. 待补

- [ ] SUS 问卷（待测者填写）
- [ ] TTFV 复测（govio 缺陷修复 + govio-map 0.8.1 后，含 npx 暖缓存对照）
- [ ] 其余 3-4 名测试者冷启动数据
