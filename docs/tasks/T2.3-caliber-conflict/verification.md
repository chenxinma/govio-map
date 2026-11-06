# T2.3 验证记录（verification.md）

## govio 仓（分支 `task/t23-caliber-conflict`，worktree `/d/Work/gov-io/govio-t23-wt`）

### 门槛命令与结果

| 命令 | 结果 |
|---|---|
| `uv run ruff check src/ tests/` | ✓ All checks passed |
| `uv run pytest tests/` | 401 passed, 18 skipped, **4 failed（预存在环境失败，见下）** |
| `uv run pytest tests/test_caliber_compare.py tests/test_caliber_cli.py` | **36 passed**（本任务新增用例全绿） |

### 预存在失败的 clean-base 对照证据

`uv run pytest tests/` 的 4 个失败与本任务无关，**在 stash 掉全部本任务改动的
clean base 上同样失败**（对照命令与输出）：

```bash
$ git stash -u && uv run pytest tests/test_exit_codes.py::test_observe_compare_success_exits_zero \
    tests/test_metadata_benchmark.py::test_compose_prompt_contains_materials_and_question -q
FAILED tests/test_exit_codes.py::test_observe_compare_success_exits_zero - Mo...
FAILED tests/test_metadata_benchmark.py::test_compose_prompt_contains_materials_and_question
2 failed in 2.70s
$ git stash pop
```

失败清单与原因（均为环境性，非代码缺陷）：

| 用例 | 原因 |
|---|---|
| `test_exit_codes.py::test_observe_compare_success_exits_zero` | `ModuleNotFoundError: No module named 'datacompy.core'`（dev 依赖集不含 datacompy） |
| `test_exit_codes.py::test_observe_compare_exec_error_exits_one` | 同上 |
| `test_exit_codes.py::test_observe_compare_no_diff_exits_zero` | 同上 |
| `test_metadata_benchmark.py::test_compose_prompt_contains_materials_and_question` | `FileNotFoundError: skills/govio/assets/schema.md`（skills 产物不入 git，fresh worktree 缺失） |

新增用例分布：`tests/test_caliber_compare.py`（纯比对：consistent/conflict/unknown/
多指标/SQL 事实/图读取打桩，22 项）+ `tests/test_caliber_cli.py`（命令契约：输入/
JSON 形态/退出码/未知指标降级，14 项）= 36。

## govio-map 仓（分支 `pi-subagents/task-1-bb94b78-1011-s0-t0`，managed worktree）

### 门槛命令与结果

| 命令 | 结果 |
|---|---|
| `npm run build` | ✓（tsc + vite，仅既有 chunk size warning） |
| `npm run lint` | ✓ 0 problems |
| `npm run verify` | ✓ exit=0（聚合链全绿，既有断言零回归） |

### verify 聚合链断言数（全跑后 `git status --porcelain` 无 verify 残留）

| 脚本 | 断言 | 备注 |
|---|---|---|
| verify:manifest | 92 项，失败 0 | 既有 |
| verify:rerun | 71 项，失败 0 | 既有 |
| verify:audit | 119 项，失败 0 | 既有 |
| verify:export | 126 项，失败 0 | 既有 |
| verify:source-table | 39 项，失败 0 | 既有 |
| verify:semantic-lineage | 45 项，失败 0 | 既有（仅注入恒失败 caliber stub，断言不变） |
| **verify:caliber-conflict** | **43/43** | **新增** |
| verify:cwd | 13 项，失败 0 | 既有 |
| verify:prompt-injection | 全绿 | 既有 |
| verify:integration | vitest 59 passed（5 files） | 既有 |

新增断言覆盖（对照任务书 §4.8 清单）：检测调用参数（SQL 全文 + 指标）✓、
结果透传 node.data ✓、sidecar/hydrate 往返 ✓、失败降级省略键（拒绝/非 JSON/
超时等价/空输入，不重试）✓、UI 状态映射（conflict 警示 / consistent、unknown、
旧节点不显示）✓、旧节点兼容（事件与历史 sidecar 均不建键）✓。

### 关键实证

- `message_end` 补挂时序：pi `agent-session.js`「Emit to extensions first, then
  notify public listeners」——扩展钩子被 await 后才向 WS 订阅者广播/flush，事件
  补挂 `caliberCheck` 先于序列化完成（verify:[4] 以 await handler 后 flush 断言）；
- verify:semantic-lineage 45 项零回归（其同步驱动 handler 的行为由「同步 push +
  异步补挂」结构保持）。
