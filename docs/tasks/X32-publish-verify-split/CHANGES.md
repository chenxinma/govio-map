# X32 CHANGES

分支：`chenxinma/x32-publish-verify-split`（base: main @ `cfbd344`）

| 文件 | 变更 |
|---|---|
| `.github/workflows/publish.yml` | 删除 `Post-publish self check`（时序错 + 命令错）；头部说明发布/验证分离；artifact 上传 `if: always()`；summary 指向 verify-release.yml |
| `.github/workflows/verify-release.yml` | 新增：独立的发布后验证（等 registry 生效 → 元信息 → tarball 内容 → provenance → 安装 + 启动冒烟） |
| `.github/workflows/scripts/pack-rules.mjs` | 新增：发布口径规则单一事实源 + `evaluatePack()` |
| `.github/workflows/scripts/verify-pack-contents.mjs` | 改用 `pack-rules.mjs`（发布前口径，行为不变） |
| `.github/workflows/scripts/verify-published-package.mjs` | 新增：已上线 tarball 条目断言（发布后口径） |
| `.github/workflows/scripts/verify-published-metadata.mjs` | 新增：registry 元信息完整性断言 |
| `.github/workflows/scripts/verify-provenance.mjs` | 新增：provenance attestations 断言 |
| `docs/release-process.md` | §4「只发布」+ 新增 §5「发布后验证」，后续章节重编号，写清 validating 实测 5.5 分钟与分开的失败面 |
| `docs/tasks/X32-publish-verify-split/{design,CHANGES,verification}.md` | 三件套 |
