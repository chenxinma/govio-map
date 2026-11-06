# T2.4 任务书：元数据增量导入与校验报告（DISPATCH）

> 执行者：pi subagent worker（fresh context，自包含任务书）。**跨两仓**：govio（CLI 主体）+ govio-map（任务交付物与证据）。
> 完成定义见 govio-map/AGENTS.md「worker：完成定义」；本任务为并行派发（T2.3 同时执行），**task-plan.json 由主会话统一记账，worker 不得修改**。

## 1. 背景与动机

Phase 2 KR4「元数据导入常态化」：govio-meta 导入流程支持**增量更新**与**校验报告**，保证图谱新鲜度
（口径命中率的供给侧）。现状（govio-meta skill）：各子命令写 CSV → `meta graph --mode update` 增量
upsert 导入图库，宣称「可反复执行」，但**幂等性没有测试固化**，且导入过程只有 stdout 的 ✓/行数，
**没有落盘的校验报告**——出了差异（孤儿边、重复 id、计数对不上）无从质证。

acceptance 契约（docs/task-plan.json → T2.4）：①重复导入幂等；②校验报告输出到任务目录。

## 2. 先读清单（按序）

**govio 仓（D:/Work/gov-io/govio，另开 worktree，见 §6）**
1. `AGENTS.md`（**Documentation Sync Rule 强制**：CLI/graph/metadata 变更必须同步对应 `docs/specs/*.md`；测试/lint 命令）
2. `src/govio/cli/meta.py`（全部 meta 子命令：meta/app/std/compliance/rel/metric/graph/recommend/import_schema，`--mode update` 语义）
3. `src/govio/graph/`（图后端与 CSV loader：`docs/specs/graph.md` 对应实现）、`src/govio/metadata/node_id.py`（id 稳定性 = 幂等根基）
4. `docs/specs/graph.md`、`docs/specs/metadata.md`、`docs/specs/cli.md`
5. `tests/`：`test_meta_cli_guard.py`、`test_meta_cli_sources.py`、`test_meta_export_ids.py`、`tests/regression/`（既有测试形态）
6. `skills/govio-meta/SKILL.md`（agent 使用文档；「标准工作循环」「--mode update 是增量 upsert」的承诺）
7. `package_skills.py`（skills 打包）、`docs/tasks/README.md`（govio 仓任务目录惯例）

**govio-map 仓（你的 worktree）**
8. `AGENTS.md`（任务模式、完成定义）；`docs/task-plan.json → T2.4` 条目
9. `docs/ROADMAP.md` Phase 2 KR4 行；`.agents/skills/govio-meta/SKILL.md`（运行时副本，与 govio 仓 skills/ 同源）

## 3. 实证事实（主会话已调研）

- **导入链路**：子命令（meta/app/std/compliance/rel/metric/import-schema）把输入转成固定文件名 CSV 写入
  `--output` 目录 → `govio-cli meta graph --output <目录> --mode update` 读 CSV 导图 + 生成 assets；
  `--mode update` 宣称增量 upsert、可反复执行（skill 承诺，未测试固化）。
- **幂等的关键前提**：节点 `node_id` 生成必须稳定（`src/govio/metadata/node_id.py`）；若 id 每次导入漂移，
  upsert 会退化成重复插入——如发现此根源，**修复它属于本任务范围**（范围纪律见 §5）。
- **「任务目录」语义**：acceptance ②「校验报告输出到任务目录」按**双证据**落地——CLI 侧报告默认写入
  导入任务的 `--output` 目录（CSV 目录，即该次导入任务的共享状态目录）；同时把演示实跑产出的报告文件
  保存到 govio-map 的 `docs/tasks/T2.4-meta-incremental-import/`（任务交付物目录）作为验收证据。
  若实现中发现更贴切的「任务目录」语义（如 CLI 已有 job/任务概念），design.md 记录取舍。
- **报告形态建议**：机器可读 JSON + 人可读 Markdown（或其一，worker 定）；内容至少含各节点/边类型计数、
  本次新增/更新/跳过数、校验项结果（可行子集：孤儿边、必填缺失、重复 id）。命令上支持 `--report <path>`
  覆盖默认位置（默认 = `--output` 目录内固定文件名，如 `import-report.json`）。
- **govio 仓规范**：Python 3.13+ / uv；`uv sync --group dev`、`uv run pytest tests/`、`uv run ruff check src/ tests/`；
  CLI/graph/metadata 变更必须同步 `docs/specs/{cli,graph,metadata}.md`（AGENTS.md 表格）。
- **技能同步**：`skills/govio-meta/SKILL.md` 是 agent 使用事实源（govio-map 的 `.agents/skills/` 是运行时
  副本、gitignore 不入库，由主会话合并后手动同步）。
- 环境：Windows Git Bash；`python` 命令不可用——测试一律 `uv run pytest`；jq 可用。

## 4. 实现范围（逐项编号，对齐 acceptance）

