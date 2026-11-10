# X11 验证记录

环境：Windows / Git Bash，node v24.16.0，仓库 `D:/Work/gov-io/govio-map`（分支 `main`）。
所有命令在仓库根目录执行。

## 1. 构建 + Lint

```bash
npm run build     # tsc -b && vite build && npm run compile:server
npm run lint      # eslint .
```

```
build=0   ✓ built in ~7.8s；dist-server/cli.mjs 151.7kb（esbuild Done）
lint=0    （无任何 warning/error 输出）
```

构建日志里的 `(!) Some chunks are larger than 700 kB` 为**既有现象**，与本次变更无关——已做对照验证：把本任务三个文件 `git stash push -u` 后单独 `npm run build`，同一告警照旧出现（本次仅新增约 10KB 源码，未引入任何新依赖）。

## 2. Tailwind 类名生成（`INPUT_CLASS` 常量抽取无样式回归）

```bash
CSS=$(ls dist/assets/*.css | head -1)   # dist/assets/index-D5aftXej.css
for c in 'bg-bg-primary' 'placeholder\:text-text-dim' 'focus\:border-brand\/50' 'border-error\/60' 'text-error' 'px-2\.5' 'h-9' 'rounded-md'; do
  printf '%-32s %s\n' "$c" "$(grep -cF -- "$c" "$CSS")"
done
```

```
bg-bg-primary                    1
placeholder\:text-text-dim       1
focus\:border-brand\/50          1
border-error\/60                 1     ← 本次新引入的错误态边框，已生成
text-error                       1
px-2\.5                          1
h-9                              1
rounded-md                       1
```

结论：把重复 class 串抽成模块级常量后，Tailwind v4 仍能从字面量扫到全部类名。

## 3. `npm run verify`（既有断言零回归 + 新增用例）

```bash
npm run verify
```

| 子脚本 | 结果 |
|---|---|
| verify:manifest | 共 92 项断言，失败 0 项 |
| verify:rerun | 共 71 项断言，失败 0 项 |
| verify:audit | 共 119 项断言，失败 0 项 |
| verify:export | 共 126 项断言，失败 0 项 |
| verify:source-table | 共 39 项断言，失败 0 项 |
| verify:semantic-lineage | 共 45 项断言，失败 0 项 |
| verify:caliber-conflict | 46/46 checks passed |
| verify:cwd | 共 13 项断言，失败 0 项 |
| verify:prompt-injection | 58/58 通过 |
| verify:integration (vitest) | **Test Files 7 passed (7) / Tests 82 passed (82)** |

`verify` 退出码 0；脚本断言合计 **609 项，0 失败**。

**断言数变化**（vitest 集成测试）：

| | Test Files | Tests |
|---|---|---|
| 修复前（基线，`npx vitest run`） | 6 passed (6) | 67 passed (67) |
| 修复后 | 7 passed (7) | 82 passed (82) |
| 变化 | **+1 文件** | **+15 用例，既有 67 例全绿零回归** |

新增文件：`tests/integration/settings-provider-drafts.test.ts`（15 例，覆盖 uid 与名称解耦、`toDrafts`/`toConfig` 往返与落盘语义、空名/重名校验、`canSaveDrafts`、`suggestProviderName`，外加 SettingsModal 源码契约 2 例）。

```bash
npx vitest run tests/integration/settings-provider-drafts.test.ts
# Test Files  1 passed (1) / Tests  15 passed (15) / Duration ~0.3s
```

verify 全跑后工作区仅剩本任务预期变更（无脚本残留物）：

```bash
git status --porcelain
 M src/components/SettingsModal.tsx
?? docs/tasks/X11-settings-provider-name-input/
?? src/utils/provider-drafts.ts
?? tests/integration/settings-provider-drafts.test.ts
```

## 4. 真实浏览器冒烟（CDP + 真实按键事件）

前端无 DOM 测试基建（vitest `environment: node`，无 jsdom/@testing-library），故用 moli 的 headless Chromium 走 CDP，`Input.dispatchKeyEvent` 发**真实按键**驱动，脚本存于本目录 `smoke-browser-cdp.mjs`。

复跑方式：

```bash
npm run dev                                   # 前台，等 5173/5174 就绪
moli serve --layout &                         # CDP 端点 http://127.0.0.1:9222
node docs/tasks/X11-settings-provider-name-input/smoke-browser-cdp.mjs
```

### 4.1 负对照：旧代码（`git show HEAD:src/components/SettingsModal.tsx`）→ 复现用户症状

