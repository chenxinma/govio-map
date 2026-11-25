# X29 verification

分支 `chenxinma/x29-release-0.7.3`（base main `d3e7f62`），2026-11-25。

## 门槛

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0（banner 显示 `govio-map@0.7.3`，确认版本号已生效） |
| `npm run lint` | exit 0 |
| `npm run verify` | exit 0，11 段全绿：脚本断言 671（92/71/119/148/39/54/77/13 + 58），vitest 33·476 + UI 10·87 与本分支基线一致（纯版本号与文档改动，零回归） |
| `git status --porcelain`（verify 后） | 仅 `package.json` / `package-lock.json` / 新增 release 文档 |

## 版本号一致性

```bash
node -p "require('./package.json').version"          # 0.7.3
node -p "require('./package-lock.json').version"     # 0.7.3
node -p "require('./package-lock.json').packages[''].version"  # 0.7.3
```

## 待执行（发布动作，需用户触发）

```bash
gh workflow run publish.yml -f version=0.7.3 -f dry_run=true      # 演练
gh workflow run publish.yml -f version=0.7.3 -f dry_run=false     # 真实发布（自检 7 个元信息字段 + bin 可执行）
gh release create v0.7.3 <tgz> --title "Govio Map v0.7.3 — 画布能交接，包能被核对" --notes-file docs/release-v0.7.3.md
```

需在 run 页面确认：skills 预置目录列表、pack 断言通过、`npm view govio-map@0.7.3` 的 `license=MIT` 等字段非空、
provenance 可见（OIDC）、`npm i -g` 后 `govio-map --version` 可执行。

## 已知约束

- **合并顺序**：必须先合并 #52（X30）/ #53（X27）/ #54（X31），再合并本分支，否则 release notes 会声称包含实际未进包的改动。
- 发布本身依赖 npmjs 侧认证（Trusted Publishing binding 或 `NPM_TOKEN`），主会话不在无认证状态下擅自发布。
