# T1.2 验证记录

环境：Windows / Git Bash，项目根 `D:/work/gov-io/govio-map`，分支 `feature/phase1-trusted-analysis`。
真实 CLI 验证使用本机已安装的 `govio-cli` 与已配置数据源 `sales`。

## 1. 构建门槛：`npm run build`

```
$ npm run build
> govio-map@0.6.1 build
> tsc -b && vite build

vite v8.3.3 building client environment for production...
✓ 2461 modules transformed.
dist/index.html                     0.79 kB │ gzip:     0.42 kB
dist/assets/index-CY6_Ir1k.css     51.12 kB │ gzip:     9.52 kB
dist/assets/index-D0OPgJ6p.js   6,065.50 kB │ gzip: 1,859.15 kB
✓ built in 1.97s
```

**通过**（仅有既有的 chunk 体积告警）。

补充：`npx tsc -p tsconfig.electron.json` 仍只报 `server/cli.ts(81,24): error TS2345`——这是 main 分支上就存在的既有错误，与本任务无关，未新增其它错误。

## 2. Lint：`npm run lint`

```
$ npm run lint
> govio-map@0.6.1 lint
> eslint .
```

**通过**，0 error / 0 warning。

## 3. 复跑链路验证（mock）：`npm run verify:rerun`

62 项断言全通过，失败 0 项：

```
$ npm run verify:rerun
[1] 复跑参数来自 Manifest 固化的 SQL（非当前输入）
  ✓ 只调用了 load + release 两条命令
  ✓ SQL 全文作为单个数组参数原样传入（含换行/引号/中文）
  ✓ 未使用任何当前输入
  ✓ 数据源取自 Manifest
  ✓ 写入临时 DataFrame 名而非原名（不覆盖已交付结果）
  ✓ 临时名是 CLI 安全标识符
  ✓ 比对后释放同名临时 DataFrame
  ✓ buildRerunLoadArgs 对 --memory 数据源走 --memory
  ✓ tempDfNameFor 归一化非法字符
  ✓ 记录带会话 ID / 临时名 / 完成时间
  ✓ 不可复跑的 Manifest 被拦住
  ✓ 无 SQL 的节点不渲染复跑按钮（canRerun）

[2] 一致 / 漂移 / 失败 三态判定
  ✓ 行数与列结构一致 → identical
  ✓ identical 的 after 校验和与原 Manifest 相同
  ✓ after 快照给出本次行列数
  ✓ before 快照保留原执行时间
  ✓ 行数变化 → drift
  ✓ 漂移摘要写出旧值 → 新值
  ✓ 列名变化 → drift（schemaChanged）
  ✓ dtype 变化 → drift
  ✓ 原留痕无校验和时退化到行数对比（不误报漂移）
  ✓ 无校验和但行数变化 → drift
  ✓ 原留痕无任何基线 → drift（不给假的绿灯）
  ✓ 无基线摘要说明无法确认
  ✓ parseLoadOutput 兼容 observe info 的 schema/column 键名
  ✓ parseLoadOutput 拒绝被截断的输出
  ✓ parseLoadOutput 拒绝 success=false

[3] 失败路径与临时 DataFrame 释放
  ✓ CLI 失败 → outcome=error 且带原因
  ✓ 失败记录不含 after（没有结果）
  ✓ 失败也释放临时 DataFrame
  ✓ 输出被截断 → outcome=error
  ✓ 无 SQL 的 Manifest → outcome=error 且不调用 CLI
  ✓ 释放失败不影响复跑结论（只告警）

[4] 复跑记录写入节点数据（一致刷新时间 / 漂移保留原 Manifest）
  ✓ 一致 → 记录追加到 rerunHistory（最新在前）
  ✓ 一致 → 刷新 manifest.executedAt 为复跑时间
  ✓ 一致 → 原执行时间保留在记录 before 里
  ✓ 一致 → 不显示漂移警告
  ✓ 一致 → Manifest 其余字段未被改写
  ✓ 入参 data 未被就地修改（不可变更新）
  ✓ 漂移 → 原 Manifest 完整保留（深度相等）
  ✓ 漂移 → 节点显示警告标记
  ✓ 漂移 → 记录含旧值/新值/时间
  ✓ 漂移 → 差异摘要给出旧值 → 新值
  ✓ 漂移 → 节点展示的行列数仍是原交付值
  ✓ 再次复跑一致 → 漂移警告消除
  ✓ 记录条数封顶 20（最新在前）

[5] store → canvas_save → loadCanvas → hydrateSession（记录落 canvas sidecar）
  ✓ 复跑请求打到 /api/rerun-dataframe 且只传 nodeId
  ✓ 前端不上传 SQL（复跑用服务端固化的留痕）
  ✓ 漂移记录写入 node.data.rerunHistory
  ✓ 漂移时原 Manifest 未被覆盖
  ✓ 复跑结束后清除进行中状态
  ✓ 同一节点并发复跑只发一次请求
  ✓ 一致记录追加后刷新 executedAt 并消除警告
  ✓ 请求失败 → 节点临时错误提示
  ✓ 请求失败 → 不追加留痕记录
  ✓ sidecar 可读回
  ✓ 复跑记录随 sidecar 持久化
  ✓ sidecar 里原 Manifest 与刷新后的执行时间都在
  ✓ sidecar 里保留漂移旧值/新值
  ✓ 重开会话后记录完整恢复
  ✓ 重开会话后临时态被清空
  ✓ 重开会话后再遇漂移仍会告警且不改写原 Manifest

[6] 真实 CLI 链路：跳过（加 --real 参数执行：npm run verify:rerun -- --real）

共 62 项断言，失败 0 项
PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
```

