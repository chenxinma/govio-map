# X14 验证记录

验证时间：2026-11-12（本机 Windows / Git Bash / node v24.16.0 / npm 11.18.0）
验证起点：`chenxinma/x14-ci-gate` @ `2839b68`（= main `ac8bab1` + 派发 commit），基线取任务书 §3
（主会话 2026-11-12 于 `ac8bab1` 实测：脚本 612 项 / vitest 14 文件 155 例 / UI 4 文件 21 例）。

## 1. workflow 静态校验

`actionlint` 本机没有、也无法在不污染依赖的前提下安装（`go` 在 PATH 上但 `go run
github.com/rhysd/actionlint/...` 需要拉模块；任务书要求「一次性、不写入 devDependencies」，故未采用）。
改为两条本地可执行的校验 + 一条「以真实运行为最终证据」的约定：

```
$ node <tmp>/yamllint.cjs .github/workflows/ci.yml .   # 用仓库已有 devDependency `yaml` 解析
name: CI
triggers: {"pull_request":{"types":["opened","synchronize","reopened"]},"push":{"branches":["main"]},"workflow_dispatch":{}}
permissions: {"contents":"read"}
concurrency: {"group":"${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}","cancel-in-progress":true}
job ci | runs-on: ubuntu-latest | timeout-minutes: 20
   - Checkout | uses: actions/checkout@v4
   - Setup Node 24 | uses: actions/setup-node@v4 | with: {"node-version":"24","cache":"npm"}
   - Use public npm registry for lockfile tarballs | run: npm config set registry ... + replace-registry-host always
   - Install (npm ci) | run: npm ci --no-audit --no-fund
   - Build (tsc -b + vite + esbuild) | run: npm run build
   - Lint (eslint) | run: npm run lint
   - Verify (11-script aggregate chain) | run: npm run verify
   - Verify left the working tree clean | run: git status --porcelain; test -z "$(git status --porcelain)"
STRUCTURE OK
```

脚本里同时断言并输出 `ERRORS`：无 `continue-on-error`（job 级与 step 级）、无 `|| true`。结果 0 项。
⇒ YAML 语法/结构、触发类型、步骤顺序与命令均按任务书 §4.1 落实；**语义级校验以 GitHub 上的首次真实
run 为准**（见 §6 待补录）。

## 2. clean checkout 实测（模拟 CI 的全新 runner）

做法：`git archive HEAD` 导出**受跟踪文件**（294 个文件，无 `node_modules`、无 `.git`）到
`%TEMP%/x14/clean`，即「干净 checkout」，然后按 workflow 的命令与顺序原样跑。

```
$ git archive --format=tar -o <tmp>/clean.tar HEAD      # 6,533,120 bytes
$ tar -xf clean.tar -C clean                            # 294 files（.agents/ 不在其中，CI 也不需要）
```

### 2.1 `npm ci`（用与 workflow 相同的 registry 配置）

```
$ cat <tmp>/ci.npmrc
registry=https://registry.npmjs.org
replace-registry-host=always
$ npm config list --userconfig=<tmp>/ci.npmrc | grep -Ei 'registry|replace-registry-host'
registry = "https://registry.npmjs.org"
replace-registry-host = "always"
$ npm ci --userconfig=<tmp>/ci.npmrc --no-audit --no-fund
added 518 packages in 3m
npm ci exit=0 elapsed=154s
du -sh node_modules -> 424M
```

用 `--userconfig` 指向临时 npmrc（而不是真的 `npm config set`）：**本机 `~/.npmrc` 未被改动**，
语义与 CI 上「写 runner 的 `~/.npmrc`」等价。

> 注：本机 `npm warn allow-scripts`（`@google/genai` / `esbuild` / `protobufjs` 的 install 脚本未被
> allowScripts 覆盖）是本机 global npmrc 策略产物，GitHub runner 无此策略。CI 未加 `--ignore-scripts`。

### 2.2 `replace-registry-host` 语义取证（冷缓存单包 micro 实测）

