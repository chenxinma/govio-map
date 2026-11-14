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

## 5. 待主会话补录（真实 PR 证据，本 worker 不 push/不开 PR）

- [ ] PR 号与分支：本 worktree `chenxinma/x16-ci-maintenance`（主会话推送开 PR）
- [ ] 改动前后 run 的 ANNOTATIONS 对比：**Node.js 20 deprecation 警告消失**（旧证据 run 43242165890 /
      43461685410 注解 vs 新 run），`ubuntu-latest` 迁移注解不再出现
- [ ] 看板真实输出：run 的 job Summary 表（预期 `platform linux ... expected script total 617`，
      cwd 6/6、其余与 §1 相同、vitest 15/194 + 4/31 全 ✅）；步骤日志注解区无 warning
- [ ] 看板不红的 run 级证据（可留待自然漂移或临时 commit 造一次）：dashboard 步骤 ⚠️ 但 job 绿
- [ ] `npm run verify` 经 tee 后 Install/Verify 步骤耗时变化（预期 <2s）
