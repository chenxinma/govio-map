# Review Round 2 收尾修复对照表

分支 `feature/phase1-trusted-analysis`，基于 `ec64978`。范围严格限于 R2 复审（r2-blast / r2-tests）产出的 9 项清单，无其他重构。

## 逐项对照

| # | 清单项 | 文件:位置 | 说明 |
|---|--------|-----------|------|
| 1 | 迟到决策补记幂等守卫 | `server/permission-manager.ts:83-84`（`lateAudited` 集合）、`:113`（clearAll 一并清空）、`:281-289`（auditLateDecision 去重 + 上限 200 插入序淘汰） | 同一 decisionId 重复迟到 resolve 只补记一次；有界防长会话增长 |
| 2 | 迟到补记 reason 成因无关措辞 | `server/permission-manager.ts:296`；`scripts/verify-permission-audit.ts:176`、`:207` 断言同步 | 新文案「决策已失效（请求此前已被超时/中止/会话重置拒绝），未生效」；新增断言「连续两次迟到 resolve 后同 decisionId 仍恰 2 条」（`:180-184`） |
| 3 | firstExecutedAt 渲染消费 | `src/utils/export-report.ts:615-619`（卡片「首次交付」行）、`:903`（附录 A `firstExecutedAt` 字段行）、`:926-927`（intro 措辞更新） | 仅 firstExecutedAt 存在且 ≠ executedAt 时渲染；断言见 `scripts/verify-export-report.ts:560-565`（正例 gov-2/gov-1 两卡 + 负例 memory/channel 不渲染 + 渲染值钉住） |
| 4 | 审计 ID 上限 500→200 | `server/parquet-api.ts:17-21`（含 16KiB 请求行推导注释）、`src/utils/export-report.ts:129`、`:1029`（截断文案 200）、`docs/specs/06-backend.md:231/235/242`、`scripts/verify-export-report.ts:695/698/701`（600-ID fixture → 300-ID） | 200 × ~42B ≈ 8.4KB，安全落在 Node 默认头限制内，truncated 契约在真实 HTTP 上可达 |
| 5 | rerunBlockReason 放宽 dfName | `server/dataframe-rerun.ts:62-85`（删字符集分支，保留非空字符串校验；doc 注释更新）；`docs/specs/06-backend.md:276`；`scripts/verify-rerun-drift.ts:120-125`（`sales-2024`/`df.v2` 正例 + 非字符串/空串反例） | dfName 不进 CLI 参数（tempDfNameFor 归一化 + execFile 数组参数），拒绝合法存量名只造成无法操作的复跑失败 |
| 6 | 恒真断言替换 | `scripts/verify-rerun-drift.ts:107-110` | 改为 argv 与 `buildRerunLoadArgs` 契约全等：`JSON.stringify(loadArgs) === JSON.stringify(["observe","load","--name",tmp,"--datasource","sales","--sql",SQL])` |
| 7 | --write 分支清理临时目录 | `scripts/verify-export-report.ts:730-732` | `rmSync(tmpDir)` 移到 if/else 之后无条件执行 |
| 8 | 文档计数漂移 | `docs/tasks/T1.1-analysis-manifest/CHANGES.md:3`（18→19，7 新增/12 修改）、`:12`（52 项加"交付时/R1 后 55"注解）；`docs/tasks/T1.2-dataframe-rerun-drift/CHANGES.md:14`（62/74 → 加"R1 后 67/79"注解）；`docs/specs/06-backend.md:342`（86→96 项，加注 R1/R2 后 97）；`docs/tasks/T1.2-dataframe-rerun-drift/design.md:146`（改为"结构性保证 + argv 契约全等断言"） | 计数按枚举逐条相加核对 |
| 9 | "七件事/七节"→八 + 复现配方 | `scripts/verify-export-report.ts:15-24`（文档块八件事，补第 8 节描述）；`docs/tasks/T1.4-canvas-export/CHANGES.md:21`（七节→八节）；`docs/tasks/T1.4-canvas-export/verification.md:100-116`（确定性配方改为连续两次 `--write` 比对，注明默认运行不落盘） | 受跟踪样例 `sample-export.html` 已用 `--write` 按新代码重新生成（含「首次交付」行与 200 上限文案） |

## 新断言的非恒真自查（每项给出"实现回退则失败"的理由）

1. **补记幂等**（verify-permission-audit `:180-184`）：若删掉 `lateAudited.has` 守卫，第二次迟到 resolve 会追加第 3 条记录，`length === 2` 失败。
2. **迟到 reason 新措辞**（`:176`、`:207`）：若回退为「决策晚于超时」，字符串全等断言失败；abort 场景断言确保措辞与成因解耦。
3. **首次交付渲染**（verify-export-report `:560-565`）：若实现改为无条件渲染，memory 卡（firstExecutedAt == executedAt）会多出 1 行 → `<dt>首次交付</dt>` 计数 3 ≠ 2 失败；若整行删除 → 计数 0 失败；若渲染错时间戳 → `includes("<dt>首次交付</dt><dd>2026-10-31 06:00:00</dd>")` 失败。注意 gov-1（sqlQuery 卡）继承月度 Manifest 的 firstExecutedAt，同样渲染，故期望为 2 行而非 1（首版断言误设为 1，已按实际渲染路径修正——manifestBlock 被 sqlQueryBody 与 dataFrameBody 共用）。
4. **附录 A firstExecutedAt 字段行**（`:566-567`）：附录 kv 同时含月度的独立值与 memory 的同值 ISO 串；删掉字段行则失败。
5. **argv 契约全等**（verify-rerun-drift `:107-110`）：实现增加/调换任何参数（如把 SQL 拆成多参、追加 flag）都会破坏 JSON 全等。
6. **dfName 放宽正反例**（`:120-125`）：若恢复字符集分支，`sales-2024`/`df.v2` 正例失败；若删掉全部形状校验，非字符串/空串反例失败。
7. **300-ID 截断 fixture**（verify-export-report `:695-701`）：断言文案「仅带出前 200 个」；若前端文案回退 500 则失败。

## 命令与退出码

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run build` | 0 | ✓ built in 2.21s |
| `npm run lint` | 0 | 无输出（0 error） |
| `npm run verify`（聚合四条） | 0 | manifest 55/55、rerun 67/67、audit **97/97**（96→97，新增幂等断言）、export **126/126**（124→126，新增首次交付 2 项） |
| `npm run verify:rerun -- --real` | 0 | 79/79（真实 govio-cli + sales） |
| `npm run verify:export -- --write` | 0 | 重新生成受跟踪样例（第 3/4 项改动了渲染输出，样例必须同步） |
| verify 全量跑完后 `git status --porcelain` | — | 仅剩本次修复的预期改动（含 --write 再生的 sample-export.html），无验证脚本残留污染 |

## 意外情况

- 「首次交付」首版断言按 1 次渲染设置，实测 3 处命中：manifestBlock 同时被 sqlQuery 卡（gov-1 继承月度 Manifest）复用 + 附录 intro 提及；且 `2026-10-31 06:00:00` 与源表卡「创建于」时间撞值，不能用作判别子。已改为 `<dt>首次交付</dt>` 精确行模式计数（2 行 + intro 1 次提及）。
- 受跟踪样例 `sample-export.html` 因第 3/4/9 项改变了渲染输出而用 `--write` 重新生成——这是清单第 9 项配方说明的必然结果，非额外改动。

## 未完成项

- 无。清单 9 项全部落地。
- 既有遗留（不在本清单）：浏览器/Electron 人工冒烟仍未执行（无图形环境）；CORS/Origin/session_open 属 X1；export-report.ts 拆分延后。
