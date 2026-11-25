# X31 verification

分支 `chenxinma/x31-npm-publish`（base main `d3e7f62`），2026-11-25。

## 本地门槛

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run lint` | exit 0（仅新增 `.mjs` 脚本，eslint 配置覆盖 `.github/workflows/scripts/`，无告警） |
| `npm run verify` | exit 0，11 段全绿；脚本断言 671、vitest 33/487、UI 10/90（本任务未改动被 verify 覆盖的代码与用例 ⇒ 基线不变） |
| `git status --porcelain`（verify 后） | 仅本任务改动 |

## 产物清单断言（脚本正/反路径）

```bash
npm run build
npm pack --dry-run --json | node .github/workflows/scripts/verify-pack-contents.mjs
```

正路径输出：

```
— verify-pack-contents —
  · 包内技能目录：govio, govio-eda, govio-meta, govio-observe, govio-query, govio-reconcile, moli-cdp-server, moli-webfetch, moli-websearch
  · 包名 govio-map-0.7.2.tgz，57 个文件，2422 KB
  ✓ 产物清单符合发布口径
```

反路径（临时 `mv .agents`，跑完立即恢复）：

```
  ✗ 7 处不合规：
    - 缺少必需文件：.agents/skills/govio/SKILL.md
    - 包内缺少技能目录：.agents/skills/govio/SKILL.md
    ... （其余五个 govio-* 技能）
```

## 触发器与隔离

```bash
node -e "const y=require('yaml');const d=y.parse(require('fs').readFileSync('.github/workflows/publish.yml','utf8'));console.log(Object.keys(d.on), Object.keys(d.jobs))"
# => [ 'workflow_dispatch' ] [ 'publish' ]
```

- `publish.yml` 未修改 `ci.yml` 的 job 名 `build + lint + verify`（ruleset 27209918 的 required check）；
- concurrency group `publish-npm-<ref>`，`cancel-in-progress: false`；
- action 全部 pin SHA，`upload-artifact@v4.6.2` 的 SHA 已与 GitHub API 核对一致。

## 待合并后执行（CI 侧证据）

```bash
# 1) dry-run
gh workflow run publish.yml --ref main -f version=<ver> -f dry_run=true
gh run watch
# 2) 真实发布（用户裁决后）
gh workflow run publish.yml --ref main -f version=<ver> -f dry_run=false
```

需在 run 页面确认：skills 预置步骤输出的技能目录列表、pack 断言通过、`dry_run=true` 时无 publish 步骤执行、
`dry_run=false` 时自检步骤（元信息 + 临时 prefix 安装 + `--version`）通过，以及 provenance 在 npmjs 包页可见（OIDC 方式）。
