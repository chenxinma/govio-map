# T2.3 变更清单（CHANGES.md）

> 口径冲突检测。跨两仓：govio（CLI 比对逻辑）+ govio-map（服务端挂钩 + 黄色警示 UI + verify 脚本）。
> 交付物三件套：`design.md`（方案与取舍 + 遗留问题）、`CHANGES.md`（本文件）、`verification.md`。

## checkpoint（执行中更新）

- [x] govio 仓：比对模块 + CLI 命令 + 测试 + 文档同步
- [x] govio 仓 commit：`e4e1b62` `T2.3: sql caliber 口径冲突检测命令（比对逻辑下沉 metadata.caliber，宁可 unknown 不误报）`
- [x] map 仓：服务端挂钩（message_end → runGovioCliWithArgs → 事件 caliberCheck）
- [x] map 仓：类型（CaliberCheck / SQLQueryNodeData.caliberCheck）
- [x] map 仓：SQLQueryNode 黄色警示 UI
- [x] map 仓：scripts/verify-caliber-conflict.ts + npm run verify 接入
- [x] map 仓门槛：npm run build / lint / verify 全绿
- [x] 本三件套补齐 + map 仓 commit（见文末）

## govio 仓（分支 `task/t23-caliber-conflict`，worktree `/d/Work/gov-io/govio-t23-wt`）

| 文件 | 变更 |
|---|---|
| `src/govio/metadata/caliber.py` | 新增。口径冲突检测纯模块（stdlib-only）：`extract_sql_facts`（聚合调用/引用列/WHERE 条件/时间窗，字面量等长掩蔽保偏移）、`check_caliber`/`compare_metric`（输出 `{results:[{metric,status,differences}]}`，status: consistent/conflict/unknown，判定纪律「宁可 unknown 不误报 conflict」）、`read_metric_caliber`（图对象注入读取 Metric + REFERS_COLUMN，支持 NetworkX/Cypher 后端） |
| `src/govio/cli/sql.py` | `sql` 命令组新增 `caliber` 子命令：`--sql`/`--sql-file` + `--metric`（可重复，code 或节点 ID）；stdout 单行 JSON（ensure_ascii）；退出码契约：比对完成（含 conflict/unknown）0，坏输入/配置/图后端错误 1，未知指标降级单指标 unknown 不算失败 |
| `tests/test_caliber_compare.py` | 新增。纯比对逻辑：consistent/conflict（聚合签名、DISTINCT、时间窗、计量列）/unknown（弱证据、COUNT(*) 限定、空 SQL）/多指标/SQL 事实提取/图读取打桩（NetworkX + Cypher） |
| `tests/test_caliber_cli.py` | 新增。CLI：--sql/--sql-file/--metric 重复、JSON 输出形态（纯 ASCII 单行）、退出码契约、未知指标降级、多指标混排、配置缺失 |
| `docs/specs/cli.md` | `sql.py` 节补充 `caliber` 子命令契约（参数/输出 JSON/退出码） |
| `docs/specs/metadata.md` | 新增 `caliber` 模块说明（比对维度与判定纪律） |
| `docs/specs/README.md` | 模块清单补 `govio.metadata.caliber` |
| `skills/govio-query/SKILL.md` | 补 `govio-cli sql caliber` 用法（agent 取数后口径自检） |

## govio-map 仓（分支 `pi-subagents/task-1-bb94b78-1011-s0-t0`，managed worktree）

| 文件 | 变更 |
|---|---|
| `src/types/semantic.ts` | 新增 `CaliberStatus`/`CaliberDifference`（带 metricCode/metricName 归属）/`CaliberCheck`（status + differences，缺失省略键） |
| `src/types/index.ts` | re-export 口径类型；`SQLQueryNodeData.caliberCheck?: CaliberCheck`（缺失不写键，旧节点形状不变） |
| `server/caliber-check.ts` | 新增。调用编排（**不解析 SQL**）：`buildCaliberArgs`（SQL 全文单参数 + 可重复 --metric）、`parseCaliberOutput`（汇总 status + differences 扁平化 + 形状校验）、`runCaliberCheck`（6s 短超时，失败/非 JSON 省略键、不阻断不重试，CLI runner 可注入） |
| `server/govio-node-queue.ts` | `GovioNodeCreateEvent.caliberCheck` 字段 |
| `server/extensions/govio-canvas.ts` | `message_end` 钩子 async 化：同步 push 事件（行为不变）→ Metric 引用经 `govio-cli sql caliber` 比对 → 结果补挂已入队事件（pi 先 await 扩展钩子再 WS 广播，补挂先于序列化）；`govioCanvasExtension(pi, deps?)` 支持注入 CLI runner（verify 隔离用） |
| `src/services/canvas-service.ts` | `CanvasEvent.caliberCheck` 字段（上屏透传） |
| `src/store/canvas-store.ts` | `createGovioNode` sqlQuery 分支透传 caliberCheck（缺失不建键） |
| `src/utils/caliber.ts` | 新增。UI 状态映射唯一取值来源：`caliberNodeAppearance`（仅 conflict 亮警示）、警示色 `#F59B23`、aspect 展示名表 |
| `src/components/Nodes/SQLQueryNode.tsx` | 黄色警示态：conflict → 描边 + 「口径冲突」徽标（可点展开差异清单：aspect/期望/实际/说明，带指标归属）；consistent/unknown/旧节点零变化 |
| `scripts/verify-caliber-conflict.ts` | 新增（43 项断言）：调用参数/结果解析/降级纪律/message_end 钩子/透传/sidecar+hydrate 往返/UI 状态映射/旧节点兼容 |
| `scripts/verify-semantic-lineage.ts` | 注入恒失败 caliber CLI stub（保持 hermetic 不真调 CLI；断言零变化） |
| `package.json` | `verify:caliber-conflict` 脚本 + 接入聚合 `verify` 链 |
| `docs/tasks/T2.3-caliber-conflict/{design,CHANGES,verification}.md` | 交付物三件套 |
