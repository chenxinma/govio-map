# T2.3 任务书：口径冲突检测（DISPATCH）

> 执行者：pi subagent worker（fresh context，自包含任务书）。**跨两仓**：govio（CLI 比对逻辑）+ govio-map（警示 UI）。
> 完成定义见 govio-map/AGENTS.md「worker：完成定义」；本任务为并行派发（T2.4 同时执行），**task-plan.json 由主会话统一记账，worker 不得修改**。

## 1. 背景与动机

Phase 2 KR3：AI 生成的 SQL 与图谱指标定义不一致时（如「活跃」过滤条件不同），在 SQL 节点上给出
黄色警示与差异说明。ROADMAP 明确「比对逻辑下沉 govio-cli，前端只展示」。T2.1（注入图谱定义进
prompt）与 T2.2（SQL 节点 `semanticRefs` 记录引用的指标 ID）已合并——本任务在其之上做**事后校验**：
SQL 生成后与所引指标的口径定义比对，冲突则警示。

## 2. 先读清单（按序）

**govio-map 仓（你的 worktree）**
1. `AGENTS.md`（任务模式、完成定义）；`docs/task-plan.json → T2.3` 条目
2. `docs/ROADMAP.md` Phase 2 KR3 行；`docs/tasks/T2.2-semantic-lineage/design.md`（semanticRefs 形态，本任务的输入）
3. `server/extensions/govio-canvas.ts:891-933`（message_end 建 sqlQuery 节点、semanticRefs 归因点）
4. `server/govio-cli-exec.ts`（`runGovioCliWithArgs(args, timeoutMs)`）、`server/semantic-context.ts`
5. `src/types/index.ts`（SQLQueryNodeData）、`src/types/semantic.ts`（SemanticRef）
6. `src/components/Nodes/SQLQueryNode.tsx`（警示 UI 落点）
7. `scripts/verify-semantic-lineage.ts`（verify 脚本模式）、`docs/tasks/T2.2-semantic-lineage/verification.md`

**govio 仓（D:/Work/gov-io/govio，另开 worktree，见 §6）**
8. `AGENTS.md`（**Documentation Sync Rule 强制**：CLI 命令变更必须同步 `docs/specs/cli.md` 等；测试/ lint 命令）
9. `src/govio/cli/query.py`（CLI 命令组形态：argparse 子命令）、`src/govio/cli/main.py`（命令注册）
10. `src/govio/metadata/metric.py`（MetricLoader：metric_schema.json 校验、REFERS_COLUMN/USES_TABLE 边）
11. `docs/specs/cli.md`、`docs/specs/data-model.md`（Metric 节点/边属性契约）

## 3. 实证事实（主会话已调研）

- **图谱口径定义的可比对面**（schema.md）：`Metric{id,code,name,business_definition,type,formula,unit,statistical_scope,time_scope,...}`；边 `(:Metric)-[:REFERS_COLUMN]->(:Col)`（带 `role` 属性）、`(:Metric)-[:USES_TABLE]->(:PhysicalTable)`、`(:Metric)-[:DIMENSION_USED]->(:Dimension)`。
- **semanticRefs 是现成的比对输入**：T2.2 在 `message_end` 处给 sqlQuery 节点写入 `semanticRefs`（entityType/id/code/name，来自 prompt 注入的图谱实体）；同位置即可拿到 SQL 全文（`block.sql`）与候选指标，无需新增归因。
- **服务端 CLI 调用已存在**：`runGovioCliWithArgs(args: string[], timeoutMs = 30000): Promise<string>`（`server/govio-cli-exec.ts:14`）；T2.1 图谱注入同款「短超时 + 失败降级不阻断」模式（`buildInjectionContext` 永不 throw）。
- **govio CLI 形态**：argparse 子命令组（`src/govio/cli/{main,meta,query,observe,...}.py`），`query.py` 已有 networkx/falkordb/ladybug 三后端查询；`meta.py` 1241 行是最大命令组先例。
- **govio 仓规范**：Python 3.13+ / uv；`uv sync --group dev`、`uv run pytest tests/`、`uv run ruff check src/ tests/`；改 CLI 必须同步 `docs/specs/cli.md`（AGENTS.md Documentation Sync Rule 表格）。
- **UI 设计 token**：警示黄 `#F59B23`（green-deck semantic warning）；节点卡片样式模式见 `src/components/Nodes/` 其他节点。
- **持久化**：node.data 随 canvas sidecar 整体往返（T2.2 已验），新增可选字段照 T2.0/T2.2 的「缺失省略键」模式。
- 环境：Windows Git Bash；`python` 命令是 Windows Store 存根**不可用**——govio 测试一律走 `uv run pytest`；jq 可用。

## 4. 实现范围（逐项编号，对齐 acceptance）

**A. govio 仓（acceptance 1「冲突检测有 CLI 命令支撑」）**
1. 新增口径冲突检测 CLI 命令（命名建议 `govio-cli query caliber`，最终命名 worker 依 CLI 结构定，记录 design.md）：
   - 输入：SQL 文本（`--sql` 或 `--sql-file`）+ 指标（`--metric <code|id>`，可重复）；
   - 输出：**结构化 JSON**（stdout，机器可读），形态建议：`{results:[{metric:{id,code,name}, status:"consistent"|"conflict"|"unknown", differences:[{aspect, expected, found, detail}]}]}`；
   - 退出码约定沿用 govio CLI 既有契约（查 `tests/test_exit_codes.py` 先例）。
