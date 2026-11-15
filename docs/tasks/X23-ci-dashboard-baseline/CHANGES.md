# X23 CHANGES：文件清单与每处摘要

分支 `chenxinma/x23-ci-dashboard-baseline`（基于 main `2a9e71e`）。

## 代码 / CI

- **`.github/workflows/scripts/assertion-dashboard.mjs`**（核心改动，整体重写基线加载部分）
  - 删除脚本内全部硬编码基线常量：`BASELINE_SCRIPTS_WINDOWS`、`CWD_LINUX_SKIP`、`BASELINE_VITEST`
  - 新增 `loadBaseline()`：从 `docs/task-plan.json → verificationBaseline` 读取 + 形状校验
    （`scripts` / `vitest` 每项非负整数、`platformSkip` 可选），任何失败返回 `{error}` 而**不抛异常**
  - 新增 `isPositiveInt()` 校验助手；路径解析改用 `fileURLToPath(new URL("../../../docs/task-plan.json", import.meta.url))`
    （不依赖 cwd；Windows/Linux 均可）
  - 新增 `ASSERTION_DASHBOARD_BASELINE` 环境变量覆盖（**测试钩子**，CI 不设）
  - `expectedScripts(baseline, platform)`：平台差值改为通用映射 `platformSkip[platform][script]`
    （原先写死「linux 的 verify:cwd 减 7」）
  - 新增**基线不可用降级分支**：一条 warning + 表格只列实际值（期望列 `— (no baseline)`、verdict `⚠️ missing`）
    + exit 0；不逐脚本报 expected/got（基线缺失不得貌似漂移）
  - 新增**声明总量自检**：`scriptTotalWindows != sum(scripts)` 时 warn 并以 `sum(scripts)` 为准
  - 漂移提示文案补行动指引：`above baseline (merged test additions? update verificationBaseline)`、
    新增 `below baseline (assertions removed?)`
  - 抽出 `writeSummary()`（正常路径与降级路径共用同一份 markdown 渲染），页脚基线来源改为
    `docs/task-plan.json → verificationBaseline`（single source, X23）；标题由「X16 assertion dashboard」
    改为「Assertion dashboard」；warning 标题由 `X16 assertion dashboard` 改为 `assertion dashboard`
  - 不变：恒 `process.exit(0)`、最外层 `try/catch`、四种 verify 小结格式解析、`splitSections` 分段逻辑

- **`.github/workflows/ci.yml`**（仅注释，无行为变更）
  - 「Assertion dashboard (non-gating)」步骤上方注释：基线来源改述为 `docs/task-plan.json → verificationBaseline`，
    平台口径更新为 `ubuntu 664 = 671 − 7`、`windows 671`，并写明「基线不可用时降级为只报实际值」
  - job 名 `build + lint + verify`、触发条件、concurrency、pin SHA、runner 钉版、`continue-on-error: true`
    双保险、`set -o pipefail`、工作树干净闸门：**全部未动**

## 数据

- **`docs/task-plan.json`**
  - 新增顶层 `verificationBaseline` 对象：`updatedAt` / `source` / `note`（口径与维护约定）/
    `scripts`（9 个子脚本，Windows 全量）/ `scriptTotalWindows: 671` / `platformSkip.linux."verify:cwd": 7` /
    `vitest`（`verify:integration` 20·278、`verify:ui` 4·37）
  - `crossCutting` 新增 **X23** 条目（scope/acceptance/history）；`updatedAt` 刷新

## 文档

- **`docs/tasks/X16-ci-maintenance/design.md`**：§8 遗留 1 追加「已由 X23 解决」并写明落地方式
- **`docs/tasks/X23-ci-dashboard-baseline/design.md`**：方案、schema、降级与自检设计、4 条取舍、验收对照、4 条遗留
- **`docs/tasks/X23-ci-dashboard-baseline/CHANGES.md`**：本文件
- **`docs/tasks/X23-ci-dashboard-baseline/verification.md`**：9 项本地实测矩阵（含真实输出）、门槛复跑、待真实 run 补录清单

## 未改动（明确声明）

- 业务代码、`src/`、`server/`、既有 `scripts/verify-*.ts` 断言与输出格式：**零改动**
- `package.json` / `package-lock.json`：**零改动**（无新依赖）
- required status check 名 `build + lint + verify`（ruleset 27209918）：**未动**
- 断言数本身：脚本 671 / vitest 20 文件 278 例 / UI 4 文件 37 例，与 main 一致（本任务不增删断言）