`node_modules/.package-lock.json` 的 `resolved` 字符串不足以判定行为（本机 `~/.npm` 已有同内容缓存，
命中缓存的条目沿用 lockfile 原值：509 条仍显示 npmmirror）。因此用**空缓存 + `--loglevel http`** 的
单包 fixture 直接看请求 URL：

```
fixture: ms@2.1.3，package-lock 的 resolved 照抄仓库值 https://registry.npmmirror.com/ms/-/ms-2.1.3.tgz

TEST A  registry=npmjs + replace-registry-host=always   exit=0
  npm http fetch GET 200 https://registry.npmjs.org/ms/-/ms-2.1.3.tgz 1651ms (cache miss)
  （日志里 npmmirror 出现次数：0）
TEST B  registry=npmjs + replace-registry-host=never    exit=0
  npm http fetch GET 200 https://cdn.npmmirror.com/packages/ms/2.1.3/ms-2.1.3.tgz 250ms (cache miss)
  （日志里 registry.npmmirror.com 1 次 + cdn.npmmirror.com 1 次）
```

⇒ 选定项（A）确实把 lockfile 的 tarball host 换成公共 registry；对照组（B）正是「原样不动」时
runner 会走的镜像 + 302 到 `cdn.npmmirror.com` 的形态。这是 design.md §4 不选「原样不动」的直接证据。

### 2.3 clean checkout 的 build → lint → verify（workflow 命令原样）

```
$ npm run build   -> build exit=0  elapsed=34s   （tsc -b 通过 / ✓ built in 2.71s / esbuild 产物生成）
$ npm run lint    -> lint exit=0  elapsed=9s    （零输出）
$ npm run verify  -> verify exit=0 elapsed=73s   （11 个子脚本全绿，断言见 §4 对照表）
```

> 首轮曾在 `%TEMP%` 下跑出 `build exit=1` / `verify exit=1`，原因是**沙箱限制**而非仓库问题：
> `esbuild.exe` 报 `Cannot read directory "../../../../..": Access is denied`，`tsx` 报
> `uv_os_get_passwd returned ENOMEM`。解除沙箱后同一条链全绿，记录在此以免误读。

## 3. 坏例反向验证（合并态缺陷必须红）

复现 `docs/tasks/BUGFIX-lineage-edge-import.md`：只删 `src/store/canvas-store.ts` 第 6 行的
`lineageEdge` 导入（调用点保持 main 侧），即 PR #29 冲突取错边的形态。

```diff
@@ -3,7 +3,7 @@ import { persist } from 'zustand/middleware';
-import { lineageEdge, withSemanticHandles } from '../utils/lineage';
+import { withSemanticHandles } from '../utils/lineage';
```

**build 变红**（exit=2，43s）——TS2304 每个 project 各报一次（`tsconfig.app` 与 `tsconfig.server`）：

```
src/store/canvas-store.ts(190,33): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(285,25): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(305,25): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(323,23): error TS2304: Cannot find name 'lineageEdge'.
src/store/canvas-store.ts(339,23): error TS2304: Cannot find name 'lineageEdge'.
（同样 5 行重复一次 = 2 个 tsconfig project）
```

> 与 BUGFIX 文档的差异：当年是 **×4**，现在是 **×5**——不是回归，而是 PR #31 之后 `canvas-store.ts`
> 多了一处 `lineageEdge("semantic", …)` 调用点（L339）。CI 关心的是「非零 + 定位到行」。

**verify 变红**（exit=1，62s）——崩在第 6 个子脚本，后续 5 个脚本 + vitest 全部未执行（与 BUGFIX 症状逐字一致）：

```
> govio-map@0.7.0 verify:semantic-lineage
C:\...\src\store\canvas-store.ts:323
        newEdges.push(lineageEdge("semantic", {
                 ^
ReferenceError: lineageEdge is not defined
    at Object.createGovioNode (src\store\canvas-store.ts:323:18)
    at create (scripts\verify-semantic-lineage.ts:236:31)
```

**还原证据**：

