# Review Round 1 修复对照表（Phase 1 · feature/phase1-trusted-analysis）

> 执行者：fix worker（主 session 综合三份 reviewer 报告后下发 22 项清单）
> 基线：HEAD `b50b527`；本次修复为单独 commit（见文末）。范围纪律：仅清单内修复，无清单外重构。

## 逐项对照

| # | 文件:位置 | 修复说明 |
|---|---|---|
| 1 | `scripts/verify-export-report.ts:29-48` | 顶部钉住 `process.env.TZ = "Asia/Shanghai"`；新增 `EXPECT_*` 字面量常量，5 处用 `formatTimestamp`/`formatRerunTime` 生成期望值的自参照断言全部改为钉住时区后的字面量（`2026-10-31 08:45:00` 等），两个格式化函数不再被脚本导入 |
| 2 | `scripts/verify-export-report.ts` [7] 节末尾 | 产物默认写入 `mkdtemp` 临时目录；仅 `--write` 时更新受跟踪的 `sample-export.html`；新增断言「默认运行不改写受跟踪样例」（前后读文件比对） |
| 3 | `scripts/verify-export-report.ts` fixture + [7]/[8] | `XSS_SENTINEL` 放入审计 deny 条目的 `command`，断言附录 B 输出 `&lt;script&gt;alert(&#39;xss&#39;)` 转义形态；新增 chart 节点标题含双引号用例，断言 `<img alt="...">` 属性内 `&quot;` 闭合不被打破 |
| 4 | `src/utils/export-report.ts` `fetchAuditAppendix` + 脚本 [8] | 空 `decisionIds` 分支改为 `available: true, totalInSession: 0`（与 `renderAppendixB` 的「没有任何节点带 permissionDecisionId」分支对齐，第四形态生产可达）；脚本用真实调用 `await fetchAuditAppendix([])` 断言该形态 |
| 5 | `scripts/verify-rerun-drift.ts:101-108` | 删除恒真子句 `currentEditorInput !== SQL` 与孤儿变量；保留有效断言并改标签为「argv 未混入 Manifest 之外的 SQL」 |
| 6 | `scripts/verify-manifest-roundtrip.ts` [5] 节末尾 | 新增回填分支用例：先推**无 manifest** 的 dataFrame 事件建节点，再推同 dfName **带 manifest** 事件，断言 `canvas-store.ts` 回填分支写入 manifest 且不重建节点（此前该分支零覆盖） |
| 7 | `server/permission-manager.ts` `clearAll()` | 追加 `decisionsByCommand.clear()` + `decisionsByToolCall.clear()`，决策索引随会话失效（防跨会话命令文本兜底错绑 decisionId） |
| 8 | `server/ws-handler.ts:174-179` | `restartAgentSession()`（save_models_config 路径）入口补调 `permissionManager.clearAll()`，与 clear/session_open 同等待遇 |
| 9 | `server/permission-manager.ts` `resolve()` + 新私有方法 `auditLateDecision()` | 取不到 pending entry 时补写一条 `permission_decision`：`source:"user"`、`reason:"决策晚于超时，未生效"`、`command:""`（原命令已不在挂起表，如实置空）、`elapsedMs:0`；仅接受 `pd-` 前缀 requestId（防垃圾 ID 灌日志）；静默不抛错 |
| 10 | `server/parquet-api.ts` `/api/permission-audit` | `decisionIds` 缺失/解析后为空 → 400（不再默认全量返回会话命令历史）；`requested` 改为截断前的真实请求数，超 500 截断时响应带 `truncated: true`；路由注释同步 |
| 11 | `server/parquet-api.ts` `readManifestFromCanvas` 注释 | 措辞收敛：明确「不接受 HTTP 请求体传入 SQL」是可复现性约束而非安全边界；sidecar 是本机会话文件，防篡改属 X1 |
| 12 | `server/dataframe-rerun.ts` `rerunBlockReason()` | 形状校验：`sql`/`datasource` 必须为 string；`dfName` 必须为 string 且匹配 `/^[A-Za-z0-9_]+$/`，否则拒绝复跑（畸形留痕不进 CLI 参数） |
| 13 | `src/utils/export-report.ts` 新增 `auditSidecarLabel()`；附录 B intro + 页脚 | 审计 sidecar 路径只渲染 basename（`split(/[\\/]/).pop()`），不再外泄操作者本机绝对路径；fixture 改为 Windows 绝对路径并断言产物不含 `D:` 与 `\Work\` |
| 14 | `src/utils/export-report.ts` `AuditAppendix`/`renderAppendixB`/`fetchAuditAppendix` | 新增 `serverRequested?`/`truncated?` 字段；附录 B 过滤数改用服务端实际值（缺失时退回前端请求数）；`truncated` 时明示「⚠ 审计通道截断，仅带出前 500 个 decisionId」并给回查指引；脚本构造 600 ID 场景断言 |
| 15 | `src/utils/export-report.ts` `CardContext.autoApprovedIds` + `renderNodeCard` 徽标 | 徽标「已确认取数」→「已过确认门」；关联审计条目 `source/gate === "accept-all"` 时显示「已过确认门（自动放行）」；拿不到条目时为中性措辞。脚本对人工/自动两形态分别断言 |
| 16 | `src/types/manifest.ts` + `server/analysis-manifest.ts` `buildManifest` + `src/utils/rerun.ts` `withRerunRecord` | 新增可选字段 `firstExecutedAt`（不可变，首次固化时间；schemaVersion 不变）；构建时与 `executedAt` 同值写入；identical 复跑刷新 `executedAt` 时保留，旧留痕缺失时从 `record.before.executedAt` 补齐。脚本断言：单次/连续 25 次复跑后仍可回溯、legacy 补齐 |
| 17 | `src/types/manifest.ts:36` | 校验和注释改为与实现一致：`sha256(JSON.stringify([rowCount, columnCount, [[name, dtype], …]]))` 前 16 位十六进制（列顺序参与哈希） |
| 18 | `docs/specs/10-observe-load-permission.md` + `scripts/verify-permission-audit.ts` 新 [8] 节 | 规格改为实际的两条独立正则 AND（删「单一正则取交集」的错误描述）；`-oxxx` 标注为当前不触发的已知缺口；「测试」小节改为实际存在的 `npm run verify:audit`；脚本补 `shouldAskPermission` 直接断言 6 例（`-o=x` / `--output x` / `observe compare -o` 不触发 / SQL 文本含 `-o` 不误判 / 普通加载不触发 / `-oxxx` 已知缺口） |
| 19 | `docs/specs/06-backend.md` `/api/permission-audit` 一节 | 同步：`decisionIds` 必填、400 行为、`requested`=截断前请求数、`truncated` 字段语义、导出侧 basename 与截断告知义务 |
| 20 | `docs/tasks/T1.{1,2,3,4}*/CHANGES.md` 首行及行数表述 | 文件计数按枚举逐条相加修正：T1.1 16→**18**、T1.2 16→**18**、T1.3 13→**15**、T1.4 17→**19**（三件套按 3 文件计）；精确行数改「约 N 行」；断言数标注「交付时 N 项，R1 后见本文件」 |
| 21 | `docs/ROADMAP.md` KR1 行 | 加注实际交付子集（dataFrame+sqlQuery；SQL/数据源名/执行时间含 firstExecutedAt/规模+结构校验和/模型/会话 ID），report 节点 Manifest、数据源版本、提示摘要归 Backlog/Phase 2 |
| 22 | 新增 `tsconfig.scripts.json`；`tsconfig.json` references；`package.json` | scripts 目录纳入类型检查（对齐 tsconfig.node.json 严格度，lib 补 DOM 因脚本传递引用 `src/utils/export-report.ts`；include 补 `src/types/plotly.d.ts` 保证 ambient 模块声明生效）；新增 `"typecheck": "tsc -b"` 与聚合 `"verify"`（四条串联） |

## 执行命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b`（含新 scripts 工程） | 0 | 通过。首轮暴露 2 个既有潜在类型错误并修复：`verify-permission-audit.ts:229` 对 `find()` 结果再调类型守卫（undefined 不可赋）、`export-report.ts:1342` plotly ambient 声明未进 scripts 工程导致落到包内 `Data[]` 类型 |
| `npm run build` | 0 | tsc -b + vite build 通过 |
| `npm run lint` | 0 | eslint 无 error |
| `npm run verify`（聚合） | 0 | manifest **55/55**（52→55：+回填 2、+firstExecutedAt 1）；rerun **67/67**（62→67：+形状校验 2、+firstExecutedAt 3）；audit **96/96**（86→96：+迟到决策 3、+垃圾 ID 1、+索引清空 2、+shouldAskPermission 6，其中 2 项为既有断言语义更新）；export **124/124**（116→124：+审计命令转义 1、+属性引号 1、+徽标 2、+截断 1、+空 ids 2、+basename 1、+默认不写盘 1） |
| `npm run verify:rerun -- --real` | 0 | 真实 govio-cli + sales 链路 **79/79**（74→79） |
| `npm run verify:export -- --write` | 0 | 受跟踪样例一次性重新生成（fixture 变更：审计来源改绝对路径测 basename、deny 命令含 XSS 哨兵） |
| 默认 `npm run verify:export` 后 md5 比对 | — | `sample-export.html` 未被改写（第 2 项生效证明） |
| `git status --porcelain` | — | 仅本次修复的预期变更，无 verify 残留脏文件 |

