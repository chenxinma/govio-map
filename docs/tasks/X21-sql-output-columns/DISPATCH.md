# X21 任务书：输出列抽取升级（node-sql-parser）+ SQL 高亮统一

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源：`docs/task-plan.json → crossCutting[] | select(.id=="X21")`（scope/acceptance 即验收契约）。
> 用户裁决（2026-11-14）：批准引入 `node-sql-parser` 新依赖；SQL 高亮统一**本轮一起做**。

## 1. 背景与动机

用户实测案例（2026-11-14）：SQL 带行内 `--` 注释时，SQLQuery 节点「输出列」只显示第一列：

```sql
SELECT
  SUM(amount)     AS m_sales_amount,  -- 销售额：SUM(amount)
  COUNT(order_id) AS m_order_count    -- 订单数：COUNT(order_id)
FROM chocolate.chocolate.fact_sales;
```

主会话已**实证复现**（跑真实函数）：带注释 → `["m_sales_amount"]`，去注释 → 两列齐全。
另外 SQLQuery 节点卡片与 SQL 编辑弹窗用了**两套不同的高亮技术**，观感不一致，本轮一并统一。

## 2. 先读清单（按序）

1. `AGENTS.md`、`.pi/APPEND_SYSTEM.md`
2. `docs/task-plan.json → crossCutting[] | select(.id=="X21")` 的 scope/acceptance
3. `server/extensions/govio-canvas.ts` 的抽取管道全文（`splitTopLevelCommas` / `columnNameOf` / `extractSelectColumns` / `extractSqlCodeBlocks`，约 270-345 行）——本任务核心现场
4. `docs/tasks/BUGFIX-sql-columns-and-graph-cache.md`（旧坏例：函数内逗号被 `split(",")` 切碎出 `amount)`、`0)` 垃圾列名，实测 gov-104/105/110——**你的重构不得让这些回退**）
5. `src/components/Nodes/SQLQueryNode.tsx`（`highlightSQL()`（23-26 行附近）与「输出列」渲染（210 行附近））
6. `src/components/Nodes/SQLModal.tsx` + `src/components/Nodes/sql-completions.ts`（编辑弹窗：CodeMirror + `@codemirror/lang-sql` + oneDark + 自定义补全）
7. `src/utils/export-report.ts:749`（导出 HTML 的「输出列」chips，消费同一 `outputColumns`）
8. `src/types/index.ts` 中 `outputColumns` 契约定义；`tests/` 中现有抽取相关用例（若有）

## 3. 实证事实（主会话已取证/复现，避免你重复踩坑）

- **根因**：`extractSelectColumns` 不剥离 `--` / `/* */` 注释；`columnNameOf` 的显式别名正则锚定串尾（`AS alias\s*$`），行内注释尾巴顶掉匹配 → 该项返回 null 被过滤。实测复现见 §1
- 抽取管道现状：`/SELECT\s+([\s\S]+?)\s+FROM/i` 取列表 → `splitTopLevelCommas`（括号深度内逗号不切）→ `columnNameOf` 三分支（显式 AS / 隐式别名（前缀以 `)` 结尾才认）/ 裸列），其余不产列名
- **旧防线不可破**：`BUGFIX-sql-columns-and-graph-cache.md` 的坏例（函数内逗号切碎）就是 `splitTopLevelCommas` + 三分支修的——任何重构必须让该坏例继续通过
- `outputColumns: string[]` 是节点数据契约，消费方：SQLQueryNode「输出列」区、`export-report.ts` 导出 chips；**契约形状不变**
- **高亮双栈现状**：卡片 `highlightSQL()` = `SQL_KEYWORDS` 正则 split 加粗（仅关键词）；弹窗 = CodeMirror `@codemirror/lang-sql`（Lezer 语法树高亮）+ oneDark。两套 token 分类与观感均不一致
- 涉及文件已在多轮合并后的 main 上（基线见 §6）；`package.json` 与 **PR #41（版本号 0.7.2）可能有微冲突**（不同行，git 通常自动合并），遇冲突 rebase 即可
- **PD-3 不在本任务**（注入命中/语义归因口径是另一待讨论项，别顺手修）

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **抽取升级**：引入 `node-sql-parser`（新依赖，用户已批准）做 SELECT 列名/别名主解析（正确处理行内注释、CASE、嵌套、DISTINCT、多行格式）；**现有正则管道降级为兜底**——解析器抛错/方言不支持（DuckDB 的 `DATE_TRUNC`、`QUALIFY` 等）时回落旧行为，**任何输入不得比现状更差**
2. **回归与新增用例**：① 本次注释案例（两列全出）；② BUGFIX 旧坏例（函数内逗号垃圾列名）零回归；③ 覆盖形态：显式/引号别名、隐式别名、裸列、`t.*`、无别名表达式跳过、DISTINCT、CASE、嵌套子查询、解析失败回落；用例放既有测试基建（vitest）对应位置
3. **编辑跟手核实**：SQLModal 保存编辑后「输出列」目前是否刷新？若不刷新，采用**改动最小**的方案让显示跟手（保存时重抽取 或 显示端派生，design.md 取舍），不改 `PROTOCOL_VERSION`
4. **SQL 高亮统一**：两端（卡片 / 弹窗）token 分类（关键词 / 字符串 / 注释 / 数字 / 其余）观感一致。建议评估「Lezer（`@codemirror/lang-sql` 底层）共享高亮」方案（单源），备选「卡片内嵌 CodeMirror 只读视图」（注意 bundle 影响）或「升级共享 tokenizer」；**取舍写 design.md**，并记录 bundle 体积对比（X3 的 plotly 懒加载拆分不得回退）
5. **导出同步**：`export-report.ts` 的「输出列」chips 用同一抽取结果（HTML 导出里两列都出现）；如有既有 verify 断言按只增不削原则补
6. **三件套**落盘 `docs/tasks/X21-sql-output-columns/`：`design.md`（parser 选型与方言兜底策略、高亮方案取舍、bundle 对比、**「遗留问题」小节**）、`CHANGES.md`、`verification.md`（复现案例前后对比、断言增量逐项）

