# X12 验证记录

环境：Windows，Node v24.16.0，npm 11.18.0，Orca worktree
`C:/Users/Administrator/orca/workspaces/govio-map/x12-ui-test-infra`。

## 1. 基线（安装 DOM 依赖前）

任务书给定基线（commit `5bf483f`）：`npm run verify` 约 **36s**，专项脚本
609 项断言、Vitest 7 文件/83 例。

本 worktree 的 setup hook 先恢复了 package，但未生成 `node_modules/.bin`；执行
`npm install --ignore-scripts` 恢复 bin 链接。该节点环境还存在 Node 24 Windows
`os.userInfo()` → `uv_os_get_passwd ENOMEM` 的沙箱问题；为让 `tsx` 运行，验证命令
使用临时进程级 shim（只提供 `USERNAME`，不改仓库脚本/业务代码）：

```text
NODE_OPTIONS=--require=./.codex-node-shim.cjs
```

临时 shim 不属于交付物，提交前已移除。项目代码和验证断言未因该环境问题修改。

## 2. 安装 DOM 依赖后、新增 UI 用例前的 83 例回归

命令：

```powershell
$env:NODE_OPTIONS="--require=./.codex-node-shim.cjs"
$sw=[Diagnostics.Stopwatch]::StartNew(); npm.cmd run verify
"$([math]::Round($sw.Elapsed.TotalSeconds,2))s"
```

结果：

```text
verify:manifest          92 assertions, 0 failed
verify:rerun             71 assertions, 0 failed
verify:audit            119 assertions, 0 failed
verify:export           126 assertions, 0 failed
verify:source-table      39 assertions, 0 failed
verify:semantic-lineage  45 assertions, 0 failed
verify:caliber-conflict  46/46 checks passed
verify:cwd               13 assertions, 0 failed
verify:prompt-injection  58/58 passed
verify:integration       7 files / 83 tests passed
VERIFY_EXIT=0
VERIFY_SECONDS=41.46
```

结论：安装 DOM 依赖不回归既有 609 项专项断言或 83 例集成测试。

## 3. 新增 UI 用例

```text
npm run verify:ui

Test Files  2 passed (2)
Tests       16 passed (16)
Duration    2.92s
```

覆盖：`SettingsModal` 11 例、`SourceTableNode` 5 例。

## 4. 完整门槛

```text
npm run build   # exit 0（21.72s；含 tsc -b、Vite、esbuild server bundle）
npm run lint    # exit 0（无 warning/error）
npm run verify  # exit 0（47.39s）
```

`verify` 末尾的关键输出：

```text
verify:integration   Test Files  9 passed (9)
                     Tests       99 passed (99)
verify:ui             Test Files  2 passed (2)
                     Tests       16 passed (16)
VERIFY_EXIT=0
VERIFY_SECONDS=47.39
```

### 断言/用例数

| 指标 | 基线 | 完成后 | 变化 |
|---|---:|---:|---:|
| 专项脚本断言 | 609 | 609 | 0（零回归） |
| Vitest 唯一文件 | 7 | 9 | +2 |
| Vitest 唯用例 | 83 | 99 | +16 |
| `verify:ui` 定向用例 | 0 | 16 | +16 |

### 耗时

| 口径 | 耗时 |
|---|---:|
| 任务书基线 | 36s |
| 本 worktree 安装依赖后、UI 用例前 | 41.46s |
| 本 worktree 完整完成后 | 47.39s |
| 相对任务书基线增量 | +11.39s（≤60s） |
| 相对本 worktree 依赖后基线增量 | +5.93s |

完整链包含 `verify:integration` 的 99 例全量以及 `verify:ui` 的 16 例定向重复；
重复约 2.8s，换取既有 `verify:integration` 命令及其顺序不改。

## 5. 反向验证（真实输出）

### 5.1 `key={draft.uid}` → `key={name}`

临时把 provider card 的 key 改为可编辑名称后运行：

```text
npm run verify:ui -- -t 连续输入

FAIL tests/ui/settings-modal.test.tsx > SettingsModal 交互回归
  > 连续输入时值累积、焦点留在同一 DOM 节点、选区推进到末尾
AssertionError: expected 'alpha-' to be 'alpha-beta'
Expected: "alpha-beta"
Received: "alpha-"

Test Files  1 failed | 1 skipped (2)
Tests       1 failed | 15 skipped (16)
```

结论：X11 缺陷①已被组件测试真实拦住；首个替换字符后节点身份丢失。

### 5.2 `w-full h-9` → `flex-1 h-9`

临时把名称 input 改回 `flex-1 h-9` 后运行完整 UI 组：

```text
npm run verify:ui

Test Files  2 passed (2)
Tests       16 passed (16)
Duration    2.85s
```

结论：**jsdom 无布局引擎，无法捕获该高度/主轴回归**。补偿手段是保留 X11 既有
源码契约断言：

```text
tests/integration/settings-provider-drafts.test.ts:211
  expect(src).toContain("w-full h-9 ${INPUT_CLASS}");
tests/integration/settings-provider-drafts.test.ts:212
  expect(src).not.toContain("flex-1 h-9");
```

该断言仍由 `verify:integration` 执行。若后续要求自动量化真实高度，需按 design.md
的 B/C 方案引入真浏览器并固定浏览器二进制。

### 5.3 还原证明

两次反向修改后均恢复源码。还原后的直接证据：

```powershell
git diff -- src/components/SettingsModal.tsx
# 无输出
git diff --stat -- src/components/SettingsModal.tsx
# 无输出
rg -n "key=\{draft\.uid\}|w-full h-9" src/components/SettingsModal.tsx
# 149: key={draft.uid}
# 160: className={`w-full h-9 ${INPUT_CLASS} ${
```

`git status --porcelain` 只剩本任务预期文件（当时尚未提交；临时 Node shim 已列入
待清理，不属于提交内容）：

```text
 M package-lock.json
 M package.json
 M vitest.config.ts
?? .codex-node-shim.cjs
?? .codex-node-shim.mjs
?? tests/ui/
```

## 6. 提交前清洁门槛

提交前删除临时 Node shim，并按任务要求执行：

```text
npm run build
npm run lint
npm run verify
git status --porcelain
```

最终结果记录于本任务汇报：三门槛均为 0，提交后 `git status --porcelain` 为空；
源码文件 `src/components/SettingsModal.tsx` 的 diff 为空。
