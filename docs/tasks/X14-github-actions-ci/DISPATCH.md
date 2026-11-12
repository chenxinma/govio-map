# X14 任务书：GitHub Actions CI 门禁（PR 合并前自动跑 build + lint + verify）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X14")`（含 scope/acceptance，即验收契约）。

## 1. 背景与动机

govio-map 是无限画布数据治理工具（React 19 + TS + Vite + @xyflow/react + Zustand；后端是 Vite 插件里的 HTTP/WS 服务 + pi AgentSession）。仓库目前的合并纪律是：功能类改动走 GitHub PR，**由用户手动合并**，主会话在合并后的 main 上按验收协议独立复跑门槛（`npm run build` / `lint` / `verify`）。

**触发案例（本任务的全部动机）**：`docs/tasks/BUGFIX-lineage-edge-import.md`。PR #29（X10 表间语义边）与 main 上的 hotfix `5af8555`（把建边收束到 `lineage.ts` 的 `lineageEdge` 工厂）在 `src/store/canvas-store.ts` 上发生**行级**冲突；合并时调用点取了 main 侧、import 行取了 X10 侧，结果 `lineageEdge` 未导入：

- `npm run build` → TS2304 ×4
- `npm run verify` → 崩在第 6 个脚本 `verify:semantic-lineage`（ReferenceError），**后续 5 个子脚本与 vitest 全部未执行**

这个缺陷在任一单独分支上都测不出来（X10 分支自洽、main 自洽），只在**合并态**暴露。本次靠主会话人工复跑拦下（修复 `d2c3790`），差一步就流到用户手里。教训：**文件级不相交 ≠ 无行级冲突**。所以要把门槛做成机器门禁，让每个 PR 在合并前自动跑一遍合并态检查。