## 有意的行为/断言语义变更（清单第 9 项的自然结果）

- `resolve()` 迟到决策从「静默丢弃」改为「补记一条未生效留痕」：`verify-permission-audit.ts` 既有断言「已清理的挂起请求不会被二次记账」相应更新为「已生效决策不被改写；迟到决策补记『未生效』留痕」（同 decisionId 恰好 2 条：source=abort/timeout + source=user）。
- `/api/permission-audit` 缺省全量返回能力被移除（400）。唯一消费者 `fetchAuditAppendix` 总是带 `decisionIds`，无兼容问题。

## 未完成 / 遗留（如实）

1. **浏览器/Electron 人工冒烟仍未执行**（本环境无图形界面）：导出下载、复跑三态、PermissionCard、Accept All 落审计。步骤见各任务 `verification.md`，仍是合并前待办。
2. 迟到决策记录的 `command` 为空串（挂起表已清，无法回取原命令）；`decisionId` 可回查同 ID 的 request/timeout 条目还原上下文。
3. 徽标在「有 decisionId 但审计条目拿不到」时为中性「已过确认门」（清单要求的措辞），不猜测人工/自动。
4. `-oxxx`（短选项紧跟值）仍不触发确认门——按清单只在 specs/10 标注为已知缺口并加断言钉住现状，未改正则（改前瞻需另评估误判面，归 X1/后续）。
5. reviewer P2 中未列入本清单的项（如 export-report.ts 拆分、NODE_COLORS 四处并行真源、pendingPermission 前端单槽）未动，维持 deferred。
