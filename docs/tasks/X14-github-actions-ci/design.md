# X14 设计：GitHub Actions CI 门禁（PR 合并前自动跑 build + lint + verify）

## 1. 目标与边界

把 AGENTS.md「合入 main 纪律（PR 门禁）」里靠人肉执行的验收第 1 步——在**合并态**复跑
`npm run build` / `npm run lint` / `npm run verify`——变成机器门禁：每个 PR 在合并前自动跑，
失败即红并可作为 main 的必需状态检查。

新增文件只有一个：`.github/workflows/ci.yml`（仓库此前无任何 CI 配置，无 `.github/` 目录）。

明确不做（任务书 §5）：不改业务代码与既有 verify 脚本的断言/判定/输出格式；不改
`package.json` scripts；不改 `package-lock.json`（含为 registry 重生成）；不引入依赖；CI 不调用
真实 `govio-cli`、不开 `verify:rerun -- --real`、不传 `verify:export -- --write`；不代开分支保护。

## 2. 门禁必须覆盖的失败模式（来自 `docs/tasks/BUGFIX-lineage-edge-import.md`）

坏例的两条症状分别由**不同步骤**捕获，这决定了步骤拆分方式：

| 症状 | 捕获者 | 为什么必须有这一步 |
|---|---|---|
| `npm run build` → TS2304 ×4（`lineageEdge` 未导入） | `Build` 步骤（`tsc -b`） | `npm run verify` 链里**没有任何类型检查**：`tsx`/`vitest` 只做转译不做类型判定，纯类型错误在 verify 链里可能全程不报。build 是 TS2304 的唯一捕获者 |
| `verify` 崩在第 6 个子脚本（ReferenceError），后续 5 个脚本 + vitest 全部未执行 | `Verify` 步骤（`&&` 链） | 聚合链的 `&&` 会把「前面崩了」如实转成非零退出码，CI 只需要退出码，不需要自己数子脚本 |
| 单分支自洽、只在合并态暴露 | 触发器选择 + GitHub 的 PR 上下文 | `pull_request` 事件的默认工作目录是 `refs/pull/N/merge`（base←head 的**自动合并预览提交**），因此 CI 测的已经是「合并态」而不是分支孤立态。X10 那次是**已解决**的行级冲突（取错边），其结果正好落进 merge ref → 门禁会红 |

推论两条：① 触发必须含 `synchronize`（冲突解决/追加 commit 后重跑，旧结论作废）；② 若 PR 存在
未解决冲突，GitHub 不生成 merge ref、workflow 不触发，此时 PR 页面本身已显示冲突——门禁不掩盖它。

## 3. runner 选型（证据化对比）

| 维度 | `ubuntu-latest`（选定） | `windows-latest` | 双 runner 矩阵 |
|---|---|---|---|
| 脚本断言数 | **605**（`verify:cwd` 的 `caseDrift` 闸门 SKIP 7 项：[1]1 + [2]3 + [3]1 + [4]2，13→6） | **612**（与本机齐平） | ubuntu 605 + windows 612 |
| 与开发环境一致性 | 否（本仓开发环境 Windows Git Bash） | 是 | 两边都有 |
| 耗时/额度 | 1x 计费、npm ci 与 fork 池最快 | 约 2x 计费、冷启动与 install 明显更慢 | 墙钟≈单跑（并行），计费 2x |
| 额外能力 | **大小写敏感文件系统**：能抓「Windows/mac 上照样编译、Linux 上因 import 路径大小写不符而炸」的一类缺陷（X7 正是路径大小写事故） | 能跑 `caseDrift` 的 7 项 | 全集 |
| 门禁抖动风险 | 低 | Windows runner 的 npm/路径/杀软类抖动更多，且必需检查一旦红就挡住用户手动合并 | 任一腿抖 → 合并被挡 |

### 决策：`ubuntu-latest` 单 job

