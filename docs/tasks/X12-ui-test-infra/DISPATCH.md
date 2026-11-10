# X12 任务书：前端 UI 回归测试基建（组件级交互测试 + 可选真实布局能力）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X12")`（含 scope/acceptance，即验收契约）。

## 1. 背景与动机

govio-map 有完善的**纯逻辑/后端**验证门槛（`npm run verify` = 9 个 `tsx scripts/verify-*.ts` + `vitest run`），但**前端组件层零自动化测试**：`vitest.config.ts` 固定 `environment: "node"`，devDependencies 里没有任何 DOM 测试库。

刚验收的 X11 暴露了代价（完整证据见 `docs/tasks/X11-settings-provider-name-input/`）：
1. **缺陷①（功能）**：`SettingsModal` 用可编辑的 provider 名称当 React `key`（`key={name}`），每敲一个字符整卡片重挂载 → 输入框失焦、无法连续输入。
2. **缺陷②（视觉）**：修①时把名称 input 包进 `flex-col` wrapper 却留着 `flex-1`，`flex:1 1 0%` 的 flex-basis 作用到纵轴压扁了 `h-9` → 输入框比同行其它输入框矮。**这一条是用户肉眼发现的**，自动化完全没拦住。

当时只能靠两种临时手段兜底：一次性 moli CDP 脚本（真实按键）+ 源码字符串契约断言（`expect(src).toContain("key={draft.uid}")`）。而且实测发现 **moli headless 不做布局**：元素 `getBoundingClientRect()` 恒为 0×0、不解析 `flex` 简写（`getComputedStyle().flex` 恒返回 `0 1 auto`），`Emulation.setDeviceMetricsOverride` + 把 `position:fixed` 改 `absolute` 都无效 → moli **不能**承担任何高度/间距/对齐类视觉验证。

**目标**：给前端建立可常态化的 UI 回归测试基建并纳入 `npm run verify` 门槛，首批覆盖 `SettingsModal` 与至少 1 个画布节点组件；同时对「视觉/布局类回归能否被自动捕获」给出明确结论与补偿手段。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、worker 完成定义、环境约定、PR 门禁）
2. `.pi/APPEND_SYSTEM.md`（运行时硬约束；本任务基本不碰 SQL/CLI，但约定需知）
3. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X12")` 的 `note` / `scope` / `acceptance`
4. `docs/tasks/X11-settings-provider-name-input/design.md`（遗留问题 1/2 = 本任务动机）与 `verification.md` §4.3 / §7.3（moli 布局限制的实测记录）
5. `docs/tasks/X4-test-infra/`（既有测试基建的选型取舍与约定：断言风格、node 环境、stub 范式）
6. `vitest.config.ts`、`package.json`（scripts + devDependencies）、`tsconfig.json` 及 4 个被引用的 tsconfig
7. `tests/integration/` 全部 7 个测试文件（学习既有范式，尤其 `canvas-store.test.ts` 的 `vi.stubGlobal("localStorage", ...)`、`govio-canvas-extension.test.ts` 的 stub pi + `vi.mock`、`settings-provider-drafts.test.ts` 的纯逻辑 + 源码契约断言）
8. `src/components/SettingsModal.tsx`（首批被测对象，285 行）与 `src/utils/provider-drafts.ts`（其纯逻辑已被 16 例覆盖，UI 测试**不要重复**测纯逻辑）
9. `src/components/Nodes/`（自选 1 个节点组件作为第二个被测对象，如 `SourceTableNode.tsx`：字段表、FK 徽标、`引用` / `复制全限定名` 按钮）
10. `eslint.config.js`（flat config；`eslint .` 覆盖 tests/，注意 `react-refresh/only-export-components` 与 `react-hooks` 规则）

## 3. 实证事实（主会话已调研，避免重复踩坑）