2. 比对逻辑下沉独立可单测模块（如 `src/govio/metadata/caliber.py` 或 core/，worker 定），最小比对维度：
   - **聚合口径**：`formula` 中的聚合表达式 vs SQL 的 SELECT 聚合函数/分母分子结构；
   - **过滤/统计范围**：`business_definition`/`statistical_scope`/`time_scope` 描述的关键限定 vs SQL WHERE 条件；
   - **引用列**：`REFERS_COLUMN`（role）列 vs SQL 实际引用列。
   - 判定纪律：**宁可 unknown 不误报 conflict**（语义比对不确定即 unknown）。
3. 测试：pytest 覆盖 consistent/conflict/unknown/多指标/坏输入（空 SQL、未知指标）；`uv run pytest tests/` 全绿（既有零回归）、`uv run ruff check src/ tests/` 绿。
4. 文档同步（govio AGENTS.md 硬规则）：`docs/specs/cli.md`（命令契约）、落点相关 spec（data-model/metadata 视实现）；若命令归属影响 agent 使用说明，同步 `skills/govio-query/` 或 `skills/govio-observe/` SKILL.md。

**B. govio-map 仓（acceptance 2「SQL 节点黄色警示态」）**
5. 服务端挂钩：`message_end` 建 sqlQuery 节点时，若 semanticRefs 含 Metric，经 `runGovioCliWithArgs` 调用冲突检测命令（短超时 ~6s），结果写入事件 `caliberCheck` 字段；CLI 缺失/超时/报错/非 JSON **一律省略键、不阻断、不重试**（T2.2 同款降级）。
6. 类型：`SQLQueryNodeData.caliberCheck?: {...}` 在 `src/types/index.ts` 显式声明（含 status/differences），缺失省略键，旧节点形状不变。
7. UI：`SQLQueryNode.tsx` 黄色警示态——`status==="conflict"` 时节点警示徽标/描边用 warning token（`#F59B23`）+ 可展开差异说明（differences 的 aspect/expected/found 列表）；consistent 不打扰；unknown 的展示取舍（轻提示或不显示）写 design.md。
8. 验证脚本 `scripts/verify-caliber-conflict.ts`（`npm run verify:caliber-conflict` 接入聚合链）：stub CLI 输出，断言至少：检测调用参数（SQL+指标）、结果透传 node.data、sidecar/hydrate 往返、失败降级省略键、UI 状态映射、旧节点兼容；既有断言零回归。

## 5. 范围纪律（明确不做）

- 不做「用户可选择采纳图谱口径」一键改写（ROADMAP 提及，本期只警示+差异说明；落 design.md 遗留问题）；
- 不做 T2.4（元数据导入）；不动 WS 协议 / REF-CTX prompt 格式 / semanticRefs 归因逻辑；
- **map 侧不做 SQL 解析比对**——比对逻辑只在 govio CLI（验收 1 的本意）；
- 不重构既有命令组；新发现缺陷一律记 design.md「遗留问题」。

## 6. 环境与协议

- **两仓两个分支、各一次 commit**（前缀 `T2.3: `）；**不 push**（PR 由主会话创建、用户合并）；
- **govio 仓 worktree**（独立工作区，勿动 `D:/Work/gov-io/govio` 主工作区）：
  `git -C /d/Work/gov-io/govio worktree add /d/Work/gov-io/govio-t23-wt -b task/t23-caliber-conflict`
  然后在该 worktree 内 `uv sync --group dev` 后开发；**不要删除 worktree**（主会话验收后清理）；
- **govio-map 仓**：你在 pi 托管的独立 worktree 中（managed git worktree），先 `git branch --show-current`
  确认分支；第一步 `cp -r /d/Work/gov-io/govio-map/.agents ./`（gitignore 的技能资产，约 350K）；
  需跑 map 门槛时先 `npm install`（网络瞬断就停下报告，禁止假装绿）；
- 并行写权：**禁止修改 govio-map 的 `docs/task-plan.json`**（T2.4 同时执行，主会话统一记账）；
- 交付物三件套落 `docs/tasks/T2.3-caliber-conflict/`：`design.md`（方案与取舍 + 「遗留问题」小节）、
  `CHANGES.md`（两仓文件清单 + 每处摘要）、`verification.md`（验证命令与关键输出）；
- 验证门槛：govio 侧 `uv run pytest tests/` + `uv run ruff check src/ tests/` 全绿；map 侧
  `npm run build` / `npm run lint` / `npm run verify` 全绿（新增脚本接入，既有断言零回归）；各 worktree
  `git status --porcelain` 干净；
- Windows Git Bash：正斜杠、jq、`python` 不可用（govio 测试走 `uv run`）。

## 7. 时间预算

- 总预算 90 分钟（跨两仓）；到期前 15 分钟必须 checkpoint：已改文件 / 各仓验证状态 / 剩余工作（写入
  CHANGES.md 或输出中报告）；超时不是变更安全边界。

## 8. 最终输出格式（≤15 行摘要）

```
status: done | partial
交付物: docs/tasks/T2.3-caliber-conflict/{design,CHANGES,verification}.md
commits: govio <hash> T2.3: ...（分支 task/t23-caliber-conflict，worktree /d/Work/gov-io/govio-t23-wt）
         govio-map <hash> T2.3: ...（分支 <managed 分支名>）
验证: govio pytest ✓（N passed）ruff ✓ | map build ✓ lint ✓ verify ✓（断言 X→Y，新增 verify:caliber-conflict K/K）
实现要点: <1-2 行>
遗留: <无 / 列表>
```