## 5. 范围纪律（明确不做）

- **不动 PD-3**（注入命中/语义归因）；不动口径/semanticRefs 相关逻辑
- 不改 `outputColumns` 契约形状；不改 `PROTOCOL_VERSION`；不重写 SQLModal 编辑器功能（补全、快捷键不动）
- 解析器失败时**禁止猜测**列名——回落旧行为或跳过，绝不产垃圾列名
- 不改 `docs/task-plan.json`（主会话记账）；不顺带重构抽取管道之外的 govio-canvas 事件逻辑
- 新发现一律写 design.md「遗留问题」

## 6. 环境与协议

- **第一步（必做）**：`cp -r /d/Work/gov-io/govio-map/.agents ./`（被 gitignore，fresh worktree 不含）
- 工作位置：Orca 为你创建的独立 worktree（分支已就绪；repo setup hook 是 `npm install`；引新依赖用 `npm install node-sql-parser --no-audit --no-fund`，lockfile 变更属预期，**registry 指向 npmmirror 的镜像改写问题保持现状不要处理**（X14 已有 workflow 侧对策））
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 不可用（用 node/tsx）；JSON 用 `jq`
- commit：**单次 commit**，message 前缀 `X21: ...`
- 验证门槛（全绿才算完成，禁止虚报）：`npm run build`、`npm run lint`、`npm run verify`；**派发时 main 基线：脚本 670 项 / vitest 19 文件 256 例 / UI 4 文件 37 例**——零回归 + 新增用例（增量逐项列出）；verify 全跑后 `git status --porcelain` 干净（`package.json`/`package-lock.json` 的依赖变更是交付物、不算脏）
- 状态协议：**不要**改 task-plan 状态
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话

## 7. 时间预算

- 总预算 **90 分钟**（`--timeout-ms 5400000`）
- **到期前 15 分钟为 checkpoint 点**（≈75min）：未完成则 commit 已改文件 + 三件套现状（前缀 `X21: WIP ...`），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤10min → parser 接入与兜底 ≤25min → 用例 ≤20min → 高亮统一 ≤25min → 三件套 ≤10min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
交付物: docs/tasks/X21-sql-output-columns/{design.md,CHANGES.md,verification.md} + <代码文件摘要>
commit: <hash> <message>
抽取: 注释案例=<两列全出?>；旧坏例=<零回归?>；兜底策略=<一句话>
编辑跟手: <现状已跟手/已修（方案）/记遗留>
高亮统一: <方案一句话>；bundle 对比=<主 chunk 前后>
依赖: node-sql-parser <版本>（package.json/lock 已更新）
断言数: 脚本 670 → <k>（新增逐项）；vitest 19 文件 256 例 → <..>；UI 4 文件 37 例 → <..>
门槛: build=<0/非0> lint=<0/非0> verify=<0/非0>；git status 干净=<是/否>（依赖文件除外）
遗留: <design.md 遗留问题条数与最关键 1 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
