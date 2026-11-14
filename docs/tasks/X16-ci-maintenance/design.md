# X16 设计：CI 维护小修包（actions pin SHA、runner 钉版、断言数看板、concurrency 注释）

## 1. 目标与边界

归口 X14 遗留 1/2/6 与首跑两条 run 注解（动机与触发证据见 `docs/task-plan.json → crossCutting[X16].note`）。
范围纪律：只动 `.github/workflows/` 与三件套；不改业务代码/测试/`package.json`/`package-lock.json`/既有
verify 脚本；不改 required check 名 `build + lint + verify`（ruleset 27209918 引用它，改名必须用户同步改
ruleset，本任务未改）；不引入任何仓库依赖；windows nightly 腿只评估不实现。

四项改动：① actions pin commit SHA；② runner 钉 `ubuntu-24.04`；③ 非门禁断言数看板；④ concurrency
维持现状 + 注释与取舍论证。验收对照任务书 §4/acceptance 逐项如下。

## 2. actions pin commit SHA（用户决策 2026-11-14）

### 2.1 选型与取证

| action | 旧 | 新 pin | 目标运行时 |
|---|---|---|---|
| `actions/checkout` | `@v4`（Node 20） | `3d3c42e5aac5ba805825da76410c181273ba90b1`（`# v7.0.1`） | `node24` |
| `actions/setup-node` | `@v4`（Node 20） | `949feb2413d6458794dcd2491c4babbbce0c15c1`（`# v7.1.0`） | `node24` |

「当前维护版」= 官方仓最新 stable major 的最新发布（checkout v7.0.1 / setup-node v7.1.0；beta 不取）。
SHA **三重取证，全部来自官方仓库，无编造**：

1. `git ls-remote --tags https://github.com/actions/{checkout,setup-node}`：v7 / v7.0.1（同 commit）与
   v7 / v7.1.0（同 commit）的 tag 对象 SHA 即上表值；
2. `git clone --depth 1 --branch <tag>` 后 `git rev-parse HEAD` 与之相等（两 tag 均为轻量 tag，tag=commit，
   无 annotated peel 歧义；若将来遇到 annotated tag 必须取 `refs/tags/vX.Y.Z^{}` 的 peel 值）；
3. clone 出的 `action.yml` 断言 `runs.using: node24`（这是消除 Node 20 弃用注解的根因），且本仓用到的输入
   （setup-node 的 `node-version`/`cache`；checkout 默认调用）在 v7 仍存在。

行为差异排查：v4→v7 跨度大，但本 workflow 只用两者的默认行为 + setup-node 两个输入；checkout 默认
`fetch-depth: 1`、`persist-credentials` 语义未变（v7 action.yml 输入清单核对过），工作树清洁步骤只依赖
浅检出内的 `git status`。最终证据以真实 PR run 为准（§7）。

### 2.2 pin 的维护策略（如何跟进升级）

- **跟进节奏**：每季度或出现事件时手动检查（action 报错/新弃用注解/需要新特性）：
  `git ls-remote --tags <官方仓>` 对比 pin 注释里的 tag；读官方仓 Releases 页变更说明。
- **升级流程**：按 §2.1 的三重取证法得出新 commit SHA（annotated tag 用 `^{}` peel 值）→ 改注释与 SHA →
  走 PR 让门禁自己当回归测试 → 绿后合入。**禁止**从第三方镜像/搜索引擎抄 SHA。
- **代价与兜底**：pin 后不会自动获得上游修复（例如未来某 runtime 修复只发 minor）；Node 大版本弃用类问题
  表现为 run 注解而非红，主会话验收时看注解即可发现。可选自动化：加 `.github/dependabot.yml`
  （`package-ecosystem: github-actions`）自动开 bump PR——需用户裁决（引入 bot PR 流），记入遗留问题。

## 3. runner 钉版：`ubuntu-latest` → `ubuntu-24.04`

`ubuntu-latest` 标签 2026-10-19 起迁移 Ubuntu 26（actions/runner-images#14748）。门禁的 runner 环境不能
被一个会漂移的标签静默搬走 → 钉 `ubuntu-24.04`。

**Ubuntu 26 升级策略**：
1. 时机：等 `ubuntu-26.04` 在 runner-images 正式 GA 且首周事故期过后，由用户或主会话发起，单独 PR。
2. 方法：**禁止改回 `ubuntu-latest`**；直接换 `ubuntu-26.04` 字面量，在临时 PR 上对照。
3. 需要重跑的对照（同 commit 各跑一次，24.04 vs 26.04）：
   - 逐脚本断言数：预期 ubuntu 仍 617（`verify:cwd` caseDrift SKIP 7 项不变——Linux 大小写敏感语义未变则不变）；
   - vitest 15 文件 194 例 + UI 4 文件 31 例；
   - `npm ci` 耗时与 install 脚本（esbuild postinstall）、Node 24 toolchain 行为（runner 预装组件版本）；
   - 工作树清洁步骤（git 版本变化的 fileMode/autocrlf 行为）。