```
line 6 after restore:
import { lineageEdge, withSemanticHandles } from '../utils/lineage';
git diff bytes: 0
git status --porcelain: [?? .github/  ?? docs/tasks/X14-github-actions-ci/CHANGES.md  ?? docs/tasks/X14-github-actions-ci/design.md]
```

⇒ `git diff` 为空（0 字节），未跟踪项只有本任务的新增文件；还原后门槛重跑见 §5。
⇒ 结论：**门槛能抓住合并态缺陷**。CI 在真实 PR 上「红一次」的证据由主会话推分支后补录（§6）。
## 4. 断言数逐项对照（本机基线 ↔ clean checkout 实测 ↔ ubuntu CI 预期）

| 子脚本 | 派发基线（main `ac8bab1`，Windows） | clean checkout 实测（Windows, §2.3） | worktree 实测（Windows, §5） | ubuntu CI 预期 | 差值与原因 |
|---|---|---|---|---|---|
| `verify:manifest` | 92 | 92（失败 0） | 92 | 92 | 无 |
| `verify:rerun` | 71 | 71 | 71 | 71 | 无（默认 mock runner；`[6] 真实 CLI 链路：跳过` 是脚本既有提示，不计入断言，CI 不开 `--real`） |
| `verify:audit` | 119 | 119 | 119 | 119 | 无 |
| `verify:export` | 126 | 126 | 126 | 126 | 无（未传 `--write`，产物落临时目录，受跟踪的 sample-export.html 不动） |
| `verify:source-table` | 39 | 39 | 39 | 39 | 无 |
| `verify:semantic-lineage` | 48 | 48 | 48 | 48 | 无（日志里 `caliber CLI disabled in verify:semantic-lineage` 是预期降级断言） |
| `verify:caliber-conflict` | 46 | 46/46 checks passed | 46/46 | 46 | 无（`spawn ENOENT` 类日志属 stub 降级的预期断言） |
| `verify:cwd` | 13 | 13 | 13 | **6** | **-7**：脚本用 `caseDrift` 平台闸门（`scripts/verify-cwd-normalize.ts:72`），只有能构造大小写漂移的文件系统才跑这些断言；Linux 大小写敏感 → 打印 `- SKIP：当前平台/文件系统无法构造大小写漂移…`。逐项：[1] 1 项（L86）、[2] 3 项（L102/107/109）、[3] 1 项（L118）、[4] 2 项（L125/127）。**不改脚本断言/判定来凑数**，只如实记差值 |
| `verify:prompt-injection` | 58 | 58/58 通过 | 58/58 | 58 | 无（「真实会话抽样」读 `<cwd>/.govio/sessions`，runner 上无 `.govio` → 跳过且本就**不计入断言**，属信息性输出） |
| **脚本合计** | **612** | **612**（失败 0） | **612**（失败 0） | **605** | **-7，全部来自 `verify:cwd` 的 caseDrift 闸门** |
| `verify:integration`（`vitest run`） | 14 文件 / 155 例 | 14 / 155 | 14 / 155（Duration 23.53s） | 14 / 155 | 无平台差值（include = `tests/integration/**/*.test.ts` + `tests/ui/**/*.test.tsx`，故含 UI 4 文件） |
| `verify:ui`（`vitest run tests/ui`） | 4 文件 / 21 例 | 4 / 21 | 4 / 21（Duration 3.25s） | 4 / 21 | 无；UI 用例被执行两次是 X12 遗留③，本任务不动，对照时别把 155+21 误读成 176 例独立用例 |

> 若 X13（`tableRelations` 可视化）先合入，其新增用例会推高脚本与 vitest 数字；**CI 不设硬编码断言数
> 阈值**（workflow 里没有任何数字比较逻辑），所以数字上涨不会让门禁变红，本任务也不据此改 workflow。

## 5. 门槛（worktree 最终态，坏例已还原）

```
$ npm run build && npm run lint && npm run verify
===== build=0 lint=0 verify=0 total_elapsed=173s =====
```

