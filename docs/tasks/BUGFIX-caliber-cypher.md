# BUGFIX-caliber-cypher：sql caliber 真实图库集成缺陷（验收后发现）

- **发现**：2026-11-07，T2.3 合并态验收（govio PR #14 已并入 main，对应 0.7.1）做 E2E 冒烟时发现。
  worker 的 pytest 全部走 stub graph，**没有覆盖真实 Ladybug 路径**。
- **现象**：`govio-cli sql caliber --sql ... --metric m_sales_amount` 抛
  `Binder exception: Cannot find property :ID(Metric) for m.`；修复后又暴露
  `Parser exception: Invalid input <c.column>`。
- **根因**（两处，均违反「属性名以 schema.md 为准」的 Cypher 纪律）：
  1. `_read_metric_cypher` 的 RETURN 里写了 `m.\`:ID(Metric)\``——CSV 装载列名被当成图库属性；
  2. `c.column` 的 `column` 是 Cypher 保留字，未反引号。
- **修复**（govio 仓 `fix(caliber)` commit，直接进 main）：
  1. Cypher 只引用 schema.md 属性（`m.id`/`m.code`/...），id/code 双匹配语义不变；
  2. `` c.`column` `` 反引号；
  3. 测试 stub 加双回归护栏（`:ID(` 禁用、`c.\`column\`` 必须反引号）——**今后 stub 测试即拦截
     真实图库的属性名/保留字错误**。
- **E2E 实测**（装机 CLI + 真实图库 chocolate 域）：
  - `SUM(amount)` vs `m_sales_amount` → `unknown`（dimension_ref 列未引用属存疑，符合「宁可
    unknown 不误报」）；
  - `COUNT(order_id)` vs `m_sales_amount` → `conflict`（聚合签名不匹配 + 计量列缺失）；
  - 未知名指标 → `unknown` + 图谱未找到说明；
  - 输出 JSON 形状与 map 侧 `server/caliber-check.ts` parser 契约一致。
- **附带发现**（不在本 bugfix 范围）：
  - 源码 `uv.lock` 钉 ladybug 0.19.0（存储 v43），装机工具按 `>=0.19.0` 解析到新版（读写 v49），
    图库文件已升级——**源码 venv 无法对真实图库跑 E2E**（测试不受影响）。依赖升级留待版本发布时处理。
  - worktree 环境下 4 个「预存在失败」实为 gitignore 生成资产缺失的环境假象（主目录资产齐全时
    426 passed / 0 failed），T2.3/T2.4 验收记录中「clean-base 预存在」的定性以此为准。
- **对任务验收的影响**：T2.3 acceptance「冲突检测有 CLI 命令支撑」在修复后成立（真实图库三态
  验证通过）；修复随 0.7.1 之后的版本发布（本地装机已由 `uv tool install --force .` 刷新，版本号
  仍报 0.7.1）。
