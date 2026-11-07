# T2.4 verification — 元数据增量导入与校验报告

> 结论：全部门槛绿（govio 侧 4 个失败为改动前基线既有，零回归）；acceptance ①② 均有
> 测试 + 演示实跑双路证据。

## 1. govio 仓门槛（worktree `/d/Work/gov-io/govio-t24-wt`，分支 `task/t24-meta-incremental`）

### `uv run pytest tests/`

| | 改动前基线（main b840a0a） | 改动后（144c4d0） |
|---|---|---|
| passed | 365 | 386（+21 = 新增用例数） |
| skipped | 18 | 18 |
| failed | 4 | 4（**同一批**，非本任务引入） |

4 个既有失败（与本任务无关，改动前即存在）：
- `tests/test_exit_codes.py::test_observe_compare_*` ×3 —— 环境缺 `datacompy.core`（ModuleNotFoundError）
- `tests/test_metadata_benchmark.py::test_compose_prompt_contains_materials_and_question` —— pathlib FileNotFoundError

新增 21 用例（`tests/test_import_report.py` 16 + `tests/test_meta_idempotent.py` 5）：

```
tests/test_meta_idempotent.py::test_repeat_import_is_idempotent              # 幂等固化（acceptance ①）
tests/test_meta_idempotent.py::test_report_written_to_output_dir_by_default  # 报告默认落 --output（acceptance ②）
tests/test_meta_idempotent.py::test_report_override_path                     # --report 覆盖
tests/test_meta_idempotent.py::test_bad_input_writes_no_partial_report       # 坏输入不产半截报告，退出码 1
tests/test_meta_idempotent.py::test_import_schema_one_shot_writes_report     # import-schema 一步式产报告
tests/test_import_report.py::（classify_rows 分类 ×5、delta 累计/清零 ×2、导入计数 ×2、
  三项校验 ×4、报告组装/落盘 ×3）
```

`test_repeat_import_is_idempotent` 断言：两轮后图库节点/边（含属性，NaN 归一）完全一致、
第二轮 changes 新增=0/更新=0/全部 skipped、两轮 import_counts 相等、校验项全 pass、
CSV 目录两轮内容一致。

### `uv run ruff check src/ tests/`

```
All checks passed!
```

## 2. govio-map 仓门槛（代码零改动，仅新增 docs/tasks 交付物）

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm install` | ✓ | added 719 packages（注：首次后台 install 收尾被会话截断致 `node_modules/.bin` 缺失、build 报 `tsc 不是命令`；重跑 `npm install` 补全后正常，非代码问题） |
| `npm run build` | ✓ exit 0 | `tsc -b && vite build` … `✓ built in 2.13s`（仅有既有的 chunk>700kB 提示） |
| `npm run lint` | ✓ exit 0 | `eslint .` 无输出 |
| `npm run verify` | ✓ exit 0 | 9 个子项全绿：manifest / rerun / audit / export / source-table / semantic-lineage / cwd / prompt-injection / integration（`vitest run` 5 文件 59 用例全过） |

`git status --porcelain`：仅本任务 4+1 个交付物（新增），无源码改动。

## 3. 演示实跑（acceptance ②「校验报告输出到任务目录」实证）

环境（全部在仓外临时目录，不污染仓库与用户配置）：
- 输入：govio 仓 `data/chocolate.db`（DuckDB，schema `chocolate`：4 表 17 列）+ 临时构造
  `relationships.json`（3 条 RELATES_TO）+ `metrics.json`（1 指标 1 维度）
- 图后端：networkx；`USERPROFILE` 指向 `D:/Work/gov-io/govio-t24-demo/home`（内含
  `.govio/config.yaml`，gml → `<demo>/assets/ontology.gml`），`--assets-dir`/`--output`
  均指向 `D:/Work/gov-io/govio-t24-demo/`

每轮命令（两轮完全相同）：

```bash
uv run govio-cli meta meta --source duckdb --db ../govio/data/chocolate.db \
  --schemas chocolate --datasource chocolate --output <demo>/out
uv run govio-cli meta rel --file <demo>/relationships.json --output <demo>/out
uv run govio-cli meta metric --file <demo>/metrics.json --output <demo>/out
uv run govio-cli meta graph --output <demo>/out --assets-dir <demo>/assets --mode update
```

关键输出（两轮一致，日志见 `<demo>/round{1,2}.log`）：

```
✓ 元数据已导出: 1 个数据源, 4 张表, 17 个字段
✓ RELATES_TO 已导出: 3 个关系
✓ 指标数据已导出: 1 个指标, 1 个维度
✓ GML 文件已更新（nodes 24, edges 27）
✓ 校验报告已写入: <demo>/out\import-report.json（校验结果: pass）
✅ graph 更新完成！
```

### 幂等证据

- **图库字节级一致**：两轮 `md5sum assets/ontology.gml` 均为
  `ecc71b4ae2f899d47e89382f589e1b81`
- **第二轮零变更**（`jq .changes.totals`）：
  - round1：`{"added": 51, "updated": 0, "skipped": 0}`（全新导入）
  - round2：`{"added": 0, "updated": 0, "skipped": 51}`（逐类型：nodes
    PT4/Col17/DS1/Metric1/Dimension1、edges HAS_COLUMN17/OWNS4/RELATES_TO3/
    USES_TABLE1/REFERS_COLUMN1/DIMENSION_USED1 全部 skipped，见报告 `changes`）
- **各类型计数不变**：两轮 `jq -S .import_counts` diff 为空
- **校验项全 pass**：两轮 `checks` 均为
  `duplicate_node_ids/missing_required/orphan_edges` 各 `status: pass, count: 0`

### 「输出到任务目录」证据文件

- `docs/tasks/T2.4-meta-incremental-import/round1-import-report.json`（首轮报告）
- `docs/tasks/T2.4-meta-incremental-import/round2-import-report.json`（重复导入报告，
  changes 全 skipped = 幂等证明）

即 CLI 侧报告默认写入导入 `--output` 目录 + 演示报告留存任务目录的双证据（design.md §2.2）。

## 4. 复现方式

govio 门槛：进入 `/d/Work/gov-io/govio-t24-wt` 执行 `uv run pytest tests/`、
`uv run ruff check src/ tests/`；演示实跑按 §3 命令重跑（输入构造见
`<demo>/relationships.json`、`<demo>/metrics.json`，schema 需含 `chocolate`）。
