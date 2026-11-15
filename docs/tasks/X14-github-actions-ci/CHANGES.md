# X14 变更清单

单次 commit：`X14: GitHub Actions CI 门禁（build + lint + verify）`。分支 `chenxinma/x14-ci-gate`。

## 新增文件（4 个，本任务只新增，不改动任何既有文件）

| 文件 | 行数 | 摘要 |
|---|---|---|
| `.github/workflows/ci.yml` | 68 | 唯一的交付实体：仓库首个 CI 配置（此前无 `.github/` 目录，也无 circle/travis/gitlab 等任何 CI 配置） |
| `docs/tasks/X14-github-actions-ci/design.md` | — | runner 选型、registry 取舍、Node/缓存/超时策略、步骤拆分原则、分支保护交接、9 条遗留问题 |
| `docs/tasks/X14-github-actions-ci/CHANGES.md` | — | 本文件 |
| `docs/tasks/X14-github-actions-ci/verification.md` | — | 本机等价验证 + clean checkout 实测 + 坏例反向验证与还原证据 + 断言数逐项对照 + 待主会话补录清单 |

## `.github/workflows/ci.yml` 逐块说明

| 块 | 内容 | 为什么这样写 |
|---|---|---|
| `name: CI` | workflow 显示名 | 分支保护里勾选的是 **job 名** `build + lint + verify`，不是这个（design.md §7 写清了两者区别） |
| `on.pull_request.types: [opened, synchronize, reopened]` | 显式列出三种类型 | 关键项是 `synchronize`：解冲突/追加 commit 后必须重跑；显式写出来避免日后被误窄化成只 `opened` |
| `on.push.branches: [main]` | main push 也跑 | 门禁之外的「合并后兜底」：直接 push 到 main 的记账类 commit（AGENTS.md 允许文档类直推）也会被复检 |
| `on.workflow_dispatch: {}` | 手动触发 | 让用户/主会话能在不 push 的情况下对任意分支单独复检（首次真实运行观察、排查用） |
| `permissions: contents: read` | 最小权限 | 门禁只读代码，不需要写/令牌权限 |
| `concurrency.group` = `github.workflow` + PR 号或 ref，`cancel-in-progress: true` | 同 PR 新 push 取消旧 run | 省额度，且避免旧 run 的结论被误读成当前结论 |
| `jobs.ci.name: build + lint + verify` | job 名即 check 名 | 见 design.md §7 第 4 步 |
| `runs-on: ubuntu-latest` | 单 runner | `verify:cwd` 的 `caseDrift` 闸门会 SKIP 7 项（605 vs 本机 612）；取舍与逐项差值见 design.md §3 / verification.md 对照表 |
| `timeout-minutes: 20` | 超时余量 | 本机三门槛实测 190s + clean `npm ci` 154s，留约 6x 余量 |
| step `Checkout` = `actions/checkout@v4` | — | major tag（pin SHA 属遗留问题 6） |
| step `Setup Node 24` = `actions/setup-node@v4` + `node-version: "24"` + `cache: npm` | 与本机 v24.16.0 同大版本；按 lockfile 哈希缓存 `~/.npm` | Vite 8 要求 Node ≥20.19/22.12；`package.json` 无 `engines`，故版本约定放在 workflow 侧 |
| step `Use public npm registry for lockfile tarballs` | `npm config set registry https://registry.npmjs.org` + `npm config set replace-registry-host always` | lockfile 的 1160/1178 条 `resolved` 指向 npmmirror（本机镜像）。不改 lockfile，只让 npm 在拉包时把 host 换成公共 registry；冷缓存 micro 实测证明 `always` 确实改写请求 URL（见 design.md §4）。`registry-url` 输入做不到这点 |
| step `Install (npm ci)` = `npm ci --no-audit --no-fund` | 不加 `--ignore-scripts` | 与本机口径一致；audit/fund 是纯网络噪声。esbuild/rollup/tailwind oxide/lightningcss 的 linux-x64 平台包在 lockfile 里齐备（已核对），`npm ci` 能装全 |
| step `Build` / `Lint` / `Verify` 三步分开 | `npm run build` / `npm run lint` / `npm run verify` | 失败点可定位；无 `continue-on-error`、无 `|| true`、无 `tee` 管道吞退出码 |
| step `Verify left the working tree clean` | `git status --porcelain` + `test -z "$(...)"` | 对齐 AGENTS.md worker 完成定义；顺带守住「脚本在 runner 上误写受跟踪文件」 |

## 未改动（范围纪律）

- 业务代码、`scripts/verify-*.ts`、`tests/**`、`package.json` scripts、`package-lock.json`、
  `tsconfig*.json`、`vitest.config.ts`、`.gitignore`、`docs/task-plan.json` 全部零改动
- X13 并行分支正在碰的文件（`SourceTableNode.tsx` / `src/utils/lineage.ts` /
  `src/utils/export-report.ts` / `scripts/verify-export-report.ts` / `tests/ui/*`）未触碰
- `.agents/`（skills，gitignore 内容）与 `node_modules/`、`dist/`、`dist-server/` 不入库
- 未 push、未建 PR、未切分支、未合并；分支保护开关留给用户在 GitHub 侧操作

## 过程中临时改过并已完全还原的文件

- `src/store/canvas-store.ts`：坏例反向验证时把第 6 行的 `lineageEdge` 导入删掉（复现
  `docs/tasks/BUGFIX-lineage-edge-import.md`），验证 build/verify 变红后 `git checkout --` 还原；
  最终 `git diff` 为空、`git status --porcelain` 干净（证据见 verification.md §3）