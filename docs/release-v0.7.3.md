# Govio Map v0.7.3 — 画布能交接，包能被核对

> 覆盖 v0.7.2 之后的全部演进（**Phase 3 剩余三项 + 横切 X25–X31**）。
> 本版首次通过 **GitHub Actions 手动发布**（X31，`workflow_dispatch`）投产，不再依赖本地 OTP 手工 `npm publish`。
> govio-cli 与 Govio Map 独立发版；本轮口径判定增强在 govio 侧，见 govio 仓库对应 release。

## 🤝 画布能交给别人了（Phase 3）

- **只读分享重定义（T3.5）**：`/share/<token>` 从「导出快照」变成**活视图**——与主画布同一套节点渲染，
  轮询 3s + `ETag/If-None-Match`（304 不重传），页面隐藏暂停、恢复立即拉一次，失败指数退避并提示
  「与源画布同步中断」。分享开关默认关、关闭即撤销，token 由 **session 指纹**派生（同一会话链接恒定）。
  只读页删除复跑能力：动手一律先 fork。
- **会话打包导出（T3.6）**：`/export` 重做为自包含 zip（`<token>.govio-bundle.zip`）——对话 transcript +
  画布 sidecar + 分析留痕 + 权限/注入记录 + 交付报告 `report.html`，包根 `bundle.json` 记录**逐文件 sha256**。
  parquet 等大数据不入包但如实记账（缺几个、合计多少字节）；只走浏览器下载，不写工作目录。
- **会话打包导入（T3.7）**：`/import <路径>` 把上面那种包落地成本机**历史会话**（新 id，不覆盖）。
  六道读侧校验（路径/扩展名/常规文件/体积/条目数/清单白名单）+ **校验全绿前零写入**（内存校验后一次性写盘，
  失败回滚）；来源标注（源 token / 导出时间 / 源会话 id 与名）写进 sidecar，与原生会话可区分。
- **外层完整性校验（X27，本版新增）**：`bundle.json` 列不了自己的校验和，所以导出时额外给出**整包 sha256**
  （UI 可复制）并下载 `sha256sum` 兼容的 `<包名>.sha256` 旁文件；导入时 `/import <包> <sha256>` 可强制比对，
  不符即拒绝且零写入（新错误码 `outer-checksum-mismatch`）。

## 🎨 画布交互

- **小地图点击跳转（X30，BUGFIX）**：小地图（MiniMap）此前点击无反应——xyflow v12 的小地图只内置拖拽平移与
  滚轮缩放，`onClick` 只回传坐标、不替调用方移动视口。现补上「点击 → 视口居中到该位置」（缩放保持当前倍率），
  显式开启拖拽/滚轮，并给 `cursor-pointer` 光标反馈；只读分享视图同样可用（导航不是数据副作用）。
  实测还发现库自带 `onClick` 在渲染出的 svg 上不派发，改为外层 `display: contents` wrapper 接点击 + 自算
  坐标换算（纯函数，单测覆盖）。

## ⚙️ 工程质量

- **发布自动化（X31，本版新增）**：`.github/workflows/publish.yml`，**只有 `workflow_dispatch`（手动）**——
  发版是人的裁决动作，自动触发会烧掉不可变版本号。发布链含：版本一致性闸门 / 版本未被占用闸门 /
  从 govio release 预置 `.agents/skills`（`.gitignore` 把 skills 忽略，CI 里没有它们）/ 产物清单硬断言 /
  Trusted Publishing（OIDC，免长期 token，自带 provenance）优先、`NPM_TOKEN` 兜底 / 发布后元信息与
  `npm i -g` 自检 / tgz artifact（含 `.sha256`）。流程文档见 `docs/release-process.md`。
- **CORS 预检单一来源（X26）**：预检原先靠模块挂载顺序「顺手」兑现（parquet-api 的全局 OPTIONS 先返回），
  现上提到 `backend.ts` 统一应答，并删除模块内的重复分支与不可达死代码。
- **分享链接 404 修复（X25）**：分享链接不再用「API 端口 +1」拼，改为页面 origin 推导（部署到同源/反代后可用）。
- **模型与思考档链路修复（#50）**：可用模型走 `ModelRuntime`、可搜索下拉、思考档设置持久化、同步竞态与会话
  模型覆盖、CLI 新增 `--model/--thinking`。
- **包元信息与 LICENSE（#51）**：补齐 `description`/`keywords`/`homepage`/`repository`/`bugs`/`author`/`license=MIT`
  与 `LICENSE` 文件——v0.7.2 首次正式发布后发现 registry 上 License 等元信息全空（npm 只从 README 首行抓了
  description）。本版起 registry 元信息完整。

## 🔢 验证基线演进

脚本断言 671 保持（无增删）；vitest 33 文件 **487** 例（v0.7.2 为 20 文件 273 例），其中 UI 10 文件 **90** 例。
各 PR 合并态三门槛（build / lint / verify）全绿零回归；ubuntu CI 664 = 671 − 7（`verify:cwd` 的 caseDrift
闸门在 Linux 无法构造大小写漂移，属建模内的平台差）。

## 📌 已知取舍与遗留

- 小地图**滚轮缩放**在真机实测未生效（修复前同样如此，本轮未改其语义），已记 `docs/tasks/BUGFIX-minimap-navigation.md` 遗留。
- 整包校验和只能防传输损坏与意外篡改，**防不了**同时替换包与旁文件；要防伪造需源实例私钥签名 + 接收方持公钥
  （密钥生成/分发/轮换），归口 T3.3 一并设计。
- 导入侧不自动发现同目录 `.sha256`（避免悄悄改变既有行为），需显式带上校验和。
- 导入的会话不含 parquet ⇒ DataFrame 预览/复跑需重新取数（预览会明确提示「数据不在本机」，不再是空表）。
- 多用户会话隔离与 SSO（T3.3）、Docker 服务化部署（T3.4）仍未开始。
- npmjs 上用户早前发布的占位版本 `0.0.0-stage`（不在 latest）是否 deprecate/unpublish 仍待裁决。

## 📦 安装与运行

```bash
npm i -g govio-map@0.7.3     # 或 npm i -g <本 Release 附件 tgz>

govio-map                    # 在当前工作目录启动（HTTP + WS，默认 5173/5174）
```

前置条件：`govio-cli` 在 PATH（外部 CLI，启动时校验，无 mock 回退）；工作目录 `.env` 至少配置一个模型 provider
（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `MISTRAL_API_KEY`）。首次启动会把包内 `.agents`
（govio skills）与 `.pi/APPEND_SYSTEM.md` 播种到当前工作目录（`.agents` 覆盖式更新；`.pi` 只强制更新
`APPEND_SYSTEM.md`）。图谱快照 `assets/` 由 `govio-cli meta graph` 按环境生成，**不随包分发**。

> 自 v0.7.3 起，CI 构建的包内 `.agents/skills` 只含 govio 六个技能（来自 `chenxinma/govio` release 的
> `govio-skills.zip`），不含开发机本地额外的 `moli-*` 技能——这是预期口径，见 `docs/release-process.md` §6。