**目标**：新增 `.github/workflows/ci.yml`，在 `pull_request`（含 synchronize）与 `main` push 上自动跑 `npm ci → build → lint → verify`，失败即红；并把该 check 作为分支保护必需检查（开关由用户在 GitHub 侧操作，你不代做）。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、环境约定、「合入 main 纪律（PR 门禁）」「Orca 编排派发 SOP」）
2. `.pi/APPEND_SYSTEM.md`（运行时硬约束：SQL 生成纪律、Cypher 纪律、govio-cli 输出禁止截断；本任务基本不碰取数，但纪律照旧）
3. `docs/task-plan.json → crossCutting[] | select(.id=="X14")` 的 `note` / `scope` / `acceptance`
4. `docs/tasks/BUGFIX-lineage-edge-import.md`（坏例全文：症状、根因、修复、教训）——**你的反向验证要复现它**
5. `package.json`（scripts 全量，尤其 `verify` 聚合链的 11 个子脚本）、`vitest.config.ts`（include/environment/isolate）、`tsconfig*.json`（`tsc -b` 覆盖 app/node/scripts，**不含 tests/**）
6. `scripts/verify-*.ts` 的**文件头注释**（9 个脚本各自声明了依赖与复跑方式；重点看 `verify-rerun-drift.ts`（`--real` 才调真实 CLI）、`verify-cwd-normalize.ts`（平台闸门）、`verify-export-report.ts`（内部钉 `process.env.TZ`、`--write` 才改受跟踪文件）、`verify-prompt-injection.ts`（`.govio/sessions` 抽样只是信息性输出））
7. `docs/tasks/X4-test-infra/`、`docs/tasks/X12-ui-test-infra/design.md`（测试基建约定与 jsdom 局限，含「PR 合并前 CI 门」这条建议的出处）
8. `docs/tasks/X10-table-semantic-edges/DISPATCH.md`（本仓任务书体例与验证基线写法，供你写 verification.md 参照）

## 3. 实证事实（主会话已调研并实测，避免你重复踩坑）

**仓库现状**（本机 main @ `ac8bab1`，工作区干净，与 `origin/main` 零差异）：

- **没有 `.github/` 目录**，也没有任何其它 CI 配置（无 circle/travis/jenkins/gitlab/drone）→ 全新新增
- `package-lock.json` **已提交**，`npm ci --dry-run --no-audit --no-fund` 实测输出 `up to date in 5s`（lockfile 与 package.json 同步）
- `package.json` **无 `engines`、无 `packageManager` 字段**；本机 `node v24.16.0` / `npm 11.18.0`
- 依赖都是较新大版本（`typescript ~6.0.3`、`vite ^8.3.3`、`vitest ^5.1.0`、`eslint ^10.12.0`、`@types/node ^26.6.4`）→ **Node 版本建议对齐本机 24**（Vite 8 系要求 Node ≥ 20.19 / 22.12，用 24 最稳）
- ⚠️ **`package-lock.json` 的 `resolved` 有 1160 条指向 `registry.npmmirror.com`（淘宝镜像），只有 18 条指向 `registry.npmjs.org`**（本机 `~/.npmrc` 配了 `registry=https://registry.npmmirror.com`）。GitHub runner 上 `npm ci` 会照 `resolved` 原样去 npmmirror 拉包：可能变慢或不稳。处置选项（**在 design.md 里做取舍并写明理由，不要静默改 lockfile**）：
  1. 原样不动，接受从 npmmirror 拉（首次真实 CI 运行的结果由主会话观察，见 §6）
  2. 在 workflow 的 install 步骤前设 `npm config set replace-registry-host always`（npm 9+，把 `resolved` 的 host 换成配置的 registry）+ `registry=https://registry.npmjs.org`
  3. 重新生成 lockfile 指向 npmjs（**改动面大、可能带版本漂移，本任务不建议**；若你认为必须做，先在 design.md 写清风险再 `ask` 主会话）
- 本机 `npm ci --dry-run` 出现 `npm warn allow-scripts`（`@google/genai` preinstall、`esbuild` postinstall、`protobufjs` postinstall 未被 allowScripts 覆盖）——这是**本机 npm 策略**产物，不是仓库配置（仓库无 `.npmrc`）。CI 上别加 `--ignore-scripts`；esbuild 的平台包是 optionalDependencies，postinstall 被跳过也能跑（本机构建已验证）
- **无 `.gitattributes`**，本机 `core.autocrlf=true` → 不同 runner 换行符可能不同。目前没有按字节比对受跟踪文件的断言（`verify:export` 只在显式 `--write` 时才更新 `docs/tasks/T1.4-canvas-export/sample-export.html`，CI 不传 `--write`），所以暂不受影响；若你发现新风险，写进 design.md 遗留问题
- `.gitignore` 忽略 `node_modules`、`dist`、`dist-server`、`.env`、`skills`（因此 `.agents/skills` 不在仓库里）、`.govio`、`.pi/`（但 `.pi/APPEND_SYSTEM.md` 是**已跟踪**例外）、`data/`、`.claude`

**verify 链的外部依赖实况**（这是 runner 选型的关键，已逐个核实）：

- 9 个 `scripts/verify-*.ts` **全部自包含**：不调真实 govio-cli、不调模型、不联网、不读 `.env`（`dotenv` 只在 `server/serve.ts` 启动时用）；`govio-cli` 字符串在脚本里几乎都是**命令文本 fixture**
- `verify:rerun` 默认 **mock runner**；`npm run verify:rerun -- --real` 才会调真实 govio-cli + `sales` 数据源 → **CI 绝不能开 `--real`**
- `verify:caliber-conflict` / `verify:semantic-lineage` 用 stub CLI（日志里 `caliber CLI disabled in verify:semantic-lineage`、`spawn ENOENT` 都是**预期的降级断言**，不是失败）
- `verify:prompt-injection` 有一段「真实会话抽样」读 `<cwd>/.govio/sessions`，**目录不存在就跳过且不计入断言**（CI checkout 没有 `.govio`，正常）
- `verify:audit` 用临时目录 + 一次性会话文件；`verify:export` 产物默认写临时目录
- `tests/integration/ws-handler.test.ts`、`ws-protocol.test.ts` 用 `server.listen(0, "127.0.0.1")` **随机端口** → 无端口冲突风险；`vitest.config.ts` 设 `isolate: true`（每文件独立进程）
- **CI 不需要 `.agents/`（skills）**：verify/build/lint 全链都不读它（只有注释提到 `assets/schema.md`）

**唯一的平台差异（必须处理）**：`scripts/verify-cwd-normalize.ts` 用 `caseDrift` 闸门——只有当文件系统能构造大小写漂移（Windows NTFS）时才跑大小写相关断言，否则打印 `- SKIP：当前平台/文件系统无法构造大小写漂移…`。逐条数过：`caseDrift=false` 时跳过 **7 项**（[1] 1 项、[2] 3 项、[3] 1 项、[4] 2 项），该脚本 **13 → 6 项**。

- ⇒ **`windows-latest`：脚本断言 612 项（与本机齐平）**
- ⇒ **`ubuntu-latest`：脚本断言 605 项（7 项 SKIP，属脚本既有设计，不是回归）**
- 取舍：`windows-latest` 保齐平且与开发环境一致（本仓开发环境是 Windows Git Bash，X7 就是路径大小写问题），但 runner 更慢、分钟数计费更贵；`ubuntu-latest` 快但要逐项记录差值。也可双 runner 矩阵（拿两边信号，代价是耗时与额度）。**你自己定，但必须在 design.md 给出证据化取舍，并在 verification.md 逐项列出差值**；禁止为了让数字齐平而改脚本断言或判定。

**本机验证基线（主会话 2026-11-12 于 `ac8bab1` 实测，你的 CI 必须与之对齐）**：

| 门槛 | 结果 | 耗时 |
|---|---|---|
| `npm run build` | ✅（`tsc -b` + vite built in 2.86s + esbuild 159.4kb） | **62s** |
| `npm run lint` | ✅ 零输出 | **34s** |
| `npm run verify` | ✅ exit 0，全跑后 `git status --porcelain` 干净 | **94s** |

- **脚本断言合计 612 项 / 0 失败**：manifest 92、rerun 71、audit 119、export 126、source-table 39、semantic-lineage 48、caliber-conflict 46、cwd 13、prompt-injection 58（`58/58 通过`）
- **vitest**：`verify:integration`（`vitest run`）= **14 文件 / 155 例**；`verify:ui`（`vitest run tests/ui`）= **4 文件 / 21 例**（注意 UI 用例被执行两次，这是 X12 已知遗留③，本任务不要动）
- 三门槛合计 ≈ **190s**（不含 `npm ci` 与 runner 冷启动）→ 设 `timeout-minutes` 时留足余量（Windows runner 上 `npm ci` 可能数分钟）
- 各脚本小结行格式不统一（多数打 `共 N 项断言，失败 0 项`，caliber 打 `46/46 checks passed`，prompt-injection 打 `58/58 通过`，cwd 另有一行 `PASS: …`）→ 你若要在 CI 里做断言数汇总，得兼容这四种格式（**可选增强，不是硬要求**；如做，别改脚本输出格式，在 workflow 侧解析）

**并行任务提醒**：X13（tableRelations 可视化）正在另一个 worktree 并行进行，它会改 `src/components/Nodes/SourceTableNode.tsx`、`src/utils/lineage.ts`、`src/utils/export-report.ts`、`scripts/verify-export-report.ts`、`tests/ui/*`，**断言数可能上涨**。所以：你的 verification.md 里写「与派发时基线（612 / 14 文件 155 例）对比」即可，**不要**因为对不上 X13 合并后的数字就改 workflow；两个 PR 的合并顺序由主会话协调。你**不得**改任何业务代码或测试文件（除新增 workflow 与三件套）。

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **新增 `.github/workflows/ci.yml`**：
   - 触发：`pull_request`（确保 `synchronize` 也在内——默认 types 即含 opened/synchronize/reopened，不要窄化成只 `opened`）+ `push: branches: [main]`
   - 步骤：`actions/checkout` → `actions/setup-node`（`node-version: 24`，`cache: npm`）→ `npm ci` → `npm run build` → `npm run lint` → `npm run verify`
   - `timeout-minutes` 按 §3 实测（190s + npm ci + 冷启动）留余量；`concurrency` 建议开（同一 PR 新 push 取消旧跑，省额度）
   - runner 按 §3 的平台差异取舍选定（`windows-latest` / `ubuntu-latest` / 矩阵），理由写进 design.md
   - 失败要**真的红**：不要 `continue-on-error`，不要 `|| true`，不要把 build/lint/verify 揉进一个 `run` 里掩盖是哪一步失败（分步骤，或至少保证退出码透传）
2. **本地等价验证（不能只靠"看着像对"）**：
   - YAML 语法/结构校验：`actionlint` 若能**一次性**安装使用（如 `go run`/下载二进制到临时目录）就用，**不要写进 devDependencies**；装不上就明确说明，用「真实 CI 运行」作为最终证据
   - **clean checkout 实测 `npm ci`**：把仓库复制到临时目录（不含 `node_modules`）跑一次 `npm ci --no-audit --no-fund`，确认能装成功（这条同时验证 npmmirror `resolved` 是否可用），耗时与结果写进 verification.md
   - 在 clean checkout 里把 `build → lint → verify` 三步按 workflow 的顺序与命令原样跑一遍，确认全绿
3. **反向验证（坏例必须红，必须实测并贴输出）**：在**临时分支或临时副本**里复现 `BUGFIX-lineage-edge-import` 的坏例——删掉 `src/store/canvas-store.ts` 顶部的 `lineageEdge` 导入，确认：`npm run build` 报 TS2304（×4）、`npm run verify` 在 `verify:semantic-lineage` 崩 ReferenceError 且后续脚本未执行。然后**完全还原**（`git diff` 为空、`git status --porcelain` 干净），把还原证据贴进 verification.md。
   - 这一步证明的是「门槛能抓住合并态缺陷」；至于「CI 在 PR 上真的红了」的证据，由主会话推分支开 PR 后补录（见 §6），你在 verification.md 里留一节「待主会话补录」并列出需要记录什么（PR 号、CI run 链接、坏例 run 的红/绿结论）
4. **分支保护交接**：在 design.md 写清用户需要做的操作（仓库 Settings → Branches → branch protection rule for `main` → Require status checks to pass → 勾选你这个 check 的**准确名称**，即 job/workflow 名），以及建议是否开 merge queue / required linear history（评估后给建议，不强求）。你**不代做**、不假设已开启。
5. **三件套**落盘 `docs/tasks/X14-github-actions-ci/`：`design.md`（runner 选型对比、npmmirror 取舍、断言差值处置、超时/缓存策略、**「遗留问题」小节**）、`CHANGES.md`（文件清单 + 每处摘要）、`verification.md`（命令、关键输出、断言数逐项对照表、坏例反向验证证据、clean checkout `npm ci` 实测）。

## 5. 范围纪律（明确不做）

- **不改任何业务代码、不改任何测试、不改 `package.json` 的 scripts、不改既有 verify 脚本的断言或输出格式**（本任务只新增 `.github/workflows/ci.yml` + 三件套；如确有必要动别处，先 `ask` 主会话）
- **不改 `package-lock.json`**（含为了 registry 而重生成）；registry 处置只在 workflow 侧或 design.md 取舍里做
- **不改 `docs/task-plan.json`**（并行派发，记账由主会话统一执行）
- 不引入运行时依赖；不新增 devDependencies（actionlint 一类工具只能一次性使用，用完不留痕）
- 不在 CI 里调用真实 `govio-cli`、不装 govio-cli、不开 `verify:rerun -- --real`、不传 `verify:export -- --write`、不联网调模型
- 不做 `.agents/`（skills）在 CI 里的下载/安装（verify 链不需要；发布包的 skills 下载是 `server/govio-installer.ts` 的运行时职责）
- 不动 `src/utils/layout.ts`、`src/utils/lineage.ts`、`SourceTableNode.tsx` 等 X13 正在改的文件（并行写者隔离）
- 不顺带修 X12 遗留（tests/ 未纳入 `tsc -b`、UI 用例重复执行）；**新发现一律写入 `design.md` 的「遗留问题」小节**
- 不 push、不切分支、不建 PR、不合并（PR 由主会话创建、用户合并）

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
  `.agents/`（含 skills 与 `govio/assets/schema.md`）被 gitignore，fresh worktree **不含**该目录（约 350K）。本任务的 verify 链其实不读它，但按仓库 SOP 统一执行，避免任何隐式依赖踩空。
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`，`npm ci`/构建前请确认 `node_modules` 已就绪，没就绪就自己 `npm ci --no-audit --no-fund`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、**不要以反斜杠结尾**（会被当转义吞掉引号导致 `unexpected EOF`）；`python` 是 Windows Store 存根**不可用**（需脚本语言用 node/tsx）；解析 JSON 用 `jq`（`/d/Work/jq/jq`）
- **禁止用 `head`/`tail`/`sed`/`grep` 截断 `govio-cli` 输出**（本任务基本不调 govio-cli；若为验证降级路径调了，输出是 JSON，截断即无法解析）。注意：截断 `npm run verify` 的 stdout 用于**人读摘要**是允许的（它不是 govio-cli），但要保留退出码与失败行
- 执行任何 Cypher 前必须先读 `.agents/skills/govio/assets/schema.md`（本任务预计不需要查图谱）
- commit：**单次 commit**，message 前缀 `X14: ...`
- 验证门槛（全绿才算完成，任一非零退出即失败；修复后重跑，**禁止虚报**）：`npm run build`、`npm run lint`、`npm run verify`（与 §3 基线对齐：脚本 612 项 / vitest 14 文件 155 例 / UI 4 文件 21 例，零回归），且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态（主会话验收时统一置 done/accepted）
- 完成后**必须**发 orca 信号（只把结论写在终端不算完成）：
  `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也要发，`--outcome` 用 `failed`/`blocked` 并说明缺口
- **真实 CI 运行的闭环**：你报 done 后，主会话会推你的分支并开 PR，观察首次 CI 运行；若因 runner 环境（npmmirror 拉包、Node 版本、Windows 路径等）跑红，主会话会把失败日志通过 `send` 发回给你做修复轮（你收到 `send` 时若正在做别的事，**先完成当前任务再处理**）。所以 design.md 里请把「首次真实运行可能红的点 + 备选处置」列成清单，便于快速定位
- 遇到模型通道/环境类阻塞（依赖装不上、工具不可用等）：用 `ask` 问主会话，不要自行换方案或降级目标

## 7. 时间预算

- 总预算 **70 分钟**（`--timeout-ms 4200000`）
- **到期前 15 分钟为 checkpoint 点**（≈55min）：若未完成，先把已改文件与三件套当前状态 commit（message 前缀 `X14: WIP ...`），并在汇报中写明「已改文件 / 验证状态（哪些门槛已跑、结果如何）/ 剩余工作」。**超时不是变更安全边界**——尤其不要留下「workflow 写了一半 + 坏例没还原」的状态（坏例必须还原，`git diff` 为空）
- 建议节奏：读档 ≤10min → runner/registry 取舍定案 ≤10min → 写 ci.yml ≤10min → clean checkout `npm ci` + 三步实测 ≤20min → 坏例反向验证与还原 ≤10min → 三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X14-github-actions-ci/{design.md,CHANGES.md,verification.md} + .github/workflows/ci.yml
commit: <hash> <message>
runner 选型: <windows-latest|ubuntu-latest|矩阵>（一句话理由）；node-version: <n>；timeout-minutes: <n>；cache: <npm|无>
registry 取舍: <原样 npmmirror|replace-registry-host|其它>（一句话理由 + 证据）
断言数对齐: 脚本 612 → CI <k>（差值逐项说明，如 cwd SKIP 7 项）；vitest 14 文件/155 例 → <..>；UI 4 文件/21 例 → <..>
clean checkout npm ci: <成功/失败>（耗时 <s>s，命令与关键输出）
坏例反向验证: build=<TS2304 ×n/未捕获>；verify=<崩在哪个脚本/未捕获>；还原后 git diff 为空=<是/否>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>（耗时 <s>s）；git status 干净=<是/否>
YAML 校验方式: <actionlint 版本/无法安装→以真实 CI 运行为准>
待主会话补录: <PR 号 / CI run 链接 / 坏例 run 红绿结论 / 分支保护 check 名>
遗留: <design.md 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也要发 `worker_done`，`--outcome` 用 `failed`/`blocked` 并说明缺口，禁止虚报验证结果。