1. **差值面只有 1.1%（7/612），且是脚本既有设计**：全仓 `scripts/` + `tests/` 里唯一的平台判定就是
   `verify-cwd-normalize.ts` 的 `caseDrift`（grep `win32|process.platform|path.sep` 只命中该文件的
   注释与一处显式传 `"linux"` 的平台覆盖断言，后者在两平台都通过）。其余 605 项在两平台等价。
2. **Windows 侧信号本机已经强制存在**：AGENTS.md 的 worker 完成定义要求每次改动在 Windows Git Bash
   跑 build/lint/verify 全绿，主会话验收再独立复跑一次。CI 的边际价值是「干净环境 + 合并态」，
   不是第 N 次 Windows 复跑；反过来 ubuntu 提供的是本机给不了的信号（见上表「额外能力」）。
3. **门禁要「快且可信」**：本仓 PR 由用户手动合并，CI 时延直接进人的等待时间；必需检查若因 runner
   抖动而红，最坏结果是人们想关掉它。
4. **代价如实记录**：`verify:cwd` 的 7 项大小写断言在 CI 上永久 SKIP，verification.md 逐项列出；
   如需机器覆盖，见 §8 遗留问题 2（nightly `windows-latest` 腿，不做成必需检查）。

## 4. registry 取舍（`package-lock.json` 的 npmmirror `resolved`）

实况：lockfile 的 1178 条 `resolved` 中 **1160 条指向 `registry.npmmirror.com`**、18 条指向
`registry.npmjs.org`（本机 `~/.npmrc` 配了镜像）。GitHub runner 没有 `~/.npmrc`，默认会照
`resolved` 原样去镜像拉包。

| 选项 | 做法 | 评估 |
|---|---|---|
| 1. 原样不动 | runner 直接从 npmmirror 拉 | 实测 npmmirror 的 tarball 请求会落到 `cdn.npmmirror.com`（见下证据），即「境内 CDN」；GitHub runner 在美东，跨洋访问该 CDN 的时延与可用性不可控，冷跑可能超时或抖动 → 门禁抖动的最大来源，不选 |
| **2. workflow 侧换 host（选定）** | `npm config set registry https://registry.npmjs.org` + `npm config set replace-registry-host always`（npm 9+） | 不改 lockfile、不改本机配置、只在 runner 生命周期内生效（写 runner 的 `~/.npmrc`）；把 lockfile 的 tarball host 换成公共 registry，与 runner 同域，路径最短。URL 布局兼容（两边都是 `<name>/-/<name>-<ver>.tgz`，scoped 同理），且 `integrity` 与 host 无关，换 host 不动校验 |
| 3. 重生成 lockfile 指向 npmjs | 删除并重建 1178 条 `resolved` | 改动面与版本漂移风险远超本任务范围，还会撞上并行的 X13 分支；任务书明确不建议，不选 |

### 证据：冷缓存 micro 实测（一次性，不入库）

构造单包 fixture（`ms@2.1.3`，`resolved` 照抄仓库 lockfile 的 npmmirror URL），空 cache +
`--loglevel http` 跑 `npm ci`：

```
TEST A  registry=npmjs + replace-registry-host=always
  npm http fetch GET 200 https://registry.npmjs.org/ms/-/ms-2.1.3.tgz   (cache miss)   exit=0
TEST B  registry=npmjs + replace-registry-host=never（对照组 = 照 lockfile 走）
  npm http fetch GET 200 https://cdn.npmmirror.com/packages/ms/2.1.3/ms-2.1.3.tgz   (cache miss)
```

⇒ `always` 确实改写 host（A 全程没出现 npmmirror），对照组 B 暴露了「不写就会去镜像并被 302 到
cdn.npmmirror.com」。

诚实记录一个观察：全量 clean checkout 用同一份 `registry=npmjs + always` 的 userconfig 装成功
（exit 0 / 154s / added 518 packages），但事后看 `node_modules/.package-lock.json` 里的 `resolved`
仍有 509 条写着 npmmirror——本机 `~/.npm` 已有同内容缓存，命中缓存的条目沿用了 lockfile 的
`resolved` 字符串。也就是说**实际请求 URL** 才是行为证据（micro 冷缓存已证），落地元数据里的字符串
不是。GitHub runner 是空缓存冷跑，最终结论以首次真实 CI run 为准；若真实 run 里出现对 npmmirror 的
请求或因此变慢，回退方案是选项 1（把这两行删掉即可，行为退化为「照 lockfile 拉」）。

