# X5 验证记录

> 环境：Windows Git Bash · Node v24.16.0 · 分支 feature/phase2-semantic-layer
> 门槛：npm run build、npm run lint、npm run verify 全绿；verify 全跑后 git status --porcelain 无验证残留。

## 门槛命令与结果

| 命令 | 结果 |
|---|---|
| `npm run build` | ✓ tsc 三工程（app/node/scripts）+ Vite 构建通过（仅既有 chunk 体积警告） |
| `npm run lint` | ✓ eslint 0 error 0 warning |
| `npm run verify` | ✓ 聚合全绿（下表） |
| verify 全跑后 `git status --porcelain` | ✓ 仅本任务变更文件，无验证残留产物 |

## verify 聚合断言数（不得回归）

| 脚本 | 改前 | 改后 | 说明 |
|---|---|---|---|
| verify:manifest | 61 | **87** | +26：新增 [6] 节共享校验器五种输入分类回归；既有 61 项零改动、全部通过（含 isTrustworthyLoadOutput 导出契约 6 项、success:false 事件流 1 项） |
| verify:rerun | 71 | 71 | parseLoadOutput/extractLoadError 换共享校验器后行为断言原样通过（含 extractLoadError 透传 4 项、success:false → outcome=error 等） |
| verify:audit | 97 | 97 | 不受影响 |
| verify:export | 126 | 126 | 不受影响 |
| verify:source-table | 39 | 39 | T2.0 契约不受影响 |

## 关键断言摘录（[6] 节，五种输入分类矩阵）

- jq 全 null 投影：schema 合法（null 宽容）· 非显式失败 · **不可信（回退复核，BUGFIX 修复未放松）** ·
  parseLoadOutput 保持现行为（0 行结果）· extractLoadError null
- success:false：schema 合法 · isLoadFailure 拦截 · parseLoadOutput null · extractLoadError 透传
  「Table dim_product does not exist」
- 截断输出（非法 JSON）：parse null · 不可信 · parseLoadOutput null · extractLoadError null（通用文案兜底）
- 成功全量载荷：可信 · source_tables 保留（--memory 血缘）· parseLoadOutput 映射 12 行/2 列/列名正确
- 成功 jq 摘要（数值 rows）：可信 · parseLoadOutput 用 columns 字段兜底列数
- 新能力：`rows:"twelve"` 类型漂移被拒 · 非对象 JSON（数组）被拒 · 未知额外字段不误杀（宽松契约）

## typebox 契约预检（实现前探针，npx tsx）

`Value.Check` 行为确认：显式 null 联合通过 ✓ · 额外属性通过（开放对象）✓ · 类型漂移/数组/标量/null 拒绝 ✓
——支撑「宽松可选字段 + 类型严格」的契约设计（design.md §3.1）。

## 交付物

- docs/tasks/X5-sql-discipline/{design.md, CHANGES.md, verification.md}
- commit：`X5: SQL 生成纪律与 CLI 输出契约加固`