**测试基建现状**：
- `vitest.config.ts`：`environment: "node"`、`globals: false`（显式从 vitest 导入 describe/it/expect）、`include: ["tests/integration/**/*.test.ts"]`、`testTimeout/hookTimeout: 20_000`、`isolate: true`（注释说明各测试持有一次性单例状态，按文件隔离进程）
- devDependencies（全量）：`@eslint/js ^10.0.1`、`@tailwindcss/vite ^4.3.3`、`@types/node ^26.6.4`、`@types/react ^19.3.0`、`@types/react-dom ^19.3.0`、`@types/ws`、`@vitejs/plugin-react ^6.1.2`、`esbuild`、`eslint ^10.12.0`、`eslint-plugin-react-hooks ^7.1.1`、`eslint-plugin-react-refresh ^0.5.7`、`globals`、`tailwindcss ^4.3.3`、`tsx ^4.23.15`、`typescript ~6.0.3`、`typescript-eslint ^8.71.1`、`vite ^8.3.3`、`vitest ^5.1.0`
- **无** jsdom / happy-dom / @testing-library/* / playwright / puppeteer（`node_modules` 与 `npm ls -g` 均已核查为空）；React 19 → 若选 @testing-library/react 需 v16+，user-event 需 v14+
- vite 8 是 rolldown 内核（构建日志有 `build.rolldownOptions` 与 `[PLUGIN_TIMINGS]`），选 vitest browser mode / Playwright 时注意与 vite 8 + vitest 5 的版本匹配，**装完必须先跑一次既有 83 例确认无回归**
- `tsconfig.json` 只 references 4 个：`tsconfig.app.json`(include `src`)、`tsconfig.node.json`(`vite.config.ts`)、`tsconfig.server.json`(`server`)、`tsconfig.scripts.json`(`scripts` + `src/types/plotly.d.ts`) → **`tests/` 不在任何 include 内，`npm run build`(tsc -b) 不检查测试文件**（vitest 只转译不类型检查）。是否补 `tsconfig.tests.json` 由你取舍，但要写清理由
- eslint flat config：`globalIgnores(['dist', '.venv', '.delta'])`，`files: ['**/*.{ts,tsx}']` → **tests/ 与新配置文件都会被 lint**，`ecmaVersion: 2020`、`globals: globals.browser`

**门槛与耗时基线（主会话实测于 commit `5bf483f`，Windows/Git Bash）**：
- `npm run verify` 全链 **36s**，退出码 0；其中 `vitest run` 约 3.6s（7 文件 83 例）
- 专项脚本断言合计 **609 项 0 失败**：manifest 92 / rerun 71 / audit 119 / export 126 / source-table 39 / semantic-lineage 45 / caliber-conflict 46 / cwd 13 / prompt-injection 58
- 你的增量预算：**verify 总耗时增加 ≤60s**（即 ≤ 约 96s），必须在 `verification.md` 记录前后实测耗时与命令

**被测组件的可测点（`src/components/SettingsModal.tsx`，X11 修复后形状）**：
- 通过 `createPortal(..., document.body)` 渲染；props：`initialConfig: ModelsConfig | null`（为 null 时渲染「正在加载配置...」骨架）、`onSave(config)`、`onClose()`
- 稳定选择器：`input[placeholder="provider name"]`、`input[placeholder="https://api.example.com"]`（Base URL）、`input[placeholder="openai-completions"]`（API 类型）、`input[type="password"]`（API Key）、`input[placeholder="模型 ID"]`、`input[placeholder="显示名称（可选）"]`；按钮：`添加 Provider`、`添加模型`、`保存`、`取消`、`title="删除 provider"`、`title="删除模型"`
- 状态由 `src/utils/provider-drafts.ts` 驱动：卡片 `key={draft.uid}`（稳定）、名称 input `w-full h-9`、错误文案 `Provider 名称不能为空` / `Provider 名称重复："x"`（`span.text-error`，卡片内 + 页脚共 2 处）、`保存` 按钮 `disabled` 由 `canSaveDrafts` 决定、Esc 关闭、点遮罩关闭（内层 `stopPropagation`）
- 落盘形状由 `toConfig` 决定（trim 名称、丢空名、过滤空模型 id、全空回填 `[{id:""}]`）→ UI 测试请通过 `onSave` 收到的对象断言，**不要重复测 `toConfig` 本身**（已有 16 例纯逻辑覆盖）