顺带记录：本机 `npm ci` 出现 `npm warn allow-scripts`（`@google/genai` preinstall、`esbuild` postinstall、
`protobufjs` postinstall 未被 allowScripts 覆盖）是**本机 npm 策略**（global npmrc）产物，GitHub runner
上没有该策略，install 脚本会正常执行。CI 不加 `--ignore-scripts`。

## 5. Node 版本、缓存、超时、并发

- `node-version: "24"`：本机实测通过全部门槛的是 v24.16.0；`package.json` 无 `engines`/`packageManager`
  字段（本任务不补，属另议）；依赖是大版本较新的栈（TS ~6.0、Vite 8、vitest 5、eslint 10、@types/node 26），
  Vite 8 要求 Node ≥20.19/22.12，取 24 与开发机同大版本最稳，也避免 `@types/node` 与实际 Node 差两代。
- `cache: npm`（`actions/setup-node` 按 `package-lock.json` 哈希缓存 `~/.npm`）：首跑冷缓存，之后命中；
  与本仓 518 包的体量匹配，不加自建 cache action（少一个失败点）。
- `timeout-minutes: 20`：本机实测 build 62s + lint 34s + verify 94s ≈ 190s，本机 clean checkout
  `npm ci`（warm 缓存）154s；runner 冷跑即便全部翻倍也 <12min，20min 是约 6x 余量——够容纳偶发抖动，
  又不至于让挂死的 run 占着并发额度。
- `concurrency: <workflow>-<PR号或ref>` + `cancel-in-progress: true`：同一 PR 连续 push 只留最新一次
  （synchronize 场景常见：解冲突后立刻补推），省额度也避免旧 run 结论被误读成当前结论。
- `permissions: contents: read`：门禁只需读代码，不给写权限（工作树检查也是只读断言）。
- `workflow_dispatch`：额外加手动触发，便于用户在不 push 的情况下对某分支单独复检（首次真实运行
  观察、回归排查都用得上），不影响 PR 门禁语义。

## 6. 步骤拆分与「失败必须真的红」

- 四个独立步骤：`Install (npm ci)` → `Build` → `Lint` → `Verify`。GitHub Actions 默认对每个 `run`
  步骤检查退出码（bash 下 `-e`），任一步非零即整个 run 红，且**步骤名直接指出失败点**。
- 不写 `continue-on-error`、不写 `|| true`、不把三步揉进一个 `run`、不用 `cmd | tee log`（管道会吞掉
  真实退出码，除非额外 `set -o pipefail`，收益不抵风险）。日志在 Actions UI 里已完整可查，不传
  artifact。
- 末尾 `Verify left the working tree clean`：`git status --porcelain` + `test -z "$(git status --porcelain)"`，
  对齐 AGENTS.md 的 worker 完成定义（verify 全跑后工作树必须干净），顺带守住「某脚本在 runner 环境上
  误写受跟踪文件」这类只在 CI 才出现的偏差（`dist`/`dist-server`/`node_modules` 均已被 .gitignore 覆盖）。
- **断言数汇总解析不在 CI 里做**（可选增强，本次放弃）：9 个脚本的小结行有四种格式
  （`共 N 项断言，失败 0 项` / `46/46 checks passed` / `58/58 通过` / `verify:cwd` 另有一行 `PASS: …`），
  在 workflow 侧解析要么引入管道、要么引入 grep 脚本，失败还会污染门禁色。改为「本机 + 人工对照」：
  见 §8 遗留问题 1。

## 7. 分支保护交接（由用户在 GitHub 侧操作，本任务不代做）

1. 仓库 **Settings → Branches → Add branch protection rule**（或编辑既有 `main` 规则）
2. **Branch name pattern**: `main`
3. 勾选 **Require status checks to pass before merging**
4. 在 "Search for checks" 里添加本 workflow 的 job 名（即 check 的准确名称）：

   ```
   build + lint + verify
   ```

   （workflow 显示名是 `CI`；分支保护里要选的是 **job 名** `build + lint + verify`。job id 为 `ci`。）