> 说明：`[5]` 的输出里夹有 `[zustand persist middleware] Unable to update item ...` 与
> `[rerun] 释放临时 DataFrame ... 失败` 两类日志，前者是 Node 环境下没有 localStorage（预期），
> 后者是「释放失败只告警」断言故意注入的失败（预期），均非错误。

## 4. 复跑链路验证（真实 govio-cli）：`npm run verify:rerun -- --real`

在 mock 的 62 项之外，`[6]` 用真实 `govio-cli` + `sales` 数据源跑完整链路，共 **74 项断言全通过**：

```
$ npm run verify:rerun -- --real
[6] 真实 govio-cli 复跑链路（datasource=sales）
  ✓ 基线 DataFrame 加载成功（2 行 × 2 列）
  ✓ 基线 Manifest 带 schema-v1 校验和
  ✓ 真实复跑结论 = identical
  ✓ 真实复跑校验和与原 Manifest 一致
  ✓ 真实复跑记录耗时与临时名
  ✓ 临时 DataFrame 已释放（store 里无残留）
  ✓ 原 DataFrame 未被复跑覆盖/删除
  ✓ 原 DataFrame 仍是 2 行（复跑是验证动作）
  ✓ 真实复跑检出漂移（行数 1 → 2）
  ✓ 漂移摘要含旧值 → 新值
  ✓ 漂移时原 Manifest 未被改写
  ✓ 漂移复跑后同样无临时残留

共 74 项断言，失败 0 项
PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
```

真实链路做的事：
1. `observe load --name verify_rerun_base --datasource sales --sql "SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2 ..."` 建基线（2 行 × 2 列）
2. 用 T1.1 的 `buildManifest` 按 load 输出固化 Manifest（含 `schema-v1` 校验和）
3. `rerunDataFrame(manifest)` 走**真实** `runGovioCliWithArgs`：临时名 load → 对比 → release，结论 `identical`，校验和与原 Manifest 一致
4. `observe info --df` 断言无 `rerun_tmp_*` 残留、原 DF 仍在；`observe info --name verify_rerun_base --rows 0` 断言原 DF 仍是 2 行（**复跑没有覆盖交付结果**）
5. 伪造一份「上次只有 1 行」的留痕再复跑，真实链路检出 `drift`（`rowCountDelta = 1`，摘要含 `1 → 2`），且 `before` 快照未被改写
6. `finally` 释放 `verify_rerun_base`，验证结束后 `govio-cli observe info --df` 返回 `{"dataframes":[]}`（无残留）

