# X23 verification：命令、真实输出与验收对照

环境：Windows Git Bash，node v24.16.0；分支 `chenxinma/x23-ci-dashboard-baseline`（基于 main `2a9e71e`）。
所有输出为**主会话亲自执行的真实结果**（非转述）。

## 1. 看板 9 项实测矩阵

统一命令形态（`ASSERTION_DASHBOARD_BASELINE` 为测试钩子，CI 不设）：

```bash
D=.github/workflows/scripts/assertion-dashboard.mjs
L=/tmp/x23-verify.log                      # 本次 npm run verify 的真实日志
ASSERTION_DASHBOARD_BASELINE=<path> node $D $L
```

| # | 场景 | exit | 真实 `::warning` 条数 | 关键输出 |
|---|---|---|---|---|
| ① | **仓库基线（正常路径，win32）** | 0 | **0** | 12 行全 `✅ ok`（9 子脚本 + `script total 671｜671` + `verify:integration 20 files / 278 tests` + `verify:ui 4 files / 37 tests`） |
| ② | 基线文件不存在 | 0 | 1 | `baseline unavailable (cannot read …/nope.json (ENOENT…)); reporting actual values only, no comparison`；表格 11 行实际值，期望列 `— (no baseline)` |
| ③ | 基线 JSON 损坏（`{ broken`） | 0 | 1 | `baseline unavailable (… is not valid JSON …)` |
| ④ | `verificationBaseline` 字段缺失 | 0 | 1 | `baseline unavailable (… has no verificationBaseline object)` |
| ⑤ | **故意造漂移**（`verify:export` 148→147、总量 670） | 0 | 2 | `verify:export: expected 147, got 148`；`script total: expected 670 on win32, got 671`；行内 `⚠️ drift — above baseline (merged test additions? update verificationBaseline)` |
| ⑥ | **声明总量自检**（`scriptTotalWindows=999`） | 0 | 1 | `verificationBaseline.scriptTotalWindows (999) != sum(scripts) (671); using sum(scripts)`；`script total｜671｜671｜✅ ok` ← 证明比对用 `sum(scripts)` 而非声明值 |
| ⑦a | 未给日志路径 | 0 | 1 | `no verify log path given; dashboard skipped` |
| ⑦b | 日志文件不可读 | 0 | 1 | `cannot read verify log (ENOENT…); dashboard skipped` |
| ⑧ | **platformSkip 通用性**（注入 `platformSkip.win32."verify:cwd"=7`） | 0 | 2 | `verify:cwd｜6｜13｜⚠️ drift`、`script total｜664｜671`、页脚 `platform win32: verify:cwd caseDrift gate SKIPs 7 assertions by design → expected script total 664 (Windows baseline 671)` ← 平台差值算法通用（ubuntu 走的正是这条：671−7=664） |
| ⑨ | 形状非法（`scripts["verify:export"]="many"`） | 0 | 1 | `baseline unavailable (verificationBaseline.scripts["verify:export"] is not a non-negative integer)` |

**结论**：① 刷新后**零漂移告警**（本任务要解决的 6 条 warning 全部消除）；②③④⑨ 四条降级路径均
「单条 warning + 只报实际值 + exit 0」，基线缺失不貌似漂移；⑤⑧ 漂移与平台差值仍能精确检出且**只 warn 不红**；
⑥ 自检生效；⑦ 输入缺失安全跳过。**9 项全部 exit 0**——看板不可能令 job 变红。

> 注：`grep -c "::warning"` 会把 markdown 页脚里字面出现的 `` `::warning::` `` 也数进去，
> 上表统计的是**行首** `^::warning`（真实 annotation），① 因此为 0 而非 1。

## 2. 验证门槛（合并前本地复跑）

| 门槛 | 结果 |
|---|---|
| `npm run build` | exit **0** |
| `npm run lint` | exit **0**（`eslint .` 覆盖改动后的 `.mjs`，零告警） |
| `npm run verify` | exit **0** |
| 脚本断言合计 | **671**（92 / 71 / 119 / 148 / 39 / 54 / 77 / 13 / 58，与 `verificationBaseline.scripts` 逐项一致） |
| `verify:integration` | **20 文件 / 278 例** passed |
| `verify:ui` | **4 文件 / 37 例** passed |
| verify 全跑后 `git status --porcelain` | 仅本任务改动文件（无 verify 残留） |

断言数**零增删**：本任务只改 CI 观测件与基线数据，不动任何 verify 脚本断言。

## 3. 真实 run 证据（PR #44 的 CI，2026-11-15 已回填）

PR #44 head `72b2b98`，run **43664705420**（`build + lint + verify` **pass**，1m22s，ubuntu-24.04）：

- [x] **annotations 条数 = 0**（修复前对照：run `9ce7878` 有 **6 条**基线漂移 warning）
      ——`gh api repos/.../check-runs/<id>/annotations | jq length` → `0`
- [x] **ubuntu 口径实测吻合**：从 run 日志逐脚本取值 `92 / 71 / 119 / 148 / 39 / 54 / 77 / **6** / 58`
      = **664** = `verificationBaseline` 的 `671 − platformSkip.linux."verify:cwd"(7)`，平台差值建模正确
      （`verify:cwd` 在 ubuntu 打印 SKIP 后为 6 项，非漂移）
- [x] 看板步骤正常执行并 `dashboard: written to $GITHUB_STEP_SUMMARY`，无 warning 输出
- [x] required check 名仍为 `build + lint + verify`，run 结论 success
- [x] step summary 页脚基线来源为 `docs/task-plan.json → verificationBaseline`（Summary 正文为 GitHub UI-only，
      API 不可取；可在 run 页面的 Job Summary 直接查看表格）

## 4. 验收对照

| acceptance（task-plan crossCutting[X23]） | 证据 |
|---|---|
| 看板基线单一事实源为 `docs/task-plan.json`（脚本内不再硬编码数字） | §1 ①（读仓库基线零告警）；脚本内已无 `BASELINE_*` / `CWD_LINUX_SKIP` 常量（`grep -n "671\|278\|= 7" .github/workflows/scripts/assertion-dashboard.mjs` 无命中） |
| 刷新后真实 run 无基线漂移 warning | 本地 §1 ① 零告警；**真实 run 43664705420 annotations = 0**（§3） |
| 看板失败/基线缺失均不阻断（job 绿） | §1 ②③④⑦⑨ 全部 exit 0 + 单条 warning；⑤⑧ 漂移亦 exit 0；workflow 侧 `continue-on-error: true` 双保险未动 |
| required check 名不变 | `ci.yml` 仅改注释，`name: build + lint + verify` 未动 |
| build/lint/verify 全绿且断言数与刷新后基线一致 | §2（671 / 20·278 / 4·37 与 `verificationBaseline` 逐项相符） |
| 走 GitHub PR（用户合并） | 分支已推、PR 由主会话创建、用户合并 |
