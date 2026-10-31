# BUGFIX：jq 摘要管道丢 column_info 致 DataFrame 节点无列结构

## 现象
会话 `2026-10-31T15-47-31` 中 `top3_products_by_sales` 节点：列结构表为空、Manifest 无校验和（`checksum: null`），但 `totalRows/totalColumns` 正常（3×3）。

## 根因
加载命令带 jq 摘要管道：
```bash
govio-cli observe load ... 2>&1 | jq '{success, error, name, rows, columns}'
```
投影保留 `success/rows/columns` 但**丢掉 `column_info`**。`handleLoadResult` 判定输出可信（success:true）后直接采用，`mapColumnInfo(parsed.column_info || parsed.schema || [], …)` 得空数组 → 节点无列结构；`buildManifest` 因列信息为空不产出校验和（T1.1 设计：空 schema 不哈希，避免假漂移），漂移检测退化为行/列数对比。

该 jq 配方正是 security 修复/X5 为保留失败信号推荐的版本——修了失败信号洞，漏了列结构洞。

## 修复（双层）
1. **服务端回补**（`server/extensions/govio-canvas.ts`）：新增导出纯函数 `enrichLoadOutput(load, info)`——可信 load 输出缺 `column_info`/`schema` 时，用 `readObserveInfo`（observe info）的列结构回补，行/列数仍以 load 输出为准；`handleLoadResult` 在可信且缺列信息时调用。
2. **配方修正**（AGENTS.md SQL 生成纪律第 5 条）：jq 投影改为 `{success, error, name, rows, columns, column_info}`（列结构是元数据非数据行，体积小），并注明不得省略 column_info 的原因。

## 回归断言（verify-manifest-roundtrip.ts +5，共 92 项）
- 摘要缺 column_info 时用 info 补列结构；行/列数以 load 为准
- load 自带 column_info 时不采用 info；info 为 null 原样返回；info 仅 schema 键也能补

## 验证
build ✓ · lint 0 · tsc（含 scripts）0 · verify 聚合 manifest 92 / rerun 71 / audit 97 / export 126 / source-table 39 全绿。

## 遗留
- 用户级 addendum 的 jq 配方同步更新（主 session 提请用户）
- 历史已建的无列节点不回填（重跑/重建即恢复）
