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
| verify:integration (vitest) | **Test Files 7 passed (7) / Tests 83 passed (83)** |

`verify` 退出码 0；脚本断言合计 **609 项，0 失败**。

**断言数变化**（vitest 集成测试）：

| | Test Files | Tests |
|---|---|---|
| 修复前（基线，`npx vitest run`） | 6 passed (6) | 67 passed (67) |
| 修复后 | 7 passed (7) | 83 passed (83) |
| 变化 | **+1 文件** | **+16 用例，既有 67 例全绿零回归** |

新增文件：`tests/integration/settings-provider-drafts.test.ts`（16 例，覆盖 uid 与名称解耦、`toDrafts`/`toConfig` 往返与落盘语义、空名/重名校验、`canSaveDrafts`、`suggestProviderName`，外加 SettingsModal 源码契约 3 例：key 用 uid、名称受控、**高度类一致**）。

```bash
npx vitest run tests/integration/settings-provider-drafts.test.ts
# Test Files  1 passed (1) / Tests  16 passed (16) / Duration ~0.3s
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
- 进一步实测（§7.3）：即使 `Emulation.setDeviceMetricsOverride` 固定视口、把覆盖层临时改成 `position:absolute` + 显式宽高，moli 仍**不对这些元素做布局**（rect 恒为 0，`getComputedStyle().flex` 也不解析 `flex:1` 简写，恒返回 `0 1 auto`）→ 该环境**无法用于任何高度/间距类视觉验证**，只能靠 CSS 推理 + 真实浏览器目视。
- 冒烟全程未点击「保存」，最后以 Esc 关闭。已核查落盘配置未被改动：`~/.pi/agent/models.json` mtime 仍为 `Nov 8 13:47`（早于本次冒烟），`jq '.providers | keys'` 仍为 `["deepseek-my"]`。

## 5. 静态源码契约（防回归）

`tests/integration/settings-provider-drafts.test.ts` 最后一个 describe 直接读 `src/components/SettingsModal.tsx` 源码断言：

- 必须含 `key={draft.uid}`；必须不含 `key={name}` / `key={draft.name}` / `key={provider`
- 名称输入框必须 `value={draft.name}` + `onChange={(e) => updateName(draft.uid, e.target.value)}`

即"用可编辑值当 React key"这一根因被测试钉死，后续重构若改回即失败。

## 6. 待用户确认（人工验收项）

1. ~~真实浏览器打开 LLM 设置，provider name 连续输入/退格/粘贴，光标不跳~~ → **用户已确认修复（2026-11-10）**
2. ~~名称输入框高度与其它输入框一致~~ → 用户验收时发现偏矮，已追加修复，见 §7；**需再次目视确认**
3. 名称清空或改成重复名时，输入框下方与页脚出现红字提示、保存按钮置灰
4. 对话框视觉与修复前一致（输入框内边距/占位符色、删除按钮与输入框对齐；错误文案出现时删除按钮不跳动）
5. 正常改一个 provider 名并保存 → 重新打开显示新名字、模型下拉与 apiKey 掩码不回归

## 7. 追加修复：名称输入框高度偏矮（用户验收反馈 2026-11-10）

### 7.1 现象与根因

用户反馈：光标问题已修复，但 provider name 输入框比其它输入框**矮**。

根因是本次改造引入的回归：为了在名称下方放错误文案，把名称 input 包进了新的 wrapper
`<div className="flex-1 flex flex-col gap-1">`，而 input 自身仍保留修复前的 `flex-1`：

```tsx
<div className="flex items-start justify-between gap-2">   {/* 行方向 */}
  <div className="flex-1 flex flex-col gap-1">             {/* ← 新增：列方向 wrapper */}
    <input className="flex-1 h-9 ..." />                    {/* ← flex-1 此时作用在纵轴 */}
```

修复前该 input 的父级是**行**方向 flex，`flex-1` 只影响宽度，高度由 `h-9` 决定；改造后父级变成
**列**方向 flex，`flex-1`（构建产物 CSS 实测为 `.flex-1{flex:1}` → `flex: 1 1 0%`）的 `flex-basis: 0%`
作用到纵轴，按 flex 规范**覆盖** `height: 36px` 成为主轴尺寸 → 输入框被压扁，比同为 `h-9` 的
Base URL / API 类型 / API Key 明显矮一截。

### 7.2 修复

名称 input 的 `flex-1` → `w-full`（宽度改由外层 wrapper 的 `flex-1` 在行方向撑开），高度回归 `h-9`：

```diff
-                      className={`flex-1 h-9 ${INPUT_CLASS} ${
+                      className={`w-full h-9 ${INPUT_CLASS} ${
```

并在 JSX 里留注释说明「flex-col 父级里不要用 flex-1」。模型行的 `flex-1 h-8` 父级仍是行方向 flex，
用法正确，未改动。

### 7.3 验证

1. **源码契约断言**（`tests/integration/settings-provider-drafts.test.ts` 新增第 16 例）：必须含
   `w-full h-9 ${INPUT_CLASS}`；必须不含 `flex-1 h-9`；`h-9 ${INPUT_CLASS}` 恰好 4 处（名称 / Base URL /
   API 类型 / API Key，高度同源）；`flex-1 h-8 ${INPUT_CLASS}` 恰好 2 处（模型行，父级为 flex-row）。
2. **CSS 事实核查**：`grep -o '\.flex-1{[^}]*}' dist/assets/index-*.css` → `.flex-1{flex:1}`，
   `grep -o '\.h-9{[^}]*}'` → `.h-9{height:calc(var(--spacing) * 9)}`，确认根因推理中的类语义无误。
3. **门槛复跑全绿**：`npm run build` = 0、`npm run lint` = 0、`npm run verify` = 0
   （脚本断言 609 项 0 失败；vitest **Test Files 7 / Tests 83**，即 82 → 83，+1 例，既有零回归）。
4. **浏览器功能冒烟复跑**：`smoke-browser-cdp.mjs` 13/13 全绿（功能未因样式改动回归）。
5. **高度无法在 moli 中量化**：尝试 `Emulation.setDeviceMetricsOverride(1440×900)` + 把 portal 覆盖层临时改为
   `position:absolute; width:1440px; height:900px` 后测量，所有元素 rect 仍恒为 0，inline `flex:1 1 0%` 也不被解析
   （`getComputedStyle().flex` 恒返回 `0 1 auto`）→ 该 headless 环境不具备可用布局能力，高度一致性只能由
   上面的类名/CSS 事实推理 + **真实浏览器目视确认**（§6.2）。