**X11 遗留的两条反向验证锚点（acceptance 要求实测）**：
- `src/components/SettingsModal.tsx:149` → `key={draft.uid}`（改回 `key={name}` 应导致「连续输入」类用例失败）
- `src/components/SettingsModal.tsx:160` → `className={`w-full h-9 ${INPUT_CLASS} ...`}`（改回 `flex-1 h-9` 属于**布局类**回归：jsdom 无布局引擎，大概率测不出来 → 若你选 A 方案，必须在 design.md 明说并给出补偿手段，例如保留/加强源码契约断言）

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **选型与取舍（写入 design.md）**：对比 A（jsdom + @testing-library/react + @testing-library/user-event，vitest 按文件切环境）/ B（Playwright 真浏览器 E2E 或组件测试）/ C（vitest browser mode，走 playwright/webdriverio provider）/ D（仅静态约束，如 ESLint 规则禁止「可编辑值当 React key」、class 冲突检查），给出三维对比表：**依赖体积与安装成本 / verify 耗时增量 / 可测范围（尤其能否测布局与高度）**。建议默认落 A（必要时叠加 D 作补充）；若选 B 或 C，必须先给出浏览器二进制下载、耗时与离线可重复性的评估结论，且不得让 `npm run verify` 依赖网络。
2. **基建落地**：只加 **devDependencies**；让 DOM 测试与既有 node 测试共存——两种做法自选并说明：① 文件头 docblock `// @vitest-environment jsdom`（改动最小）；② `test.projects`（vitest 5 的多项目配置，node 项目保持 `tests/integration/**`，DOM 项目用新目录如 `tests/ui/**`）。**既有 7 个测试文件必须照旧全部跑在 node 环境且全绿**；不要为了新基建改动它们的断言。若补 `tsconfig.tests.json`，注意不要让 `npm run build` 的 project references 变复杂或变慢（并说明取舍）。
3. **首批用例（≥12 例，全部通过）**：
   - `SettingsModal`（主体）：连续输入多个字符后值累积且**同一个 DOM 节点**（可用 `data-*` 标记或比较元素引用，复现 X11 缺陷①的断言方式）、光标/选区位置推进、清空名称出现「不能为空」提示且保存禁用、改成与另一个 provider 同名出现「名称重复」提示且保存禁用、`添加 Provider` 后既有卡片节点不被重挂载、增删模型行、`取消` 与 Esc 与点遮罩三种关闭路径都调用 `onClose`、`onSave` 收到的对象形状正确（含 trim 与空模型过滤）、`initialConfig=null` 时渲染加载骨架
   - 至少 1 个画布节点组件（如 `SourceTableNode`）：字段行渲染、FK 徽标/`references` 呈现、`引用` 按钮点击回调、缺失可选字段（无 `qualifiedName`/`datasourceType`）时的回退显示不崩
   - 每条链路至少 1 个失败/边界用例（沿用 X4 约定）
4. **门槛接入**：新增 `npm run verify:ui`（或等价脚本）并挂进 `npm run verify` 聚合链（保持既有 10 个子脚本顺序与输出风格）；`package.json` 与 `package-lock.json` **都要提交**；实测并记录 verify 前后总耗时，增量 ≤60s。
5. **反向验证（acceptance 硬要求，必须贴真实输出）**：
   - 把 `key={draft.uid}` 临时改回 `key={name}` → 跑新用例，**至少 1 例失败**，记录失败用例名与关键断言输出
   - 把名称 input 的 `w-full h-9` 临时改回 `flex-1 h-9` → 跑新用例；若你的选型具备布局能力则**至少 1 例失败**并记录；若不具备（jsdom）则如实记录「无法捕获」，并在 design.md 给出补偿手段
   - **两次反向验证后必须完全还原代码**，`git diff` 对这两个文件为空（在 verification.md 里贴 `git status --porcelain` 与 `git diff --stat` 证明）
6. **三件套**：`docs/tasks/X12-ui-test-infra/design.md`（选型对比 + 取舍 + **「遗留问题」小节**）、`CHANGES.md`（文件清单 + 每处摘要，含新增依赖及版本）、`verification.md`（命令与关键输出、断言/用例数前后对比、verify 耗时前后对比、反向验证输出）。

## 5. 范围纪律（明确不做）