## 5. 回归：`npm run verify:manifest`（T1.1 的 52 项断言）

```
$ npm run verify:manifest
...
  ✓ 恢复后 SQL 全文与校验和未变
  ✓ 同 dfName 不重复建节点
  ✓ 已有 Manifest 不被静默覆盖（漂移判定留给 T1.2）

共 52 项断言，失败 0 项
PASS: Manifest 往返无丢失
```

T1.1 的留痕链路无回归（本任务只改了 `parquet-api.ts` 的 CLI runner 引用，未改 `/api/execute-sql` 的 Manifest 填充）。

## 6. 设计前的 CLI 行为实测（决策依据）

| 命令 | 结论 |
|------|------|
| `govio-cli observe load --help` | 参数为 `--name / --datasource \| --memory / --sql / -o`；`--name` 要求小写字母+下划线 |
| `govio-cli observe load --name probe_a --datasource sales --sql "SELECT 1 AS x, 'a' AS y"` | 输出自带 `rows` / `columns` / `column_info[{name,dtype}]`，复跑**无需**再调 `observe info` |
| 同名重复 load（1 行 → 2 行） | 成功且直接覆盖，不报错（说明「覆盖式复跑」技术上可行，本任务仍选验证式，理由见 design.md §3） |
| `observe load --name rerun_tmp_probe_a_1730000000 ...` / 58 字符长名 | 临时名（含数字、下划线、长名）被接受 |
| `observe release --name <tmp>` | 返回 `{"success":true,"message":"DataFrame '...' 已释放"}` |
| `observe info --name probe_b --rows 0` vs `observe load` 的 `column_info` | dtype 完全一致（`int32`/`str`/`float64`/`bool`），只是列键名分别为 `schema[].column` 与 `column_info[].name` → `parseLoadOutput` 两者都兼容，T1.1 两条填充路径的校验和可直接对比 |

所有探针 DataFrame 均已 `observe release`，验证结束时 `observe info --df` 为 `{"dataframes":[]}`。

## 7. 未覆盖项（诚实记录）

- **浏览器点击路径未做人工冒烟**：本工作区没有 `.env`（无 LLM API Key），后端起不了真实 agent 会话，`readManifestFromCanvas` 依赖的 session sidecar 也无法在不污染用户真实会话的前提下伪造（`canvas_save` 会覆盖被恢复会话的 sidecar）。因此 HTTP 路由这一段由类型检查 + `[5]` 的 store 侧断言（请求 URL、请求体只含 nodeId、响应记录写入 `node.data`）覆盖，未做端到端点击验证。
  建议验收时的人工冒烟步骤：`npm run dev` → 让 agent 跑一次 `observe load` 生成 dataFrame 节点 → 点节点「复跑」→ 观察按钮变「复跑中」→ 状态条出现「复现一致 · 时间 · N 行 × M 列」→ 点「详情」确认 `executedAt` 已刷新 → 刷新页面/重开会话确认记录仍在 → 手工把某节点的 `rerunHistory[0]` 改成 `outcome: 'drift'`（或在数据源侧改动数据后复跑）确认头部出现「漂移」标签与 warning 边框。
- **漂移的真实业务场景**（源表数据变化导致行数变化）未在生产数据源上触发，`[6]` 用「伪造基线行数」的方式在真实 CLI 上验证了检出能力。
- **值级漂移**（同结构同规模、数值变化）按设计检不出，见 design.md 遗留问题 1。