- `build`：`tsc -b` 通过 → `✓ built in 19.32s` → `dist-server\cli.mjs 159.4kb`
- `lint`：`eslint .` 零输出
- `verify`：11 个子脚本全绿，脚本断言 **612 项 / 失败 0**，vitest **155 例** + UI **21 例**（与 §4 基线逐项一致，零回归）
- verify 全跑后 `git status --porcelain` 只有本任务的新增未跟踪文件（`.github/`、
  `docs/tasks/X14-github-actions-ci/{design,CHANGES,verification}.md`），**受跟踪文件零改动**：

```
?? .github/
?? docs/tasks/X14-github-actions-ci/CHANGES.md
?? docs/tasks/X14-github-actions-ci/design.md
?? docs/tasks/X14-github-actions-ci/verification.md
```

耗时对照（本机口径，非 CI 预算）：worktree 三门槛合计 173s（基线记 190s，同量级；`%TEMP%` 的 clean
checkout 更快是 34s + 9s + 73s = 116s，磁盘与依赖缓存已热）。

## 6. 待主会话补录（推分支开 PR 后）

| 待补项 | 需要记录什么 |
|---|---|
| PR 号 | 本分支 `chenxinma/x14-ci-gate` → `main` 的 PR 编号与标题 |
| 首次 CI run | Actions 里该 run 的链接 + 各步骤耗时（尤其 `Install (npm ci)`），确认 `pull_request` 与（合并后的）`push: main` 两种触发都出现过 |
| check 名称确认 | run 页面左侧显示的 job 名应为 `build + lint + verify`；分支保护里就选这个名字（见 design.md §7 第 4 步） |
| registry 实际落点 | `Install` 步骤日志里请求的 host 是否为 `registry.npmjs.org`（若仍出现 `npmmirror` → 走 design.md §9 第 1 行的备选处置） |
| ubuntu 断言数 | `Verify` 步骤里 `verify:cwd` 应打印 `- SKIP：…` 且小结为 `共 6 项断言，失败 0 项`，脚本合计应为 **605**（不是回归） |
| 坏例 run 红/绿 | 用临时分支（删 `canvas-store.ts` 第 6 行的 `lineageEdge` 导入）开一个 PR，确认 **`Build` 步骤红（TS2304）**、`Verify` 步骤红（`verify:semantic-lineage` ReferenceError）或（build 先红即止）——这一步是「CI 真的能拦」的最终证据，本任务只有本机等价证据 |
| 分支保护 | 用户开启 `main` 的 required status check 的结论（勾选名字、是否连 "Require branches to be up to date"、是否对 admin 生效），以及 merge queue 的「暂不开」是否被推翻 |

首次真实运行的红点排查清单见 design.md §9（9 条，含「PR 有冲突时 workflow 根本不触发」这一条，
避免把「无 check」误读成 CI 故障）。

## 7. 复跑方式（本机等价，不含 GitHub 专有语义）

```bash
# 干净 checkout（无 node_modules）+ 与 workflow 相同的 install 配置
git archive --format=tar -o /tmp/clean.tar HEAD && mkdir -p /tmp/clean && tar -xf /tmp/clean.tar -C /tmp/clean
printf 'registry=https://registry.npmjs.org\nreplace-registry-host=always\n' > /tmp/ci.npmrc
cd /tmp/clean && npm ci --userconfig=/tmp/ci.npmrc --no-audit --no-fund
cd /tmp/clean && npm run build && npm run lint && npm run verify

# 坏例反向验证 + 还原
sed -i "6s/^import { lineageEdge, withSemanticHandles } from/import { withSemanticHandles } from/" src/store/canvas-store.ts
npm run build; npm run verify           # 预期 build exit=2（TS2304）、verify exit=1（ReferenceError）
git checkout -- src/store/canvas-store.ts && git diff | wc -c   # 预期 0
```

> Windows 注意：`--userconfig` 是给本机用的（避免真的写 `~/.npmrc`）；CI 上用的是 `npm config set`，
> 落点是 ephemeral runner 的 home，run 结束即消失。