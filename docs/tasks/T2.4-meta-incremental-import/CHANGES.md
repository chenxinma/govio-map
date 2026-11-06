# T2.4 CHANGES — 元数据增量导入与校验报告

两仓各一次 commit（前缀 `T2.4: `，均未 push）：

| 仓 | 分支 | worktree | commit |
|---|---|---|---|
| govio | `task/t24-meta-incremental` | `/d/Work/gov-io/govio-t24-wt` | `144c4d0` |
| govio-map | `pi-subagents/task-2-f1fde38-768b-s0-t0` | 本 worktree | （本次提交） |

## govio 仓（代码主体，8 文件，+1021/-6）

| 文件 | 摘要 |
|---|---|
| `src/govio/metadata/import_report.py`（新增） | 导入校验报告与增量统计：`classify_rows`（业务键分类 added/updated/skipped）、`record_merge_delta`/`take_merge_delta`（`import-delta.json` 累计与取走清零）、`collect_import_counts`、`run_validation_checks`（duplicate_node_ids / missing_required / orphan_edges）、`build_import_report`/`write_import_report`（整体序列化单次写入） |
| `src/govio/cli/meta.py` | ① `merge_node_csv`/`merge_edge_csv` merge 时分类本次输入并累计进 `import-delta.json`；② 新增 `_write_import_report`，`cmd_graph`/`cmd_import-schema` 图更新成功后产出报告（默认 `<output>/import-report.json`）；③ 图更新失败不再误报 ✅：打印 `❌ ...（未生成校验报告）`、不写报告、退出码 1；④ `meta graph` / `meta import-schema` 增加 `--report <path>` |
| `tests/test_meta_idempotent.py`（新增） | 幂等固化：真实 DuckDB 小库 + mock Loader 跑两轮「子命令 + meta graph --mode update」，断言两轮图库状态（含属性）一致、第二轮零变更（added/updated=0 全 skipped）、各类型计数不变、校验项全 pass、CSV 两轮一致；另覆盖报告默认位置/`--report` 覆盖/坏输入不产半截报告/import-schema 一步式 |
| `tests/test_import_report.py`（新增） | 分类（含 NaN 归一）、delta 累计清零、导入计数、三项校验、报告组装与落盘的单元测试 |
| `docs/specs/cli.md` | 「CSV Merge Helpers」补 delta 记录说明；Graph Management 补失败语义；新增「校验报告（import-report.json）」小节（--report 参数、字段契约、changes 口径）；import-schema 参数表补 `--report` |
| `docs/specs/metadata.md` | 新增 `import_report.py` 模块小节（函数清单与校验口径） |
| `docs/specs/README.md` | `govio.metadata` 模块描述补 import validation report |
| `skills/govio-meta/SKILL.md` | 标准工作循环补幂等固化说明；`meta graph`/速查补校验报告；新增「校验报告（import-report.json）」章节（位置、解读、与约束 4 的边界：读报告不算二次校验） |

## govio-map 仓（代码零改动，仅交付物）

| 文件 | 摘要 |
|---|---|
| `docs/tasks/T2.4-meta-incremental-import/design.md` | 方案与取舍（报告形态/位置双证据/changes 口径/校验项/失败语义）+ 遗留问题 |
| `docs/tasks/T2.4-meta-incremental-import/CHANGES.md` | 本文件：两仓文件清单 |
| `docs/tasks/T2.4-meta-incremental-import/verification.md` | 验证命令与关键输出（pytest/ruff/npm 门槛 + 演示实跑两轮） |
| `docs/tasks/T2.4-meta-incremental-import/round1-import-report.json` | 演示实跑第 1 轮报告（全新导入 added=51）——「校验报告输出到任务目录」实证 |
| `docs/tasks/T2.4-meta-incremental-import/round2-import-report.json` | 演示实跑第 2 轮报告（重复导入 added=0/updated=0/skipped=51）——幂等实证 |
