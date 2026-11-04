# X3 任务书：前端 bundle 拆分（plotly 懒加载）（Orca worker 派发件）

> 本文件为自包含任务书（worker 是 fresh context，不共享对话历史）。执行完按「最终输出格式」汇报。

## 1. 背景与动机

`plotly.js-dist-min` 是前端最大的单体依赖，目前被打进主 bundle，拖慢首屏加载。将其改为懒加载（chart 节点渲染时才动态 import）可获得用户可感知的首屏性能提升，且改造面小、与后端/测试区域零交集。关联文档：`AGENTS.md`、`docs/task-plan.json` 中 X3 条目。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、完成定义、环境约定）
2. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X3")`（scope/acceptance 即验收契约）
3. `package.json`（依赖与 scripts）、`vite.config.ts`
4. `src/components/Nodes/ChartNode.tsx`、`src/components/Nodes/ChartModal.tsx`、`src/components/Nodes/ChartErrorBoundary.tsx`
5. `src/utils/export-report.ts`（plotly 的第 3 个 import 点）、`src/types/plotly.d.ts`（类型声明，不打包）
6. `docs/tasks/` 下任一既有任务三件套样例了解交付物格式

## 3. 实证事实（主会话已调研，避免重复踩坑）

- plotly 依赖为 **`plotly.js-dist-min`**（非 plotly.js），import 位置共 3 处源码：`ChartNode.tsx`、`ChartModal.tsx`、`src/utils/export-report.ts`；`src/types/plotly.d.ts` 仅为类型声明
- `npm run build` = `tsc -b && vite build`；`npm run verify` 由 6 个 tsx 脚本组成，与前端产物无关但必须保持全绿
- 本机为 Windows Git Bash：路径用正斜杠、jq 可用（`/d/Work/jq/jq`）、`python` **不可用**（用 node/tsx）
- `.agents/skills` 被 `.gitignore` 忽略，fresh worktree **不包含**该目录 → 见 §6 环境准备

## 4. 实现范围（逐项，对齐 acceptance）

1. 记录拆分前基线：`npm run build` 后 dist 产物各 chunk 体积（写入 verification.md）
2. 将 plotly 改为懒加载：动态 `import()`，仅在 chart 节点/ChartModal 实际渲染时加载；3 个 import 点统一处理（export-report 若仅类型引用可改 type-only import，若需运行时 plotly 则同样动态加载）
3. 拆分后断言：主 chunk 不含 plotly（build 产物 chunk 清单为证）；chart 节点与 ChartModal 渲染行为不回归（记录冒烟方式）
4. 记录拆分后 bundle 体积对比（主 chunk / 总产物），填入 verification.md
5. 三件套落盘：`docs/tasks/X3-bundle-splitting/design.md`（方案与取舍）、`CHANGES.md`（每处改动摘要）、`verification.md`

## 5. 范围纪律（明确不做）

- 不重构 chart 组件本身、不改渲染逻辑与 UI 行为
- 不动 `server/`、不动 `docs/task-plan.json`（计划记账由主会话统一执行，避免并行 worktree 冲突）
- 不顺带拆分其他依赖/不引入新 UI 变化；若分析发现其他大依赖值得拆，只写入 design.md 的「遗留问题」小节

## 6. 环境与协议

- **环境准备（第一步执行）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（worktree 缺 skills 目录；大小约 353K）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪）；**不切分支、不 push**
- Windows Git Bash：正斜杠路径；jq 可用；python 不可用
- commit：单次 commit，message 前缀 `X3: ...`
- 验证门槛（全部必须绿，任一非零退出即任务失败，修复后重跑，禁止虚报）：
  `npm run build`、`npm run lint`、`npm run verify`，且 verify 全跑后 `git status --porcelain` 干净
- 状态协议：**不要**改 `docs/task-plan.json`（主会话记账）

## 7. 时间预算

- 总预算 **45 分钟**（timeoutMs 2700000）
- 到期前 10 分钟为 checkpoint 点：若未完成，先提交已改文件并在汇报中写明「已改文件/验证状态/剩余工作」，超时不是变更安全边界

## 8. 最终输出格式（≤15 行摘要）

- status / 交付物路径 / commit hash 与 message / bundle 前后体积对比关键数字 / 遗留问题