**A. govio 仓（CLI 主体）**
1. **增量幂等固化**（acceptance ①）：为「同一输入重复导入」写测试固化现状承诺——同一批输入跑
   两轮（子命令 + `meta graph --mode update`），断言两轮后图库状态一致、第二轮零变更（各类型计数
   不变、无重复节点/边）；若不幂等，定位修复（常见根源：node_id 不稳定、upsert 键错配、边重复插入），
   修复后测试固化。
2. **校验报告**（acceptance ②）：`meta graph`（及一步式 `import-schema`）执行后产出校验报告文件：
   - 默认写入该次导入的 `--output` 目录；`--report <path>` 可指定别处；
   - 内容：各节点/边类型导入计数 + 新增/更新/跳过数 + 校验项结果（孤儿边/必填缺失/重复 id 的可行子集，
     选哪些 worker 定并记 design.md）；
   - stdout 摘要保留（现有 ✓/行数体验不回退）。
3. **测试**：pytest 新增幂等用例 + 报告生成/内容断言 + 坏输入不产半截报告；`uv run pytest tests/` 全绿
   （既有零回归）、`uv run ruff check src/ tests/` 绿。
4. **文档同步**（govio AGENTS.md 硬规则）：`docs/specs/cli.md`（新参数/报告契约）、`docs/specs/graph.md`
   /`metadata.md`（视实现落点）；`skills/govio-meta/SKILL.md` 补「校验报告」章节（报告位置、如何解读、
   幂等承诺的验证方式）。

**B. govio-map 仓（交付物与证据）**
5. 交付物三件套落 `docs/tasks/T2.4-meta-incremental-import/`：`design.md`（方案与取舍 + 「遗留问题」
   小节）、`CHANGES.md`（两仓文件清单 + 每处摘要）、`verification.md`（验证命令与关键输出）；
6. **演示实跑取证据**：对可用的示例元数据（如 `D:/Work/gov-io/govio/data/` 下样例或临时构造的最小输入）
   完整跑一遍导入（含第二轮幂等演示），把产出的**校验报告文件**保存到
   `docs/tasks/T2.4-meta-incremental-import/`（即 acceptance ②「输出到任务目录」的实证）；实跑步骤与
   输出摘要写入 verification.md；
7. map 仓库代码**零改动**；`npm run build` / `npm run lint` / `npm run verify` 照跑确认零影响
  （worktree 内先 `npm install`；网络瞬断就停下报告，禁止假装绿）。

## 5. 范围纪律（明确不做）

- 不做新数据源接入（TDS/Trino 等既有 loader 不动）；不改 node_id 算法**除非**它就是不幂等的根源
  （此时最小修复 + 测试固化，design.md 记录根因分析）；
- 不动 graph 后端选择逻辑（NetworkX/FalkorDB/Ladybug）、不做 T2.3、不动 govio-map 运行时代码；
- 不做导入结果上画布（govio-meta skill 硬约束 6）；新发现缺陷记 design.md「遗留问题」。

## 6. 环境与协议

- **两仓两个分支、各一次 commit**（前缀 `T2.4: `）；**不 push**（PR 由主会话创建、用户合并）；
- **govio 仓 worktree**（独立工作区，勿动 `D:/Work/gov-io/govio` 主工作区）：
  `git -C /d/Work/gov-io/govio worktree add /d/Work/gov-io/govio-t24-wt -b task/t24-meta-incremental`
  然后在该 worktree 内 `uv sync --group dev` 后开发；**不要删除 worktree**（主会话验收后清理）；
- **govio-map 仓**：你在 pi 托管的独立 worktree 中（managed git worktree），先 `git branch --show-current`
  确认分支；第一步 `cp -r /d/Work/gov-io/govio-map/.agents ./`（gitignore 的技能资产）；
- 并行写权：**禁止修改 govio-map 的 `docs/task-plan.json`**（T2.3 同时执行，主会话统一记账）；
- 验证门槛：govio 侧 `uv run pytest tests/` + `uv run ruff check src/ tests/` 全绿；map 侧
  `npm run build` / `npm run lint` / `npm run verify` 全绿；各 worktree `git status --porcelain` 干净；
- Windows Git Bash：正斜杠、jq、`python` 不可用（govio 测试走 `uv run`）。

## 7. 时间预算

- 总预算 75 分钟；到期前 15 分钟必须 checkpoint：已改文件 / 各仓验证状态 / 剩余工作（写入 CHANGES.md
  或输出中报告）；超时不是变更安全边界。

## 8. 最终输出格式（≤15 行摘要）

```
status: done | partial
交付物: docs/tasks/T2.4-meta-incremental-import/{design,CHANGES,verification}.md + 校验报告样例文件
commits: govio <hash> T2.4: ...（分支 task/t24-meta-incremental，worktree /d/Work/gov-io/govio-t24-wt）
         govio-map <hash> T2.4: ...（分支 <managed 分支名>）
验证: govio pytest ✓（N passed，含幂等用例）ruff ✓ | map build ✓ lint ✓ verify ✓（零影响）
实现要点: <1-2 行（幂等根因/报告内容）>
遗留: <无 / 列表>
```
