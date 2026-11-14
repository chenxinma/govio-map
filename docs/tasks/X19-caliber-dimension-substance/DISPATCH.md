# X19-W5a 任务书：口径判定升级——维度限定条件的实质比对（govio 仓）

> 本文件为**自包含**任务书（worker 是 fresh context，不共享任何对话历史）。按 §8「最终输出格式」汇报。
> 计划事实源（**只读**）：`D:/Work/gov-io/govio-map/docs/task-plan.json → crossCutting[] | select(.id=="X19")`（note/scope/acceptance 即验收契约）。
> **你的工作仓是 govio（`D:/Work/gov-io/govio` 的 worktree），不是 govio-map。** map 仓文件仅只读参考，**严禁写入 map 仓**。
> 用户裁决（2026-11-14）：**先合并 govio**（本任务先行）；map 侧消费任务（W5b）由主会话另行派发。

## 1. 背景与动机

PD-2 定调（用户 2026-11-14）：口径判定以**计算表达式**和**维度限定条件**为实质判断依据，取代「列名是否在 SQL 里出现过」的粗判。主会话取证结论：

- 计算表达式部分**已落地**（govio `33080fd`：`_canonical_expr` 归一 + `_compare_aggregation` 按聚合参数表达式比对）
- **维度限定条件是缺口**：`_compare_filter` 目前只做「指标定义里的剔除类词是否出现在 SQL WHERE 段」的子串包含 + 否定算子检查，docstring 明写「全部存疑：只给 unknown，不判 conflict」——没有把 SQL 的维度限定（列+算子+值集合）与指标侧维度声明做结构化比对
- **本任务核心 = 维度限定条件的结构化实质比对，产出 consistent / conflict / unknown 三态**

判定纪律（不可违背）：**宁可 unknown 不误报**；只有「SQL 的维度限定与指标声明实质矛盾」才判 conflict；「SQL 多了指标未声明的限定」按存疑处理（reason 说明）；**禁止引入别名同义词典一类启发式**（方案 C 未获授权）。

## 2. 先读清单（按序）

1. `D:/Work/gov-io/govio/AGENTS.md`（**本仓**纪律：pytest / ruff check / ruff format --check 三道门禁、docs/specs 同步规则、commit 风格）——你 worktree 内就是 `AGENTS.md`
2. `D:/Work/gov-io/govio-map/docs/task-plan.json` → `crossCutting[] | select(.id=="X19")`（**只读**，验收契约）
3. `D:/Work/gov-io/govio-map/docs/PENDING-DISCUSSION.md` 的 **PD-2**（定调原文、判定依据、**8 档回归样本 s1-s4 / t1-t4 及预期表**——你的用例集来源；只读）
4. `src/govio/metadata/caliber.py` 全文（重点：`_canonical_expr`(406)、`_compare_aggregation`(424)、`_compare_filter`(522)、`_compare_time_scope`(559)、`_compare_columns`(597)）
5. `tests/test_caliber_compare.py`、`tests/test_caliber_cli.py`（现有用例与 fixture 范式）
6. `docs/specs/metadata.md`（指标/口径相关章节；按 AGENTS.md 的对应表，caliber 归口哪篇 spec 以该表为准）
7. 元数据侧维度声明的形状：`Metric.statistical_scope`、`DIMENSION_USED` 关联的 `Dimension`（含 `values_example` 枚举码值）、`REFERS_COLUMN role=dimension`（可在 `src/govio/metadata/` 与 `docs/specs/data-model.md` 里核实属性名，**不得凭记忆构造**）

## 3. 实证事实（主会话已取证，避免你重复踩坑）

- `_compare_filter`（caliber.py:522）现状：剔除词子串包含 + 否定算子检查，**一律 unknown**，不判 conflict；docstring 自述「全部存疑」
- `_compare_aggregation`（424）已按归一后的聚合参数表达式比对（旧实现只比 (func, distinct) 的漏判已修）
- `_compare_columns`（597）已 measure-first（dimension_ref 缺失不产存疑噪声）——PD-2 方案 2 已落地
- `_canonical_expr`（406）：剥 ROUND/CAST/`::type` 展示包装、去表限定、压空白、小写——你的三元组表达式归一**复用它**的口径
- 8 档预期（PD-2 补充）：**s2/t2（正确口径）unknown → consistent**、**t4（算术修饰）保持 conflict**、s1/s3/s4/t1/t3 的 conflict 不回归
- map 侧消费契约（**不得破坏**）：`govio-cli sql caliber` 输出 JSON 的三态取值 `consistent`/`conflict`/`unknown` 与 `differences` 条目形状**保持不变**；map 的 `src/types/semantic.ts` 已按此建模。**如确需新增输出字段：停下用 `ask` 报主会话**（map 侧容错须先行，会打乱「先合并 govio」的顺序）
- govio 仓门禁：`uv run ruff check .`、`uv run ruff format --check .`、`uv run pytest tests/`（CI 与本地一致）；`ruff format --check` 不过先 `uv run ruff format .`
- govio 仓合入纪律：代码改动走 PR、由用户合并；你**不 push、不建 PR**（主会话创建）

## 4. 实现范围（逐项编号，对齐 acceptance）

