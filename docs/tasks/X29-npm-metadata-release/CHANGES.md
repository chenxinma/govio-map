# X29 CHANGES

分支：`chenxinma/x29-release-0.7.3`（base: main，**须在 #52/#53/#54 之后合并**）

| 文件 | 变更 |
|---|---|
| `package.json` | `version` 0.7.2 → 0.7.3 |
| `package-lock.json` | 顶层与 `packages[""]` 的 `version` 同步 0.7.3（仅 2 处，依赖树零变动） |
| `docs/release-v0.7.3.md` | v0.7.3 release notes：Phase 3 三项（T3.5/T3.6/T3.7）+ X25/X26/#50/#51 + 本版新增 X30/X27/X31，含验证基线、已知取舍、安装说明、包内容口径 |
| `docs/tasks/X29-npm-metadata-release/{design,CHANGES,verification}.md` | 任务三件套（含发布顺序硬约束与待执行的发布步骤） |

> 元信息与 `LICENSE` 已随 PR #51（merge 4b3d4ac）落地，本分支不重复改动。
