# T2.4 design — 元数据增量导入与校验报告

> 任务：govio-meta 导入流程的增量幂等固化与落盘校验报告。
> acceptance：①重复导入幂等 ②校验报告输出到任务目录。
> 实现主体在 **govio 仓**（分支 `task/t24-meta-incremental`，worktree `/d/Work/gov-io/govio-t24-wt`）；
> 本仓仅交付物与实跑证据，代码零改动。

## 1. 现状与结论（根因分析）

- **导入链路**：子命令把输入 merge 进 `--output` 目录 CSV（`merge_node_csv` / `merge_edge_csv`，
  按业务键去重、新的覆盖旧的）→ `meta graph --mode update` 读 CSV 增量导入图库。
- **幂等根基**：`node_id = <2 字符前缀><SHA256(业务键)[:8]>`（`src/govio/metadata/node_id.py`）
  完全确定，同批输入重复导入不漂移；CSV merge 按业务键去重、`build_graph` 按 ID 覆盖式
  `add_node`/`add_edge`——**现状即幂等，未发现根源性缺陷，node_id 算法未改动**。
  由 `tests/test_meta_idempotent.py` 测试固化（此前无任何测试覆盖该承诺）。

## 2. 方案取舍

### 2.1 校验报告形态：仅 JSON（不做 Markdown）

机器可读 JSON 落盘，人可读由 stdout 摘要行（`✓ 校验报告已写入: <path>（校验结果: pass）`）
与 `jq` 承担。双格式会引入一致性维护面，收益低。字段契约见 govio `docs/specs/cli.md`
「校验报告（import-report.json）」：`import_counts` / `changes` / `checks` / `summary` /
`report_version` / `generated_at` / `csv_dir` / `mode` / `backend`。

### 2.2 报告位置：双证据（对齐任务书 §3）

- CLI 侧默认写入该次导入的 `--output` 目录（CSV 目录 = 导入任务共享状态目录），
  `--report <path>` 可覆盖；`meta graph` 与一步式 `import-schema` 均产出。
- 演示实跑产出的 `round1-import-report.json` / `round2-import-report.json` 另存
  本任务目录，作为「输出到任务目录」的验收实证。
- 未发现更贴切的 CLI job/任务概念，`--output` 目录即任务目录语义的最佳落点。

### 2.3 新增/更新/跳过口径：merge 级增量（备选：图快照 diff，未采纳）

| 方案 | 说明 | 取舍 |
|---|---|---|
| **merge 级分类（采纳）** | merge CSV 时按业务键把本次输入与已有 CSV 分类：新增=键不存在 / 更新=键存在但值变化 / 跳过=值相同；计数累计进 `<output>/import-delta.json`，graph 同步成功后 fold 进报告并清零 | 与图后端无关（三后端统一）；直接给出幂等证据（第二轮全 skipped）；改动面收敛在 `cli/meta.py` + 新模块 |
| 图快照 diff（未采纳） | 导图前后对比图内节点/边 | 只对 NetworkX 可精确实现；FalkorDB/Ladybug 需额外全量回读，改动侵入 graph loader（范围纪律要求不动后端） |

值比较为字符串化（NaN 视为空串），两轮间 dtype 序列化稳定（demo/测试验证）。

### 2.4 校验项：三项全做

`duplicate_node_ids`（同节点 CSV 内 `:ID(...)` 重复）、`missing_required`（节点缺
node_id 或 name〔有 name 列时〕、边缺端点 ID）、`orphan_edges`（边端点不在任何节点
CSV）。空端点只计 `missing_required`，不重复计孤儿。每项含 `status`/`count`/`examples`
（样例最多 5 条）。`Datasource.csv` 无 name 列（业务键即标识），故 name 必填仅在
name 列存在时生效。

### 2.5 失败语义（唯一行为变化）

图更新失败时**不写报告**（不留半截，`write_import_report` 整体序列化单次写入），
`meta graph` / `meta import-schema` 打印 `❌ ...（未生成校验报告）` 并**退出码 1**。
顺带修复了旧版失败后仍打印 `✅ graph 更新完成！` 且退出 0 的误导行为（与仓库
`test_exit_codes.py` 的失败退出码纪律对齐）。成功路径 stdout 的 ✓/行数体验不变。

## 3. 测试设计

- `tests/test_meta_idempotent.py`（21 项中的集成部分）：mock 全部 Loader + 真实 DuckDB
  小库，跑「子命令 + meta graph --mode update」两轮——两轮图库状态（含属性）一致、
  第二轮 changes 新增/更新=0 全 skipped、各类型计数不变、校验项全 pass、CSV 两轮一致；
  另覆盖报告默认位置、`--report` 覆盖、坏输入不产半截报告（退出码 1）、import-schema 一步式。
- `tests/test_import_report.py`：classify_rows 分类（含 NaN 归一）、delta 累计/清零、
  导入计数、三项校验、报告组装与落盘。

## 4. 遗留问题

1. **图快照级漂移不可感知**：`changes` 只反映 merge 增量；图被外部直接改动（手工清图/
   混入其它工具）时报告不感知。若需要图真相核对，后续可加图快照 diff 校验项（跨三后端）。
2. **FalkorDB node MERGE 按全属性匹配**（`falkordb_loader._build_node_merge_query`）：
   属性变化的行会 MERGE 不中而生成同 ID 重复节点，update 语义不完整。属图后端 loader
   范围（T2.3/后端任务），本次未动。
3. **GML 落盘不自建父目录**：`build_graph` 目标目录不存在时报
   `[Errno 2] No such file or directory`（既有行为；测试预建目录绕开）。
4. **`_load_csv_with_node_ids` 给 CSV 追加冗余 `node_id` 属性列**（既有行为）：图节点会
   带一个与 ID 重复的 `node_id` 属性；两轮状态一致，不影响幂等，但值得后续清理。
5. **`changes` 的字符串化比较**：dtype 跨轮序列化格式若有漂移（如浮点格式化差异）会把
   相同值误计为 updated；demo 与测试未出现，量大/异构输入时留意。
6. govio-map 的 `.agents/skills/govio-meta/SKILL.md` 运行时副本待主会话合并后手动同步
   （本次已更新 govio 仓 `skills/govio-meta/SKILL.md`）。
