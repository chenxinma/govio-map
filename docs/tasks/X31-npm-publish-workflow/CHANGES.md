# X31 CHANGES

分支：`chenxinma/x31-npm-publish`（base: main）

| 文件 | 变更 |
|---|---|
| `.github/workflows/publish.yml` | 新增手动发布 workflow（唯一触发 `workflow_dispatch`）：版本一致性/未占用闸门、从 govio release 预置 `.agents/skills`、build、pack 断言、artifact + sha256、token/OIDC 两种认证分支 + dry-run 分支、发布后自检、step summary |
| `.github/workflows/scripts/verify-pack-contents.mjs` | 新增产物清单断言脚本（必需文件 / 六个技能目录 / 禁止前缀与模式 / 文件数与体积上限） |
| `docs/release-process.md` | 新增发版流程文档（一次性认证配置与撤销、dry-run、真实发布、Release 人工步骤、包内容口径、失败与回滚、与 CI 门禁关系） |
| `docs/tasks/X31-npm-publish-workflow/{design,CHANGES,verification}.md` | 任务三件套 |
