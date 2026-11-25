# X31 GitHub Actions 手动发布 npmjs.com

状态：done（workflow + 文档已交付；dry-run 实跑与真实发布待 PR 合并后验证）

## 背景与约束（已实证）

| 约束 | 证据 |
|---|---|
| 仓库原先只有 CI 门禁，没有发布链 | `.github/workflows/` 只有 `ci.yml`；npm 发布一直是人工本地执行 |
| 人工发布需要 OTP（账号开了 2FA） | X29 note：`npm publish` 需用户提供验证码 |
| CI fresh checkout 里**没有** `.agents/skills` | `.gitignore:27` 裸 `skills` 模式命中 `.agents/skills/**`，`git ls-files .agents` = 0 |
| skills 有可复现来源 | `server/govio-installer.ts:169` 用 `github.com/chenxinma/govio/releases/download/v<ver>/govio-skills.zip`；实测 v0.7.2 该资产存在（22 个文件，前缀 `skills/`） |
| 仓库 PUBLIC | `gh repo view --json isPrivate` = false ⇒ provenance / Trusted Publishing 可用 |
| CI Node 24 / 本地 npm 11.18 | npm ≥ 11.5.1 支持 Trusted Publishing（OIDC） |
| 无既有 secret | `gh secret list` 无输出、`gh api .../environments` total_count=0 |
| 用户要求**不自动运行** | 2026-11-23 追加约束：发布是人的裁决，自动跑会烧掉不可变版本号 |

## 裁决（design decisions）

| 决策 | 取值 | 理由 |
|---|---|---|
| 触发器 | **仅 `workflow_dispatch`**（输入 `version` / `dry_run`（默认 true）/ `skills_version`） | 用户约束；显式禁 `push: tags`、`release: published`、`schedule` |
| 认证 | 优先 **Trusted Publishing（OIDC）**；`secrets.NPM_TOKEN` 存在时优先 token | OIDC 免长期凭证、兼容 2FA、自带 provenance；token 作兜底（仓库暂无 secret） |
| provenance | 开启 `--provenance`（public repo 满足前提） | 给包挂上可验证的构建来源 |
| `.agents/skills` 预置 | 从 govio release 的 `govio-skills.zip` 解压到 `.agents/skills/`，删 `govio/assets` | 与 `govio-installer.ts` 同源，避免把 skills 入库；assets 是按环境生成的快照 |
| skills 版本 | 输入 `skills_version` 可覆盖；留空取 `chenxinma/govio` 最新 release tag | 默认省事，发版记录里由 run summary 留痕；需要确定性时显式指定 |
| `prepublishOnly` 双跑 | 发布时 `--ignore-scripts` | workflow 已显式 `npm run build`；避免二次构建拖长 timeout |
| tarball 内容 | 新脚本 `.github/workflows/scripts/verify-pack-contents.mjs` 硬断言 | 「包缺 skills」不会让 npm 报错，只会静默产出坏包 ⇒ 必须断言 |
| GitHub Release | **不自动创建**，只上传 `npm-tgz-<version>` artifact（含 `.sha256`） | 用户要求人工裁决；与 v0.7.2 惯例一致 |
| concurrency | `publish-npm-<ref>`，`cancel-in-progress: false` | 不与 ci 抢组；真实发布宁可排队，不能被后到的推送取消 |

## 实现

| 文件 | 内容 |
|---|---|
| `.github/workflows/publish.yml` | 手动发布链：setup-node 24（`registry-url`）→ lockfile registry 覆盖 → `npm ci` → 版本一致性闸门 → 版本未被占用闸门 → skills 预置 + 断言 → `npm run build` → `npm pack --dry-run` + 产物断言 → 打包 artifact + `sha256sum` → 认证方式判定 → publish（token/OIDC 两个分支）/ dry-run 分支 → 发布后自检（元信息 + 临时 prefix 安装 + `--version`）→ artifact 上传 → step summary |
| `.github/workflows/scripts/verify-pack-contents.mjs` | 产物清单断言：必需文件 / 六个技能目录 / 禁止前缀（assets、node_modules、src、server、tests、scripts）/ 禁止模式（`.env`、`.govio/`、`.claude/`、`.codex/`、`.ssh/`）/ 文件数与体积上限 |
| `docs/release-process.md` | 一次性配置（OIDC binding 或 `NPM_TOKEN`，含撤销/轮换）、dry-run 流程、真实发布、Release 人工步骤、包内容口径、失败与回滚（禁常规 unpublish）、与 CI 门禁的关系 |

action 一律 pin commit SHA（沿 X16 §2）：`actions/checkout` `3d3c42e…`（v7.0.1）、`actions/setup-node` `949feb2…`（v7.1.0）、
`actions/upload-artifact` `ea165f8…`（v4.6.2，已用 GitHub API 核对 tag → commit 一致）。

## 本地验证（脚本层）

| 检查 | 结果 |
|---|---|
| `npm run build` 后 `npm pack --dry-run --json \| node .github/workflows/scripts/verify-pack-contents.mjs` | ✓ 通过（57 文件 / 2422 KB，技能目录 9 个含 moli-*） |
| 把 `.agents` 临时移走后重跑同一断言 | ✗ 按预期失败：7 处不合规（缺 `govio/SKILL.md` + 六个技能目录）→ 证明闸门能拦住「缺 skills 的坏包」 |
| YAML 解析 | `yaml` 解析通过；`on` 只有 `workflow_dispatch`；`jobs` = `publish` |
| 与 ci.yml 隔离 | job 名未变、concurrency group 不同、无 required check 变更 |

## 遗留问题

1. **dry-run 实跑与真实发布需在 PR 合并后执行**（`workflow_dispatch` 需要 workflow 文件在默认分支注册后才稳定可跑）：
   合并后先 `dry_run=true` 拿到 run 链接，再 `dry_run=false` 发 0.7.3。
2. **Trusted Publishing binding 需用户在 npmjs 页面手工添加**（repo + workflow 文件名 `publish.yml`）；未配置且无
   `NPM_TOKEN` 时 publish 步骤会以未认证失败（不会静默成功）。改 workflow 文件名必须回来重配。
3. provenance 依赖 public repo（已满足）；若将来转私有，`--provenance` 与 Trusted Publishing 都需重新评估。
4. 未做「发布后自动对比本地 `npm pack` 与 registry tarball 的文件集」——目前靠 workflow 内的 pack 断言 +
   `npm view dist.integrity` 自检；如需逐文件比对可后续加一条（对比 `npm pack` 与 `npm view dist.tarball` 下载解包）。
