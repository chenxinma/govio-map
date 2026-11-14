# X16 变更清单

分支 `chenxinma/x16-ci-maintenance`，单次 commit（`X16: ...`）。只动 `.github/workflows/` 与本三件套，
无业务代码/测试/package*/既有脚本改动。

## .github/workflows/ci.yml（修改）

- `actions/checkout@v4` → `actions/checkout@3d3c42e5...`（`# v7.0.1`，官方仓取证见 design.md §2.1）
- `actions/setup-node@v4` → `actions/setup-node@949feb24...`（`# v7.1.0`，同上）；`node-version: "24"`、
  `cache: npm` 不变
- `runs-on: ubuntu-latest` → `ubuntu-24.04`（design.md §3 钉版与升级策略）
- `Verify (11-script aggregate chain)` 步骤：`npm run verify` → `set -o pipefail` +
  `npm run verify | tee "$RUNNER_TEMP/verify.log"`（喂看板；pipefail 保住门禁退出码，本机验证见
  verification.md §3）
- 新增步骤 `Assertion dashboard (non-gating)`（`continue-on-error: true`，排在 Verify 后、工作树清洁检查前）
- 注释新增：X16 包头（指向 design.md）、concurrency push-main 取舍说明（行为不变）、required check 名
  禁止改动的警示（ruleset 27209918）
- 未动：触发器、permissions、concurrency 配置本身、timeout、registry 换 host 步骤、Install/Build/Lint、
  工作树清洁步骤、job 名 `build + lint + verify`

## .github/workflows/scripts/assertion-dashboard.mjs（新增）

断言数看板脚本（非门禁）。顶部常量=基线单一来源（派发基线 2026-11-14，main `b5351b8`，Windows 全量口径
624 / 15:194 / 4:31，含 `CWD_LINUX_SKIP = 7` 平台建模）。按 `> govio-map@x.y.z verify:<name>` 切段，解析四种
小结格式（`共 N 项断言，失败 M 项` / `N/N checks passed` / `N/N 通过` / vitest `Test Files`+`Tests`），
剥离 ANSI；输出 markdown 表到 `$GITHUB_STEP_SUMMARY`（本地无该环境变量时打 stdout），漂移/缺段/未知格式发
`::warning title=X16 assertion dashboard::…`；恒 `process.exit(0)`。取舍论证见 design.md §4。

## docs/tasks/X16-ci-maintenance/（新增三件套）

- `design.md`：四改动逐项取舍 + pin 维护策略（§2.2）+ Ubuntu 26 升级策略（§3）+ nightly 评估（§6，
  未实现）+ 遗留问题 5 条（§8）
- `CHANGES.md`：本文件
- `verification.md`：本机证据 + 待主会话补录位（§5）

## 未做（按任务书 §5/§4.5）

windows nightly 腿（仅评估）、task-plan.json 状态记账（主会话）、required check 改名、依赖引入、
merge queue / GitHub 设置侧操作。