4. 看板（§4）在 26.04 对照 PR 上直接给第一层证据；红了按 X14 design §9 表排查。

## 4. 断言数看板（非门禁）

### 4.1 数据通路：Verify 步骤 tee 到 `$RUNNER_TEMP/verify.log`

后续步骤拿不到前序步骤的 stdout，要么重跑 verify（多花一倍门禁时长且引入二重不确定性），要么把日志留在
文件里。选后者：Verify 步骤改为 `set -o pipefail` + `npm run verify | tee "$RUNNER_TEMP/verify.log"`。

这与 X14 design §6「不用 `cmd | tee`（管道吞退出码）」的决定**不矛盾而是补齐**：当初避免的是无 pipefail 的
tee；本任务显式 `set -o pipefail`（GH 默认 `bash -e` 之外补上），失败链仍让步骤红。本机等价验证见
verification.md §3（fail 用例 exit=1、ok 用例 exit=0、日志完整落盘）。日志写在 `$RUNNER_TEMP`（工作区外），
不触碰任何受跟踪文件，工作树清洁门禁不受影响。

### 4.2 解析器（`.github/workflows/scripts/assertion-dashboard.mjs`）

四种小结格式全覆盖（源自脚本源码，非猜测）：`共 N 项断言，失败 M 项`（多数脚本）、
`N/N checks passed`（caliber）、`N/N 通过`（prompt-injection）、vitest `Test Files …(N)` + `Tests …(N)`。
按 npm 子脚本头 `> govio-map@x.y.z verify:<name>` 切段归属；ANSI 色码先剥离；未知格式只报
`summary line did not match any known format` 警告（提示解析器需要更新），不炸。

### 4.3 基线单一来源与平台差值建模

- **单一来源**：脚本顶部常量块（含逐项数字与出处注释）。任务书允许「workflow 顶部变量硬编码 + 注释来源」；
  选择放在 workflow 自带的 .mjs 里而不是 `env:` 块，是因为 9 脚本 + 2 vitest 共 13 个数字塞 env 可读性差，
  且 .mjs 仍满足「在 workflow 目录内、单处硬编码、注释出处」。出处=派发基线 2026-11-14（main `b5351b8`，
  Windows 全量口径：脚本 624、vitest 15/194、UI 4/31）。不读 `docs/task-plan.json`：该文件由主会话记账，
  并行 worker 禁改，数字随合并漂移时 workflow 侧必然滞后——「从 task-plan 读」需要主会话加字段与加载器，
  记入遗留问题（§7）。
- **平台差值显式建模**：`verify:cwd` 的 caseDrift 闸门在大小写敏感文件系统（ubuntu）固定 SKIP 7 项，这是
  脚本既有设计。看板按 `os.platform()` 调整：linux 时 cwd 预期 13−7=6、脚本合计预期 **617**；win32 预期
  13 / **624**。SKIP 不当漂移报，表头一行写明口径。
- **漂移方向区分**：低于基线 → `⚠️ drift` + `::warning::`；高于基线 → 行内注记 `above baseline (merged
  test additions?)`，同样只警告。并行 worker（W1/W3/W4）抬高数字时看板只响不红，属预期噪音，review 时在
  PR 里顺手 bump 基线常量即可。

### 4.4 失败绝不阻断（双保险 + 验证方式）

1. 脚本级：所有错误路径（日志缺失/无参数/解析异常/内部异常）统一转 `::warning title=X16 assertion
   dashboard::…` 注解，**恒 `process.exit(0)`**；
2. 步骤级：`continue-on-error: true` 兜底脚本自身崩溃（如 node 起不来）。
本机验证：故意改基线不匹配（sed 把 92→91、删 caliber 小结行）→ 表格出 drift/missing、注解出 2 条
warning、**exit=0**；缺日志/无参数 → warning + exit=0。真实「不红」的最终证据：PR run 中 dashboard 步骤
带 warning 而 job 绿（待主会话补录，verification.md §5）。看板只写 `$GITHUB_STEP_SUMMARY` 与注解，不写
工作区文件。

## 5. concurrency：维持现状 + 显式记录代价

按主会话建议默认（task-plan X16.history 2026-11-14）：**行为不变，注释与本文档记录取舍**。

