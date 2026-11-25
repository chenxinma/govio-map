# X32 发布与验证分离（BUGFIX：0.7.3 实测暴露的发布后自检缺陷）

状态：done（待 PR 合并）

## 背景（用户在 0.7.3 发布后直接要求）

X31 交付的 `publish.yml` 在「publish」之后紧跟一段 `Post-publish self check`。0.7.3 真实发布（run 45631909269）暴露两个缺陷：

1. **时序错**：npm 在 `npm publish` 成功后要把版本 **validating**（安全扫描 + provenance 记录），实测
   0.7.3 从「publish 成功（`+ govio-map@0.7.3`）」到「`registry.npmjs.org/govio-map/0.7.3` 返回 200」约 **5.5 分钟**
   （14:15:26 → 14:21:05）。自检在 publish 后 ~2s 就 `npm view`，必然 `ETARGET No matching version found`，
   `Post-publish self check` 步骤直接红——**包其实发成功了，run 却判失败**，且 artifact 上传被跳过。
2. **命令错**：自检用 `govio-map --version`，但 `dist-server/cli.mjs` 是 serve 入口（没有 `--version` 分支），
   真跑到这一步会启动服务并阻塞到 `timeout-minutes` 上限（用户排查时也确认「服务能正常跑，命令行验证不会自动退出」）。

用户指示：**把版本发布和有效性验证流程分开**。

## 裁决

| 决策 | 取值 | 理由 |
|---|---|---|
| 拆成几条 workflow | 两条：`publish.yml`（只发布）/ `verify-release.yml`（只验证） | 失败面分离：publish 失败 = 没发出去；verify 失败 = 已发出去但有问题，需要升新版本 |
| 触发方式 | 两条都**只有 `workflow_dispatch`** | 延续 X31 用户约束；验证要能「只重试」，不能被发布事件自动拉起 |
| 验证等待策略 | 验证自带轮询（默认上限 15 分钟，可配 `wait_minutes`） | npm validating 时长不可控；轮询比固定 sleep 稳，超时给明确人话 |
| 启动冒烟方式 | `npm i -g --prefix` 后**带超时启动**，等 `Govio Map ready at` 横幅，随后 kill | 该 CLI 没有 `--version`；横幅是 serve.ts 唯一稳定的「就绪」信号（`server/serve.ts:121`） |
| 冒烟用的 provider key | 注入明显假的 `ANTHROPIC_API_KEY=test-only-not-a-real-key` | 启动链路只校验存在性；本地实测该假值能起到 ready 且不会真的调模型 |
| 口径复用 | 抽 `pack-rules.mjs`，发布前（`npm pack --json`）与发布后（registry tarball 条目）共用同一套规则 | 避免「打包前断言」和「发布后验证」两套标准漂移 |
| artifact 上传 | `if: always()` | 0.7.3 那次因自检失败导致 tgz artifact 丢失，Release 附件只能从 registry 重新拉（本次即如此） |

## 实现

| 文件 | 变更 |
|---|---|
| `.github/workflows/publish.yml` | 删除 `Post-publish self check` 整段；文件头写明「发布与验证分离」及原因；artifact 上传改 `if: always()`；summary 追加「下一步去跑 verify-release.yml」 |
| `.github/workflows/verify-release.yml` | 新增。5 步硬断言：等 registry 200（轮询 + 上限）→ 元信息 7 字段 → 已上线 tarball 内容 → provenance（slsa + npm publish）→ 安装 + 启动冒烟 |
| `.github/workflows/scripts/pack-rules.mjs` | 新增：发布口径单一事实源（必需文件 / 六个技能目录 / 禁止前缀与模式 / 文件数与体积上限），导出 `evaluatePack()` |
| `.github/workflows/scripts/verify-pack-contents.mjs` | 改为调用 `pack-rules.mjs`（行为不变，输出加「发布前」标识） |
| `.github/workflows/scripts/verify-published-package.mjs` | 新增：从 `tar -tzf` 的条目列表断言已上线包内容（剥 `package/` 前缀与目录项） |
| `.github/workflows/scripts/verify-published-metadata.mjs` | 新增：`npm view --json` 的元信息完整性断言 |
| `.github/workflows/scripts/verify-provenance.mjs` | 新增：attestations 断言（含 `slsa.dev/provenance/v1` 与 npm publish attestation） |
| `docs/release-process.md` | §4 改为「只发布」，新增 §5「发布后验证（独立 workflow）」，后续章节重编号；写明 validating 实测 5.5 分钟 |

## 本地实证（对已上线的 0.7.3 跑一遍全部断言）

| 断言 | 结果 |
|---|---|
| `verify-published-metadata.mjs`（`npm view govio-map@0.7.3 --json`） | ✓ 7 字段齐全（license=MIT / description / author / repository / homepage / keywords / dist.integrity） |
| `verify-published-package.mjs`（registry tgz 的 `tar -tzf`） | ✓ 38 个文件，六个 govio 技能目录，无 assets/源码/凭据 |
| `verify-provenance.mjs`（attestations 接口） | ✓ 2 条：publish/v0.1 + slsa.dev/provenance/v1 |
| `verify-pack-contents.mjs`（本地 `npm pack --dry-run --json`） | ✓ 57 文件（含本机额外 moli-* 技能），规则复用后行为不变 |
| 启动冒烟（本机 Windows，安装后的 bin + 假 key + timeout） | ✓ 打印 `>>> Server agent ready. <<<` 与 `[Govio Map serve] ready at http://localhost:5173`，进程按 timeout 退出（exit 124 = 预期） |
| YAML 解析 | 两条 workflow 的 `on` 均只有 `workflow_dispatch`；jobs 分别 `publish` / `verify` |

## 遗留问题

1. `verify-release.yml` 的 CI 实跑要等本 PR 合并后（`workflow_dispatch` 需在默认分支注册）；合并后先用 `version=0.7.3` 跑一次作为首个 run 证据。
2. 启动冒烟依赖「假 key 就能起到 ready」这一点；若将来启动链路改成强校验真实 key，该步骤需要改为只做 `node --check` + 静态断言，或引入专门的 `--check` 参数（不建议为此加 CLI 分支）。
3. 冒烟只证明「能起来」，不证明「能用」（不真的调模型/取数）；后者需要真实 key 的 e2e，不在发布后验证范围内。
4. 发布后验证不复核「已发布 tarball 与 CI 产出的 artifact 是否字节一致」——两者同为 `npm pack` 产物，`dist.integrity` 与 sha256 已记录在 run 日志与 Release 附件里，需要时可人工比对。
