# X16 验证记录

环境：Windows Git Bash，worktree `x16-ci-maintenance` @ 派发基线 `b5351b8`，Node v24.16.0。
真实 PR run 证据由主会话补录（§5）。

## 1. 门槛全绿 + 断言数零回归（最终态，含本任务新增文件）

```
npm run build  -> exit=0   （tsc -b / vite / esbuild，dist-server\cli.mjs 生成）
npm run lint   -> exit=0   （eslint 输出 36 字节 = 仅 npm 头，零告警；.mjs 不在 lint 范围）
npm run verify -> exit=0   （11 子脚本链全绿）
```

`verify` 小结行逐项（与派发基线 2026-11-14 完全一致，**零回归**）：

| 子脚本 | 实测 | 基线 | | 子脚本 | 实测 | 基线 |
|---|---|---|---|---|---|---|
| manifest | 92 | 92 | | caliber-conflict | 46/46 | 46 |
| rerun | 71 | 71 | | cwd | 13 | 13（Windows 全量口径） |
| audit | 119 | 119 | | prompt-injection | 58/58 | 58 |
| export | 138 | 138 | | **脚本合计** | **624** | **624** |
| source-table | 39 | 39 | | vitest integration | 15 文件/194 例 | 15/194 |
| semantic-lineage | 48 | 48 | | vitest ui | 4 文件/31 例 | 4/31 |

verify 跑完后 `git status --porcelain` 只含本任务文件（ci.yml 修改 + scripts/ 与三件套新增），无验证副产物。

## 2. 看板对真实日志（win32，624 口径）

`node .github/workflows/scripts/assertion-dashboard.mjs <verify.log>`（无 `GITHUB_STEP_SUMMARY` 时打
stdout）：13 行全部 `✅ ok`，`script total 624/624`，exit=0。表头平台行写明「full Windows baseline 624」。
`GITHUB_STEP_SUMMARY=<file>` 时表格追加进文件（seed 保留，`rg -c` 命中 1），stdout 只留一行进度注记。

## 3. 看板不阻断验证（acceptance「故意基线不符只出 warning/summary 不红」的本机等价）

- **故意漂移**：`sed` 把 manifest 92→91、删 caliber 小结行 → 表格出 `⚠️ drift` / `⚠️ missing (no known
  summary format)`，2 条 `::warning title=X16 assertion dashboard::…` 注解，**exit=0**（步骤不会红；
  workflow 侧另有 `continue-on-error: true` 双保险）。
- **缺日志 / 无参数**：各出 1 条 warning，**exit=0**。
- **内部异常**：main() 全体 try/catch → warning + `process.exit(0)`（代码走查 + 上述路径实测覆盖）。
- **ubuntu 617 口径**：临时副本 sed 强制 linux 分支 + 把 cwd 小结改为 `共 6 项` → `verify:cwd 6/6 ✅`、
  `script total 617/617 ✅`，SKIP 7 未报成漂移（表头写明 caseDrift 口径）。真实 ubuntu 证据待 §5。

## 4. Verify 步骤 tee 语义 + workflow 结构

- `bash -e -c 'set -o pipefail; node -e "process.exit(1)" | tee f'` → **exit=1**（失败仍红，门禁不受 tee
  削弱）；成功用例 exit=0 且日志落盘。等价于 GH 默认 `bash -e` + 步骤内显式 `set -o pipefail`。
- YAML 用仓库自带 `yaml` 包解析 + 结构断言：job 名 `build + lint + verify` **未变**；`runs-on:
  ubuntu-24.04`；`uses` 为两枚 pin SHA；仅 dashboard 步骤 `continue-on-error: true`；步骤顺序
  Verify → Dashboard → 工作树清洁检查；concurrency 配置与触发器不变。
- pin SHA 取证：`git ls-remote --tags` 官方仓（v7.0.1/v7.1.0 轻量 tag=commit）+ `--depth 1` clone 后
  `rev-parse HEAD` 相等 + `action.yml` 断言 `using: node24`、所用输入存在。详 design.md §2.1。

## 5. 主会话补录（真实 PR 证据，2026-11-14 已回填）

- [x] PR 号与分支：**PR #36**（`chenxinma/x16-ci-maintenance`，用户合并，merge `249e840`）
- [x] ANNOTATIONS 对比：合并态 run **43565464841**（success，57s）check-run **annotations 为零**、
      日志全文无 `Node.js 20` / `ubuntu-latest` 警告（对比旧证据 run 43242165890 / 43461685410 的两条注解）——弃用警告消失 ✅
- [x] 看板真实输出：dashboard 步骤 `dashboard: written to $GITHUB_STEP_SUMMARY`（Summary 正文为 UI-only，
      API 不可取）；断言数口径经 run 日志逐脚本核对：92/71/119/138/39/48/46/**6**/58 = **617**
      （`verify:cwd` 打印 `SKIP：当前平台/文件系统无法构造大小写漂移` → 6 项），与看板 ubuntu 基线建模一致 ✅
- [x] 看板不红：PR 验证阶段已用故意篡改基线（92→91、删 caliber 小结）实测只出 ⚠️ + `::warning::` 且 exit=0；
      真实 run 无需再造漂移（非门禁性质已双保险证明）
- [x] tee 耗时：合并态 run 全程 57s（含 npm ci / build / lint / verify / dashboard / clean 检查），无可见回退