- PR 侧：`cancel-in-progress` 是对的——旧 attempt 的结论不该被当当前结论读，且省额度。
- main push 侧：组仍是 `workflow + ref`，连续合并时前一个 run 被取消（实例 #34 的 run 43461685410 被 #35
  推送取消）。**后果：中间 commit 可能没有 completed run；一段 push 的最终态由最后一个 run 覆盖**。
  本仓 main 从不直接多人并行推代码（文档记账直推 + PR 合并，突发小），最终态覆盖即足够，接受。
- 改法备查（何时值得改）：若将来出现「bisect 需要每个 main commit 的红绿记录」或上 merge queue，把 push
  事件按 `github.sha` 分组或关 push 侧取消，代价是每突发多跑 N−1 个 run 的 Linux 分钟。workflow 注释里
  已写操作入口。

## 6. windows nightly 腿：本轮不做，评估如下

- **价值**：ubuntu 上 `verify:cwd` 的 7 项 caseDrift 断言永久 SKIP（X14 遗留 2）；windows 腿是唯一机器
  覆盖。缓解因素：本仓完成定义要求每次改动在 Windows Git Bash 复跑 verify（人肉覆盖存在），nightly 补的是
  「合并后无人再跑 Windows」的尾部风险。
- **成本估算（未实测）**：windows-latest 计费 2x；job 内容 = checkout + setup-node + npm ci +
  `npm run verify:cwd`。墙钟估 4–6 分钟（windows runner 冷启动 + install 明显慢于 ubuntu 的 12s，
  `verify:cwd` 本体 <5s）。每晚一次 ≈ 24–36 计费分钟/天 ≈ **12–18 小时计费/月**；Free 计划 2000 私有分钟/月
  时占比 60–90%，不可忽略（组织计划另算）。
- **可后补清单**（用户点头即可实施，预计半小时内）：`on.schedule` cron（如 `30 19 * * *` UTC，避开整点池
  竞争）+ `if: github.ref == 'refs/heads/main'` 的独立 job（windows-latest、timeout 15、复用 pin 好的
  actions 与 registry 两步）；不设必需检查；失败只发注解/通知。nightly 上跑完整 verify 链（624 口径）比只跑
  verify:cwd 更有信息量，但分钟数×6，默认只跑 `verify:cwd` 或看板全链二选一由用户裁。
- **本轮不做的原因**：额度成本未经用户批准（任务书 §4.5）。

## 7. 验证策略

- 本机（已完成，见 verification.md）：断言基线 624/194/31 复现；看板对真实日志零漂移；drift/缺日志
  exit=0；pipefail 语义；workflow YAML 解析 + 结构断言（job 名/步骤/continue-on-error/uses SHA）。
- 真实 CI（待主会话，verification.md §5 留了补录位）：PR run 注解对比（Node 20 警告消失）、看板 summary
  显示 ubuntu 617 口径全绿、故意制造一次基线不符证明不红（可在同一 PR 用临时 commit 或留待下次漂移观察）。

## 8. 遗留问题

1. **基线迁往 `docs/task-plan.json`**：本任务按任务书允许把基线硬编码在 workflow 脚本顶部（单处、带出处
   注释）。若要「task-plan 单一事实源 + 看板从 JSON 读」，需主会话在 task-plan 加结构化字段（含 per-script
   表 + 平台 skip 数）并改看板加载器——涉及并行 worker 记账时序，本任务不做。
2. **Dependabot bump 流未裁决**：pin SHA 的跟进现在是纯人工（§2.2）。`.github/dependabot.yml`
   （`package-ecosystem: github-actions`）可自动开 bump PR，但会引入一条常驻 PR 流与合并队列噪音，需用户
   拍板；拍板后单独小任务加文件即可。
3. **nightly 成本为估算**：§6 的 4–6 分钟墙钟是按 X14 ubuntu 实测（56s）与 windows runner 常识推的，未实测；
   真要上线先手动 `workflow_dispatch` 跑一晚拿实测分钟数。
4. **checkout v4→v7 跳了两个 major**：本 workflow 用法极窄（默认检出 + git status），取证已覆盖输入面；
   若真实 run 出现浅检出/凭证类异常，按 §2.1 取证法可退 v6.1.0
   （`d23441a48e516b6c34aea4fa41551a30e30af803`，同为 node24，待核验）再排查。
5. **`verify:export` 138 高于 X14 文档记录的 126**：为派发前已合并的增量（task-plan 基线 624 已含），看板
   采用派发基线；X14 verification.md 的旧表不再回改，历史文档按当时口径读。
