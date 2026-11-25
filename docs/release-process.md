# 发版流程（npmjs.com）

> 适用：`govio-map` 发布到公共 npm。CI 门禁本身见 `docs/specs/`、`.github/workflows/ci.yml`（与发版无关，互不影响）。
> 设计取舍见 `docs/tasks/X31-npm-publish-workflow/design.md`。

## 0. 为什么是「手动触发」

发版是**人的裁决动作**，不是代码事件的副产品：

- npm 的 `version` 一经发布不可修改；`npm unpublish` 会让该版本号**永久作废**（不能再发同号）。
- 自动触发（`push: tags: v*` / `release: published`）会在用户尚未准备好时把版本号烧掉。
- 因此 `publish.yml` **只有一个触发器** `workflow_dispatch`；推 tag、发 Release、定时任务都不会发布。

## 1. 前置：一次性配置（二选一）

**方式 A（推荐）Trusted Publishing（OIDC，无需长期 token）**

1. npmjs.com → `govio-map` 包 → Settings → Trusted publishing → 添加 GitHub Actions：
   - Owner/Repo：`chenxinma/govio-map`
   - Workflow filename：`publish.yml`（**改文件名必须回来重配**）
   - Environment：留空
2. 仓库侧无需 secret。workflow 已声明 `permissions: id-token: write`，`npm publish --provenance`
   会自动用 OIDC 换取短期凭证，并给包挂上 provenance（可在 npmjs 包页看到来源与构建记录）。

**方式 B（兜底）长期 token**

1. npmjs → Access Tokens → 生成 **Granular** token，权限最小化为「仅 `govio-map` 包 + Read and write」。
2. 仓库 Settings → Secrets → Actions → 新建 `NPM_TOKEN`。
3. workflow 检测到该 secret 时优先用 token（步骤名带 `(token mode)`）。

**撤销 / 轮换**：Trusted Publishing 在 npmjs 包设置里删除 binding 即刻失效；
token 方式在 npmjs 撤销 token 并同步更新 `NPM_TOKEN` secret（撤销后重跑发布会 401，不会静默成功）。

## 2. 准备版本（走 PR，不直推）

1. 升 `package.json` 的 `version`（`package-lock.json` 根条目同步）；
2. 写 `docs/release-v<version>.md`（沿用 `docs/release-v0.7.2.md` 格式：变更摘要 / 安装说明 / 已知取舍）；
3. 开 PR → CI `build + lint + verify` 绿 → 用户合并。

## 3. 演练（dry-run，必做）

Actions → `Publish to npm (manual)` → Run workflow：

| 输入 | 值 |
|---|---|
| `version` | 你要发布的版本号，必须与 `package.json` 一致（`0.7.3`） |
| `dry_run` | **true** |
| `skills_version` | 可选；留空 = 取 `chenxinma/govio` 最新 release 的 `govio-skills.zip` |

或命令行：

```bash
gh workflow run publish.yml -f version=0.7.3 -f dry_run=true
gh run watch
```

dry-run 会真实执行：`npm ci` → 版本一致性/未被占用校验 → 从 govio release 预置 `.agents/skills`
→ `npm run build` → `npm pack --dry-run` + 产物断言（`.github/workflows/scripts/verify-pack-contents.mjs`）
→ `npm publish --dry-run`。**不会**动 registry。

## 4. 真实发布

同一 workflow，`dry_run=false`：

```bash
gh workflow run publish.yml -f version=0.7.3 -f dry_run=false
gh run watch
```

发布成功后 workflow 会自检（缺一项即判定失败）：

- `npm view govio-map@<version>` 的 `license` / `description` / `author` / `repository` / `homepage` /
  `keywords` / `dist.integrity` 全部非空；
- 装到临时 prefix 后 `govio-map --version` 可执行。

同时上传 run artifact `npm-tgz-<version>`（含 `.tgz` 与 `.tgz.sha256`）。

## 5. GitHub Release（人工，不自动建）

workflow **不建** Release。需要时人工执行：

```bash
gh release create v0.7.3 <下载的 govio-map-0.7.3.tgz> \
  --title "Govio Map v0.7.3 — <一句话主题>" \
  --notes-file docs/release-v0.7.3.md
```

惯例：tag 名 `v<version>`；附件为 npm tgz（自 v0.7.2 起由 Windows 安装包改为 tgz）。

## 6. 包内容口径（脚本硬断言）

`.github/workflows/scripts/verify-pack-contents.mjs` 在每次发布前校验：

- **必须有**：`package.json`、`LICENSE`、`README.md`、`dist/index.html`、`dist-server/cli.mjs`、
  `.pi/APPEND_SYSTEM.md`、`.agents/skills/govio/SKILL.md`，以及六个 govio 技能目录各一份 `SKILL.md`；
- **绝不能有**：`.agents/skills/govio/assets/**`（按环境生成的图谱快照）、`node_modules/`、`src/`、
  `server/`、`tests/`、`scripts/`、`.env*`、`.govio/`、`.claude/`、`.codex/`；
- 文件数 ≤ 400、体积 ≤ 20 MB。

为什么 skills 要单独预置：`.gitignore:27` 的裸 `skills` 模式把 `.agents/skills/**` 全忽略，
CI fresh checkout 里没有它；workflow 从 `https://github.com/chenxinma/govio/releases/download/v<tag>/govio-skills.zip`
（与 `server/govio-installer.ts` 同源）解压到 `.agents/skills/`，并删除 `govio/assets`。

> 与本地 `npm pack` 的差异：CI 产物只含 govio 六个技能（zip 内容），不含本机 `.agents/skills/` 里
> 额外的 `moli-*` 技能；本地 `npm pack` 还会多出这些非 govio 技能，属预期差异。

## 7. 失败与回滚

| 场景 | 处理 |
|---|---|
| 版本已在 registry | workflow 在 publish 前就失败（不改 registry）。**不要** `npm unpublish`，改用新版本号 |
| 元信息/自检失败 | 包已发布但元信息不达标：修 `package.json` → 升新版本重发（已发布版本不可改） |
| publish 报 `E403 ... OIDC permission denied for this action` | npmjs 侧没有为本包配置 Trusted Publishing binding（或 binding 的 repo/workflow 文件名与实际不符）。注意此时 provenance 已签名成功，只是授权被拒、registry 未产生任何版本。按 §1 方式 A 补 binding 后重跑即可 |
| provenance 缺失 | 检查是否走了 token 方式（token 也可带 provenance，但需 `--provenance` 与 public repo）；OIDC 方式需 binding 正确 |
| 想撤回 | `npm deprecate govio-map@<version> "原因"`（推荐，保留可安装性）；`unpublish` 仅在极端场景且接受版本号永久作废 |
| skills 预置失败 | 说明 `chenxinma/govio` 的 release 没有 `govio-skills.zip` 或 tag 写错；用 `skills_version` 显式指定可用 tag |

## 8. 与 CI 门禁的关系

- `publish.yml` 与 `ci.yml` **完全独立**：不改 job 名 `build + lint + verify`（ruleset 27209918 的 required check），
  不共用 concurrency group（发布用 `publish-npm-<ref>`，且 `cancel-in-progress: false`，宁可排队不打断真实发布）；
- publish workflow **不是** required check，失败也不阻塞任何 PR。
