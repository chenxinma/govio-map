# X23 design：CI 断言数看板基线迁往 task-plan.json 单一事实源

## 1. 背景与动机

X16 交付的非门禁「断言数看板」（`.github/workflows/scripts/assertion-dashboard.mjs`）把基线**硬编码在脚本顶部**
（任务书 §4.3 允许的过渡做法：并行派发时 worker 不改 `docs/task-plan.json`，避免多分支同改冲突），并在
X16 `design.md` §8 遗留 1 明确记下「应迁往 task-plan 单一事实源」。

本轮 0.7.2（X18 +15 脚本断言、X19-W5b +31、X21 +1、X22 +5 vitest 例等）合并后，基线全面过期，
**每个 run 都产 6 条 warning**（PR #43 合并态 run `9ce7878` 实测）：

```
verify:ui          expected 4 files / 31 tests, got 4 / 37
verify:integration expected 15 files / 194 tests, got 20 / 278
script total       expected 617 on linux, got 664
verify:caliber-conflict  expected 46, got 77
verify:semantic-lineage  expected 48, got 54
verify:export            expected 138, got 148
```

看板**逻辑本身是正确的**：`664 = 671 − 7`（ubuntu 上 `verify:cwd` 的 caseDrift 闸门固定 SKIP 7 项，
属脚本既有设计而非漂移），平台差值建模无误；job 也仍然是绿的（非门禁）。问题只有两个：
① 基线数字过期 → 告警噪声长期污染 annotations，真漂移会被淹掉；② 基线有两处口径（task-plan 的
文字描述 + 脚本硬编码），必然继续漂移。

## 2. 方案

### 2.1 单一事实源：`docs/task-plan.json → verificationBaseline`

```jsonc
"verificationBaseline": {
  "updatedAt": "<ISO>",
  "source": "…说明看板从这里读…",
  "note": "…口径与维护约定…",
  "scripts": {                       // per-script 断言数（Windows 全量口径）
    "verify:manifest": 92, "verify:rerun": 71, "verify:audit": 119,
    "verify:export": 148, "verify:source-table": 39, "verify:semantic-lineage": 54,
    "verify:caliber-conflict": 77, "verify:cwd": 13, "verify:prompt-injection": 58
  },
  "scriptTotalWindows": 671,          // 声明总量，用于自检（见 2.3）
  "platformSkip": { "linux": { "verify:cwd": 7 } },   // 平台差值也是数据，不写死在代码里
  "vitest": {
    "verify:integration": { "files": 20, "tests": 278 },
    "verify:ui":          { "files": 4,  "tests": 37 }
  }
}
```

要点：
- **平台差值数据化**：原先代码里写死 `CWD_LINUX_SKIP = 7` 且只对 `verify:cwd`、只在 linux 生效；
  现在 `platformSkip[platform][script]` 是通用映射，将来任何脚本在任何平台有固定 SKIP 都只改数据。
- **维护约定写进字段自身**（`note`）：合并了改变断言数的 PR 后必须同步更新本对象——这条纪律以前只存在于
  X16 的 design.md 里，现在跟数据放在一起，改数字的人一定会看到。

### 2.2 加载器与降级（`loadBaseline()`）

- 路径解析：`fileURLToPath(new URL("../../../docs/task-plan.json", import.meta.url))`——相对脚本自身定位，
  CI 与本地都成立，不依赖 cwd；`ASSERTION_DASHBOARD_BASELINE` 环境变量可覆盖（**仅测试钩子**，CI 不设）。
- 形状校验：`scripts` 非空且每项为非负整数；`vitest` 非空且每项为整数 `{files, tests}`；`platformSkip`
  可选、存在则同规则校验。
- **降级优先于报错**：文件读不到 / JSON 损坏 / 字段缺失 / 形状非法 → 一条 warning
  （`baseline unavailable (…); reporting actual values only, no comparison`）+ 表格改为「只列实际值、
  期望列写 `— (no baseline)`、verdict 标 `⚠️ missing`」+ **exit 0**。
  关键取舍：**基线缺失绝不能长得像漂移**（不逐脚本报 expected/got），也绝不能让 job 变红。
- 所有异常仍被最外层 `try/catch` 兜住，脚本恒 `process.exit(0)`；workflow 侧 `continue-on-error: true`
  是第二重保险（X16 的双保险设计原样保留）。

### 2.3 声明总量自检

`scriptTotalWindows` 只是**人读的口径声明**，比对一律用 `sum(scripts)`（按平台扣 `platformSkip` 后）。
两者不符时产一条 hygiene warning（`scriptTotalWindows (999) != sum(scripts) (671); using sum(scripts)`）
并继续跑——避免「声明数字忘了改」把整张表带偏。

## 3. 取舍

1. **为什么不把看板做成 `scripts/verify-*.ts` 进 `npm run verify` 链**：看板是 CI 观测件，不是产品断言；
   进链会改变脚本断言总数（又要回头改基线），且本地跑 verify 时没有 CI 日志可解析。保持 X16 的定位
   （workflow 内独立步骤 + 本地可用真实日志手动跑）。
2. **为什么保留 env 覆盖钩子**：降级与漂移路径必须可测（验收要求「故意造一次漂移确认只 warning 不红」），
   没有钩子就得反复改仓库里的 task-plan.json 再还原，既脏又容易漏还原。钩子只影响基线来源，
   看板本身非门禁，不构成削弱门禁的通道。
3. **为什么不顺手把 X16 遗留 2（Dependabot）/3（nightly 成本实测）一起做**：都需用户裁决或真实额度，
   与本任务无关，维持在 X16 遗留清单里。
4. **标题从「X16 assertion dashboard」改为「Assertion dashboard」**：step summary 是长期观测件，
   不该绑在某个任务号上；来源与历史在页脚注明（X16 引入、X23 迁基线）。

## 4. 验收对照

| acceptance | 落地 |
|---|---|
| 基线单一事实源为 task-plan（脚本内不再硬编码数字） | §2.1/§2.2；脚本内已无任何断言数常量 |
| 刷新后真实 run 无基线漂移 warning | 基线刷到 671 / 20·278 / 4·37；本地 9 项矩阵实测（verification.md §1）+ **真实 run 43664705420 annotations = 0**（verification.md §3） |
| 看板失败/基线缺失均不阻断（job 绿） | 降级四路（文件缺失/JSON 损坏/字段缺失/形状非法）实测 exit 0、单条 warning |
| required check 名不变 | `build + lint + verify` 未动（仅改注释） |
| build/lint/verify 全绿且断言数与刷新后基线一致 | verification.md §2 |

## 5. 遗留问题

1. **基线仍需人工同步**：改了断言数的 PR 若忘记更新 `verificationBaseline`，看板会 warn（非门禁）。
   彻底自动化需要「从 verify 输出反写基线」的机器人步骤，涉及写权限与噪音 PR，暂不做。
2. ~~**ubuntu 侧 664 是推算值**~~ → **已实测坐实**（2026-11-15，PR #44 的 run 43664705420）：ubuntu 日志逐脚本
   `92/71/119/148/39/54/77/6/58 = 664`，与 `671 − platformSkip.linux."verify:cwd"(7)` 完全一致，annotations 为 0。
3. **`ASSERTION_DASHBOARD_BASELINE` 是测试钩子**：CI 不设；若将来有人在 workflow 里设它指向别的文件，
   等于换基线来源——已在脚本头注释写明用途。
4. **vitest 的 `files` 数对基线敏感**：新增测试文件会同时改 files 与 tests，两处都要更新（已写进 `note`）。