5. 建议一并勾选 **Require branches to be up to date before merging**：这样「PR 绿灯后 main 又前进了」
   的竞态必须先 merge 最新 main 再重跑门禁——正是 X10 事故的上游条件。代价是合并排队更久。
6. 建议对 admin 同样生效（不要用 "Allow merge administrators" 豁免），否则 hotfix 会绕过门禁；
   真要紧急合入时再临时豁免。
7. **merge queue / required linear history 的评估结论：暂不开**
   - required linear history（squash/rebase 合并）与本仓既有惯例冲突——PR #12–#17、#31 都是
     `Merge pull request #N` 形态，改历史形态属另一议题，不在门禁里顺手做。
   - merge queue 的价值是在合入前一瞬对「真正的合并态」再跑一次门禁（最强防护）。但本 workflow 已经跑在
     `refs/pull/N/merge` 自动合并预览上，对「行级冲突取错边」这类缺陷信号等价；merge queue 的代价是
     每个 PR 多一整轮 CI（额度）+ 排队时延。
   - 结论：**先单门禁观察**。若后续出现「PR 全绿但 main 红」的合并竞态（两个各自绿的 PR 合体炸），
     再上 merge queue（届时也建议保留 squash 之外的现有历史形态）。

## 8. 遗留问题

1. **CI 侧断言数看板/漂移告警**：把「脚本 605（ubuntu）/ 612（windows）、vitest 文件数与例数」做成
   CI 可机读的输出，需要在**非门禁** job 里解析四种小结格式并与 `docs/task-plan.json` 基线比对。
   当前做法是验收时人工逐项对照（见 verification.md 的对照表）。
2. **`verify:cwd` 的 7 项 caseDrift 断言在 CI 上永久 SKIP**：如要让机器覆盖，加一个
   `windows-latest` 的 **nightly `schedule` job**（只跑 `npm run verify:cwd`，不设必需检查），
   既保住 Windows 侧信号又不拖慢 PR 门禁。本任务不做（会引入第二条必需检查与额度）。
3. **无 `.gitattributes` + 本机 `core.autocrlf=true`**：runner checkout 出来是 LF，目前没有按字节比对
   受跟踪文件的断言（`verify:export` 只在显式 `--write` 时更新 `docs/tasks/T1.4-canvas-export/sample-export.html`），
   所以不受影响。一旦将来加「产物字节一致性」类断言，必须先补 `.gitattributes`，否则两平台结论会分叉。
4. **`tests/` 不在 `tsc -b` 覆盖范围**（X12 遗留①）：CI 的 Build 步骤管不到测试代码的类型错误，
   只能靠 `verify:integration` 运行时暴露（运行时不校验类型）。本任务不动 `tsconfig`。
5. **UI 用例被执行两次**（`verify:integration` 的 include 已含 `tests/ui/**`，`verify:ui` 再跑一遍，
   X12 遗留③）：CI 多花几秒，数字对照表要按「integration 14 文件/155 例 + ui 4 文件/21 例」记录，别误读成回归。
6. **action 版本用 major tag**（`actions/checkout@v4`、`actions/setup-node@v4`）未 pin 到 commit SHA：
   本机离线无法核对 SHA，供应链卫生上建议后续 pin；tag 若升级到含行为变更的 major，门禁会先红/先坏再暴露问题。
7. **`replace-registry-host` 依赖 npm ≥9 的语义**：若将来换包管理器（pnpm/yarn）或改用
   `actions/setup-node` 的 `registry-url` 输入，需要重估 §4 的取舍（`registry-url` 不会改写
   lockfile 里的 tarball host）。
8. **门禁只覆盖 mock/stub 链路**：真实 `govio-cli`、模型调用、数据源连通性不在 CI 里（任务书硬约束）。
   将来若要「真实链路冒烟」，必须单独立项带 secrets 与自建数据源，且不能设成 PR 必需检查。