1. **SQL 维度限定三元组解析**（列 / 算子 / 值集合）：从 WHERE（及必要时 GROUP BY）解析维度限定，表达式归一复用 `_canonical_expr` 口径、分词复用既有 sqlparse 能力；覆盖 `IN (...)`、`=`、范围、`LIKE` 等常见算子（解析不了的形态按 unknown 处理，**禁止猜测**）
2. **指标侧维度声明对齐**：`Metric.statistical_scope` 文本 + `DIMENSION_USED` 关联 `Dimension`（含 `values_example` 枚举码值）+ `REFERS_COLUMN role=dimension`
3. **三态判定**：`consistent` / `conflict` / `unknown`。判定矩阵写进 design 文档；**conflict 仅限实质矛盾**（例：指标声明限「华东区」而 SQL 无任何区域限定、或限定了别的区域）；SQL 多了指标未声明的限定 → unknown + reason 说明；**无维度声明的指标不因维度维度产出存疑噪声**
4. **`_compare_time_scope` 同批核查**：时间窗是否也应按实质比对升级（如指标声明月度而 SQL 取年度）；升级或维持现状都要在 design 文档写明理由
5. **输出契约不变**：三态与 `differences` 条目 JSON 形状保持现状（见 §3；确需新字段先 `ask`）
6. **测试**：8 档样本 s1-s4/t1-t4 **固化为用例集**逐档断言（预期表见 PD-2；逐档记录改动前后判定）+ 单元用例（三元组解析、三态边界、「宁可 unknown 不误报」反例）；既有 `tests/test_caliber_compare.py`、`test_caliber_cli.py` 零回归
7. **文档**：按 AGENTS.md 对应表同步 `docs/specs/`（指标/口径相关 spec）；判定矩阵 + 三态边界 + 与方案 C 的界限写进你的 design 文档；交付记录按 govio 仓 `docs/tasks/` 约定落盘（目录名建议 `docs/tasks/X19-caliber-dimension-substance/`，含 design/测试说明；格式随该仓惯例）

## 5. 范围纪律（明确不做）

- **严禁写 `D:/Work/gov-io/govio-map`** 任何文件（含 docs）；map 侧消费与展示是 W5b 的事
- **禁止别名同义词典 / 启发式改名归一**（方案 C 未获授权）；发现「别名导致的误判」只写进 design 遗留
- 不动图谱、loader、recommend 等无关模块；不改 CLI 命令行形状（`sql caliber` 子命令与参数不变）
- 不 push、不切分支、不建 PR、不合并；不改 govio 的 CI 配置
- 新发现一律写 design 文档「遗留问题」

## 6. 环境与协议

- 工作位置：Orca 为你创建的 govio 仓独立 worktree（分支已就绪；repo setup hook 是 `uv sync`，未就绪就自己 `uv sync --group dev`）
- 同一 worktree 只有你一个写者；只 `git add` 你自己的改动
- **Windows Git Bash 约定**：路径统一正斜杠、不以反斜杠结尾；`python` 命令是 Windows Store 存根**不可用**——跑测试/脚本一律 `uv run`（uv 的 Python 是真的）
- commit：遵循 govio 仓 conventional 风格（如 `feat(caliber): ...`），单次 commit
- 验证门槛（全绿才算完成，禁止虚报）：`uv run ruff check .`、`uv run ruff format --check .`、`uv run pytest tests/`（既有用例零回归 + 新增用例），完成后 `git status --porcelain` 干净
- 状态协议：map 仓 task-plan 你不动（主会话记账）；govio 仓的计划/任务文档若该仓惯例要求更新，按其惯例在你的交付目录内记录
- 完成后**必须**发 orca 信号：`orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>`；未完成也发（`--outcome failed/blocked`）
- 收到 `send` 消息若正在做事，**先完成当前任务再处理**；阻塞用 `ask` 问主会话

## 7. 时间预算

- 总预算 **120 分钟**（`--timeout-ms 7200000`）
- **到期前 15 分钟为 checkpoint 点**（≈105min）：未完成则 commit 已改文件与文档现状（message 注明 WIP），汇报「已改文件 / 验证状态 / 剩余工作」
- 建议节奏：读档 ≤20min → 三元组解析 ≤25min → 三态判定与 time_scope 核查 ≤30min → 8 档用例固化与回归 ≤30min → 文档 ≤15min

## 8. 最终输出格式（≤15 行摘要）

```
status: done | blocked | partial
仓: govio（worktree <路径>）
交付物: <govio 仓 docs/tasks/... 文档> + <代码文件摘要>
commit: <hash> <message>
三态判定: <一句话判定矩阵>；_compare_time_scope=<升级/维持（理由）>
8 档样本: s2/t2=<unknown→consistent 达成?>；t4=<conflict 保持?>；其余 conflict 档=<零回归?>
输出契约: <JSON 形状不变/新增字段（须已 ask）>
测试: pytest <m 文件 / n 例>（新增 <k>）；既有零回归=<是/否>
门槛: ruff check=<0/非0> ruff format --check=<0/非0> pytest=<0/非0>；git status 干净=<是/否>
判定纪律: 无别名启发式=<是/否>；「宁可 unknown」反例=<有/无>
遗留: <design 遗留问题条数与最关键 1-2 条>
```

汇报后用 `orca orchestration send --type worker_done --outcome succeeded --task-id <task_id> --dispatch-id <dispatch_id>` 发信号。未完成也发 `worker_done`（`--outcome failed/blocked`），禁止虚报。