```
PASS  应用加载完成（header 设置按钮可见）
PASS  LLM 设置对话框打开且 provider name 输入框已渲染  | value="deepseek-my"
PASS  输入前焦点落在 provider name 输入框
FAIL  连续输入 7 个字符，值累积为 "deepseek-myhotfix1"  | ["deepseek-myh","deepseek-myh","deepseek-myh","deepseek-myh","deepseek-myh","deepseek-myh","deepseek-myh"]
FAIL  每次按键后 DOM 节点未被重挂载（dataset 标记仍在）  | [false,false,false,false,false,false,false]
FAIL  每次按键后焦点仍在输入框（光标不跳走）            | [false,false,false,false,false,false,false]
FAIL  光标位置随输入推进至末尾                          | [12,12,12,12,12,12,12]
FAIL  连续退格可清空名称（空名不再被吞）                | {"value":"deepseek-myh","sameNode":false,"focused":false,"err":false,"saveDisabled":false}
FAIL  清空过程仍聚焦、节点未重挂载                      | 同上
FAIL  空名 → 就地提示「Provider 名称不能为空」且保存禁用 | 同上
PASS  重名提示（provider 数 < 2，跳过）
PASS  Esc 关闭对话框（未保存，无配置副作用）

合计 12 项，失败 7 项
```

关键点：**只有第 1 个字符进了输入框**（`deepseek-myh`），之后每键 `sameNode=false`（节点被重建）、`focused=false`（焦点丢失）——与用户描述「每输入一个字符光标就跳开」完全一致；退格清空也被旧 `!newName.trim()` early-return 吞掉（值回弹）。

### 4.2 修复后（最终工作区代码）→ 13/13 全绿

```
PASS  应用加载完成（header 设置按钮可见）
PASS  LLM 设置对话框打开且 provider name 输入框已渲染  | value="deepseek-my"
PASS  输入前焦点落在 provider name 输入框
PASS  连续输入 7 个字符，值累积为 "deepseek-myhotfix1"  | ["deepseek-myh","deepseek-myho","deepseek-myhot","deepseek-myhotf","deepseek-myhotfi","deepseek-myhotfix","deepseek-myhotfix1"]
PASS  每次按键后 DOM 节点未被重挂载（dataset 标记仍在）  | [true,true,true,true,true,true,true]
PASS  每次按键后焦点仍在输入框（光标不跳走）            | [true,true,true,true,true,true,true]
PASS  光标位置随输入推进至末尾                          | [12,13,14,15,16,17,18]
PASS  连续退格可清空名称（空名不再被吞）                | {"value":"","sameNode":true,"focused":true,"err":true,"errSpans":2,"saveDisabled":true}
PASS  清空过程仍聚焦、节点未重挂载                      | 同上
PASS  空名 → 就地提示「Provider 名称不能为空」（卡片内 + 页脚共 2 处）且保存禁用 | errSpans=2, saveDisabled=true
PASS  新增第二个 provider 不重挂载既有卡片（首卡 dataset 标记仍在） | {"added":true,"count":1}
PASS  改名为已有 provider "provider1" → 提示名称重复且保存禁用 | {"dup":true,"dupSpans":3,"saveDisabled":true}
PASS  Esc 关闭对话框（未保存，无配置副作用）

合计 13 项，失败 0 项
```

### 4.3 冒烟测试的已知限制

- moli headless 布局下 `position: fixed` 的 portal 覆盖层 `getBoundingClientRect()` 为 0×0，`document.body.innerText` 取不到覆盖层文本（`textContent` 正常）→ 文案断言统一改用 `textContent` + `span.text-error` DOM 查询（`errSpans` / `dupSpans` 计数）。**红字提示与对话框布局需在真实浏览器目视确认**（见 §6 待用户确认项）。
- 冒烟全程未点击「保存」，最后以 Esc 关闭。已核查落盘配置未被改动：`~/.pi/agent/models.json` mtime 仍为 `Nov 8 13:47`（早于本次冒烟），`jq '.providers | keys'` 仍为 `["deepseek-my"]`。

## 5. 静态源码契约（防回归）

`tests/integration/settings-provider-drafts.test.ts` 最后一个 describe 直接读 `src/components/SettingsModal.tsx` 源码断言：

- 必须含 `key={draft.uid}`；必须不含 `key={name}` / `key={draft.name}` / `key={provider`
- 名称输入框必须 `value={draft.name}` + `onChange={(e) => updateName(draft.uid, e.target.value)}`

即"用可编辑值当 React key"这一根因被测试钉死，后续重构若改回即失败。

## 6. 待用户确认（人工验收项）

1. 真实浏览器打开 LLM 设置，provider name 连续输入/退格/粘贴，光标不跳
2. 名称清空或改成重复名时，输入框下方与页脚出现红字提示、保存按钮置灰
3. 对话框视觉与修复前一致（输入框高度/内边距/占位符色、删除按钮与输入框对齐；错误文案出现时删除按钮不跳动）
4. 正常改一个 provider 名并保存 → 重新打开显示新名字、模型下拉与 apiKey 掩码不回归
