# X29 npm 包元信息补齐与 0.7.3 发版

状态：in_progress（元信息已随 PR #51 落地；本分支只做版本号 + release notes；发布动作待用户触发）

## 背景

2026-11-23 首次把 `govio-map` 正式发到 npm（0.7.2 占 latest）后发现 registry 上 License 等元信息全空：
`package.json` 当时只有 `name`/`version`，没有 `license`/`description`/`author`/`repository`/`homepage`/`keywords`，
仓库也没有 `LICENSE` 文件，npm 只好拿 README 首行当 description（结果是「**简体中文** | [English](README.en.md)」）。

npm 的 `version` 元数据**发布后不可变**，且 `unpublish` 会让该版本号永久作废 ⇒ 元信息修正只能随**下一次发版**
才在 registry 生效。这就是 0.7.3 存在的唯一理由（功能上 0.7.3 = 0.7.2 + 本轮已合并改动）。

## 已完成（PR #51，merge 4b3d4ac）

`package.json` 补 `description` / `keywords` / `homepage` / `repository` / `bugs` / `author` / `license=MIT`，
新增 `LICENSE`（MIT，版权人 chenxin.ma），`package-lock.json` 根条目同步 `license`（依赖树零变动）。
`npm pack` 复核：57 文件 / 2.5 MB，含 `LICENSE`，仍排除 `.agents/skills/govio/assets`。

## 本分支（0.7.3 升版）

| 改动 | 说明 |
|---|---|
| `package.json` / `package-lock.json` | `version` 0.7.2 → 0.7.3（lockfile 只动顶层两处，依赖树不变） |
| `docs/release-v0.7.3.md` | 覆盖 v0.7.2 之后合并的全部 PR：T3.5/T3.6/T3.7、X25、X26、#50（模型/思考档）、#51（元信息），以及本版新增的 X30/X27/X31；含验证基线、已知取舍、安装说明 |

**发布顺序（硬约束）**：本分支基于 main 但 `release-v0.7.3.md` 已把 X30/X27/X31 记为「本版包含」，
因此 **PR #52（X30）/ #53（X27）/ #54（X31）必须先合并**，再合并本分支，最后才手动触发发布 workflow。
顺序反了会导致「release notes 声称包含但实际没进包」。

## 发布步骤（用户裁决后执行，见 `docs/release-process.md`）

1. 前置（一次性）：npmjs 侧为 `govio-map` 添加 Trusted Publishing binding（repo `chenxinma/govio-map`，
   workflow 文件名 `publish.yml`）；或用 `NPM_TOKEN` secret 兜底。
2. 演练：`gh workflow run publish.yml -f version=0.7.3 -f dry_run=true`，确认 skills 预置、pack 断言、dry-run publish 全绿。
3. 真实发布：`gh workflow run publish.yml -f version=0.7.3 -f dry_run=false`；自检步骤会用 `npm view` 复核
   `license`/`description`/`author`/`repository`/`homepage`/`keywords`/`dist.integrity`，并装到临时 prefix 验证 bin 可执行。
4. 人工建 Release：`gh release create v0.7.3 <tgz 附件> --notes-file docs/release-v0.7.3.md`（workflow 不自动建）。
5. 占位版本 `0.0.0-stage`（不在 latest）是否 `npm deprecate` / `unpublish` 仍待用户裁决——`unpublish` 会让该号永久作废，
   建议只在明确不再需要时执行。

## 遗留问题

1. **发布动作本身未在本会话执行**：`npm publish` 需要 npmjs 侧认证配置（OIDC binding 或 token），且用户曾要求
   「发布时机由用户裁决」；主会话不得在无认证/无 OTP 情况下擅自重试。
2. 0.7.3 之后能否把「元信息自检」固化为发布前置断言，取决于 X31 workflow 的自检步骤是否覆盖（已覆盖 7 个字段）。
3. `0.0.0-stage` 清理待裁决（见上）。
4. 若用户希望 0.7.3 与 0.7.2 一样由本地 OTP 手工发布，则回退路径为：本地 `npm publish --registry=https://registry.npmjs.org`
   （全局 registry 是 npmmirror 只读镜像，必须显式覆盖），发布后仍需按上面第 3/4 步自检与建 Release。