9. **本仓尚无 `engines`/`packageManager` 字段**：CI 里的 `node-version: "24"` 是外部约定，与本机
   `v24.16.0` 对齐；如果哪天要 lockfile-aware 的自动对齐（如 setup-node 的 `node-version-file: .nvmrc`），
   属仓库约定变更，建议单独任务裁决。
## 9. 首次真实 CI 运行可能红的点 + 备选处置（供主会话回传日志时快速定位）

| # | 症状（红在哪一步 / 关键日志） | 判定 | 备选处置（顺序即优先级） |
|---|---|---|---|
| 1 | `Install (npm ci)` 超时 / `ETIMEDOUT` / `ECONNRESET`，日志里出现 `registry.npmmirror.com` 或 `cdn.npmmirror.com` | `replace-registry-host=always` 未按预期改写（runner 的 npm 版本语义差异），于是从境内镜像拉包 | ① 确认 registry 步骤在 `npm ci` 之前且未被跳过；② 直接在 install 命令里带上 flag：`npm ci --registry=https://registry.npmjs.org --replace-registry-host=always`；③ 仍不行 → 加 `registry-url` 输入或 ask 主会话（**不要**改 lockfile） |
| 2 | `Install (npm ci)` 红，日志有 `404` 指向 `registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz` | 个别包在镜像侧存在、在 npmjs 已下架（概率极低） | 记录具体包名 ask 主会话；临时退路是选项 1（删掉 registry 那一步，照 lockfile 从镜像拉） |
| 3 | `Build` 红：`Cannot find module @rolldown/binding-linux-x64-gnu` / `@tailwindcss/oxide-linux-*` / `@esbuild/linux-x64` / `lightningcss-linux-x64-gnu` | Linux 平台 optional 包没装上（已核对：这 4 类 `*-linux-x64-*` 在 lockfile 里都有条目，故属 npm 解析异常而非缺条目） | ① `npm ci` 去掉 `--no-audit --no-fund` 以取更多日志；② 显式 `npm ci --os=linux --cpu=x64`；③ ask（不得改 lockfile/业务代码） |
| 4 | `Verify` 红在 `verify:cwd`（不是 SKIP 而是断言失败） | 该脚本在 Linux 上应跑 6 项、SKIP 7 项；若 6 项里有失败，说明 `canonicalizeCwd`/`SessionManager` 有真实平台缺陷（正是门禁该抓的东西） | 保留日志 ask 主会话；本任务不改脚本 |
| 5 | `Verify left the working tree clean` 红，`git status --porcelain` 只列 mode 变化（`old mode/new mode`） | Linux checkout 的可执行位与索引不一致 | workflow 的该步骤前加一行 `git config core.fileMode false`（只动 workflow，不碰仓库配置与业务代码） |
| 6 | `Verify` 红在 `verify:integration` / `verify:ui`，日志含 worker 崩溃或 out of memory | runner 上 fork 进程数/内存与本机不同 | 在 `Verify` 步骤加 `env: { NODE_OPTIONS: "--max-old-space-size=4096" }`；不改 `package.json` scripts |
| 7 | 整条 run 被 `timeout-minutes: 20` 掐断 | 冷缓存 + 镜像/网络抖动 | 先把 timeout 提到 30 观察一次真实耗时，再决定是调小还是加缓存；同时记录 `npm ci` 实测耗时（verification.md §6 补录表） |
| 8 | PR 页面**没有**该 check（不是红，是缺席）且 PR 有冲突 | GitHub 对存在冲突的 PR 不生成 `refs/pull/N/merge`，workflow 不触发 | 预期行为：先解冲突再 push（synchronize 会重跑）；分支保护开着时 PR 会显示 pending，别误判成 CI 坏了 |
| 9 | 首次 run 等待 "Actions need to be approved by collaborators" | 该组织仓库设置对首次贡献者/新 workflow 要求人工批准，或 PR 来自 fork | 由主会话/用户在 Actions 页面点 Approve and run；本任务的 PR 来自同仓库分支，正常情况不触发 |