# X32 verification

分支 `chenxinma/x32-publish-verify-split`（base main `cfbd344`），2026-11-25。

## 门槛

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run lint` | exit 0（新增的 4 个 `.mjs` 脚本在 eslint 覆盖内，无告警） |
| `npm run verify` | exit 0，11 段全绿：脚本断言 671、vitest 34·495、UI 11·98（本任务只改 `.github/` 与文档，零回归） |
| `git status --porcelain`（verify 后） | 仅本任务改动 |

## 断言脚本对「已上线的 0.7.3」实跑（本地，直连 registry.npmjs.org）

```bash
npm view govio-map@0.7.3 --json --registry=https://registry.npmjs.org > meta.json
node .github/workflows/scripts/verify-published-metadata.mjs meta.json
# → 7 字段齐全（license=MIT / description / author / repository / homepage / keywords / dist.integrity）✓

curl -sSL --fail -o pkg.tgz https://registry.npmjs.org/govio-map/-/govio-map-0.7.3.tgz
tar -tzf pkg.tgz | sed 's|^package/||' | node .github/workflows/scripts/verify-published-package.mjs
# → 38 个文件；技能目录 govio, govio-eda, govio-meta, govio-observe, govio-query, govio-reconcile ✓

curl -sS --fail "https://registry.npmjs.org/-/npm/v1/attestations/govio-map@0.7.3" -o att.json
node .github/workflows/scripts/verify-provenance.mjs att.json
# → publish/v0.1 + slsa.dev/provenance/v1 ✓

npm pack --dry-run --json | node .github/workflows/scripts/verify-pack-contents.mjs
# → 57 文件（含本机额外 moli-* 技能）；规则经 pack-rules.mjs 复用后行为不变 ✓
```

## 启动冒烟（本机 Windows，复现 verify-release.yml 第 5 步的逻辑）

```bash
npm i -g --prefix /tmp/publisherify/prefix govio-map@0.7.3 --registry=https://registry.npmjs.org
cd /tmp/bootprobe && ANTHROPIC_API_KEY=test-only-not-a-real-key timeout 45 \
  node /tmp/publisherify/prefix/node_modules/govio-map/dist-server/cli.mjs
# → ">>> Server agent ready. <<<" + "[serve] Govio Map ready at http://localhost:5173"，timeout 退出 124（预期，服务常驻）
```

反证：`govio-map --version` 不存在——该 CLI 直接启动服务并阻塞，正是旧自检的第二个缺陷。

## workflow 静态校验

```bash
node -e "const y=require('yaml');const fs=require('fs');for(const f of ['.github/workflows/publish.yml','.github/workflows/verify-release.yml']){const d=y.parse(fs.readFileSync(f,'utf8'));console.log(f, Object.keys(d.on), Object.keys(d.jobs));}"
# .github/workflows/publish.yml            [ 'workflow_dispatch' ] [ 'publish' ]
# .github/workflows/verify-release.yml     [ 'workflow_dispatch' ] [ 'verify' ]
```

- `publish.yml` 不再含 `Post-publish self check`；artifact 上传 `if: always()`；
- 两条 workflow 均只有一个触发器 `workflow_dispatch`（未新增任何自动触发）；
- `ci.yml` 未改动（required check 名 `build + lint + verify` 与 behaviors 不变）。

## 待合并后（CI 侧证据）

```bash
gh workflow run verify-release.yml -f version=0.7.3
gh run watch
```

需确认：等待步骤在数秒内返回 200（0.7.3 已 live）、元信息 7 项、tarball 38 文件口径、provenance 2 条、
安装后 120s 内打印 ready 横幅。