- **不改 `docs/task-plan.json`**（并行派发，计划记账由主会话统一执行）
- **不改任何业务行为**：`src/` 下只允许为可测性做最小调整（如导出内部函数、加 `data-testid`），且必须在 `CHANGES.md` 逐处记录理由；不得为了好测而改交互、改样式、改文案
- 不动 X10 正在改的区域（`src/store/canvas-store.ts` 建边逻辑、`server/graph-query.ts`、`server/extensions/govio-canvas.ts`、`src/types/index.ts` 的 sourceTable 形状、`docs/demo/video-script-chocolate.md`）——**X10 与本任务并行在各自 worktree 执行，撞上这些文件会造成合并冲突**；若你的节点组件用例必须依赖 X10 新增字段，改用现有字段或写进遗留问题
- 不引入运行时依赖（dependencies 一律不动）；不让 verify 依赖网络、真实 govio-cli、真实 LLM 或真实浏览器下载（若选 B/C，浏览器二进制必须在本地已具备且离线可跑，否则改选 A）
- 不重写既有 7 个测试文件、不改既有 9 个 verify 脚本的断言（只允许在 `package.json` 的 verify 聚合链里追加你的脚本）
- 不顺带修其他已知问题；**新发现一律写入 `design.md` 的「遗留问题」小节**

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`
  `.agents/`（skills）被 `.gitignore` 忽略，fresh worktree **不含**该目录，约 350K
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪，`npm install` 由 repo setup hook 自动执行）；**不切分支、不 push、不合并**（涉 `package.json` 与 verify 脚本变更 → 走 PR，由主会话创建、用户合并）
- 安装新依赖用 `npm install -D <pkg>@<version>`（会改 `package.json` + `package-lock.json`，两者都要 commit）；装完**先跑一次既有 `npm run verify`** 确认 83 例零回归，再开始写新用例
- Windows Git Bash 约定：路径统一正斜杠、**不要以反斜杠结尾**（会被当转义符吞掉引号）；`python` 是 Windows Store 存根**不可用**（需脚本语言用 node/tsx）；解析 JSON 用 `jq`（`/d/Work/jq/jq`）
- commit：**单次 commit**，message 前缀 `X12: ...`
- 验证门槛（全绿才算完成，任一非零退出即失败；修复后重跑，**禁止虚报**）：
  `npm run build`、`npm run lint`、`npm run verify`（既有 609 项断言 + 83 例零回归 + 你的新增用例），且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 task-plan 状态（主会话验收时统一置 done/accepted）
- 遇到阻塞（依赖装不上、版本不兼容、模型通道问题）：用 `ask` 问主会话，不要自行换方案或降级目标

## 7. 时间预算

- 总预算 **90 分钟**
- **到期前 15 分钟为 checkpoint 点**：若未完成，先把已改文件与三件套当前状态 commit（message 前缀 `X12: WIP ...`），并在汇报中写明「已改文件 / 依赖安装状态 / 验证状态（哪些门槛已跑、结果如何）/ 剩余工作」。**超时不是变更安全边界**——尤其不要留下 `package.json` 改了但 lock 没同步、或 verify 链挂了半截的状态
- 建议节奏：读档与选型 ≤20min → 依赖安装 + 配置 + 既有 83 例回归确认 ≤15min → SettingsModal 用例 ≤25min → 节点组件用例 ≤10min → 反向验证 ≤10min → 文档与三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
选型: A/B/C/D（一句话理由 + verify 耗时增量实测）
交付物: docs/tasks/X12-ui-test-infra/{design.md,CHANGES.md,verification.md}
commit: <hash> <message>
新增依赖: <pkg@version ...>（仅 devDependencies）
断言数变化: vitest 7 文件/83 例 → <n> 文件/<m> 例（新增 UI 用例 <k> 例，覆盖点）；脚本断言 609 → <j>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>（耗时 36s → <s>s，增量 <d>s ≤60s）；git status 干净=<是/否>
反向验证: key={name} → <失败用例名/无法捕获>；flex-1 h-9 → <失败用例名/无法捕获+补偿手段>；代码已还原=<是/否>
遗留: <design.md 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号（**只把结论写在终端不算完成**）。未完成也要发 `worker_done`，`--outcome` 用 `failed`/`blocked` 并说明缺口，禁止虚报验证结果。
