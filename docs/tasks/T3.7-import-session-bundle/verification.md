# T3.7 验证

## 1. 验证命令与结果（全绿）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run build` | **0** | `tsc -b` 无错误；`vite build` ✓；`compile:server` → `dist-server/cli.mjs 225.8kb` |
| `npm run lint` | **0** | `eslint .` 无 error 无 warning |
| `npm run verify` | **0** | 九个脚本全绿 + `vitest run` 30 文件 452 例 + `vitest run tests/ui` 9 文件 84 例 |
| `git status --porcelain`（verify 全跑后） | — | 只含本任务改动（15 改 + 5 新），**无 verify 残留物**；`package.json` / `package-lock.json` **未出现** |

## 2. 断言数对账（改前 → 改后逐项）

### 2.1 脚本断言：**671 → 671（零变化，零回归）**

| 脚本 | 基线（main `9882ee5`） | 本任务后 | 差 |
|---|---|---|---|
| `verify:manifest` | 92 | 92 | 0 |
| `verify:rerun` | 71 | 71 | 0 |
| `verify:audit` | 119 | 119 | 0 |
| `verify:export` | **148** | **148** | **0** —— `scripts/verify-export-report.ts`、`src/utils/export-report.ts`、`CanvasToolbar.tsx` 三者零改动 |
| `verify:source-table` | 39 | 39 | 0 |
| `verify:semantic-lineage` | 54 | 54 | 0 |
| `verify:caliber-conflict` | 77 | 77 | 0 |
| `verify:cwd` | 13 | 13 | 0 |
| `verify:prompt-injection` | 58 | 58 | 0 |
| **合计** | **671** | **671** | **0** |

### 2.2 vitest（`npm run verify:integration` = `vitest run`，含 tests/ui）：**27 文件 377 例 → 30 文件 452 例（净 +75）**

**删除：0 例**（本任务不删任何既有用例，也不改任何既有测试文件）。

**新增：3 个文件，75 例**

| 文件 | 例数 | 覆盖（详见 `CHANGES.md`） |
|---|---|---|
| `tests/integration/session-import.test.ts` | **53** | 往返一致性 10、原子性与校验拒绝 14（每条断言零写入）、读侧路径安全 6、zip 闸门与 zip-slip 5、纯函数 3、HTTP 面 8、前端命令模块 7 |
| `tests/ui/import-command.test.tsx` | **14** | 参数通道纯函数 5、`/import` 接线 6、既有命令零回归 3 |
| `tests/ui/preview-degradation.test.tsx` | **8** | 预览降级 store 层 6、面板渲染 2 |

### 2.3 UI（`npm run verify:ui` = `vitest run tests/ui`）：**7 文件 62 例 → 9 文件 84 例（净 +22）**

新增 `import-command.test.tsx`（14）+ `preview-degradation.test.tsx`（8）；既有 7 个 UI 文件 62 例
**零改动零回归**（`canvas-toolbar` 2 / `settings-modal` 11 / `source-table-node` 16 / `sql-query-node` 8 /
`share-view` 13 / `share-toggle` 7 / `export-command` 5）。其中 `export-command.test.tsx` 尤其关键：
它渲染 `ChatInput` 时**只传 4 个必填 prop**（不传新增的 `onSessionsChanged`），5 例全绿 ⇒
新 prop 是可选的、`/export` 链路与提示形态未被本任务改动。

### 2.4 汇总（供主会话更新 `verificationBaseline`）

| 组 | 基线（main `9882ee5`） | 本任务后 |
|---|---|---|
| 脚本断言 | 671 | **671**（9 脚本逐项零变化） |
| vitest integration（`vitest run`） | 27 文件 / 377 例 | **30 文件 / 452 例** |
| UI（`vitest run tests/ui`） | 7 文件 / 62 例 | **9 文件 / 84 例** |

## 3. bundle 体积对比（X3 拆分纪律：导入代码不得进主 chunk）

| chunk | 基线（T3.6 后） | 本任务后 | 说明 |
|---|---|---|---|
| `index-*.js`（主） | 1458.25 kB（gzip 451.18） | **1460.50 kB（gzip 451.97）** | +2.25 kB：命令参数通道 + `PreviewPanel.previewError` + ChatInput 接线（都是主界面必需） |
| `import-session-*.js` | — | **3.62 kB（gzip 2.10）** | **新增懒加载 chunk**：`/import` 实现与 20 条错误码文案表，动态 import，只有用户真执行 `/import` 才付代价 |
| `export-session-*.js` | 14.11 kB | 14.11 kB | 未变 |
| `export-report-*.js` | 43.24 kB | 43.24 kB | 未变（T1.4 链路零改动） |
| `plotly.min-*.js` | 4646.12 kB | **4646.12 kB** | **未回退** |
| `sql-columns-*.js` | 2436.98 kB | 2436.98 kB | 未变 |

## 4. 验收契约逐条复核

| acceptance / scope 要求 | 落点 | 结果 |
|---|---|---|
| T3.6 的包能导入并作为**历史会话**出现在列表，打开后画布节点/边/Manifest 与源一致（往返自动化断言） | `session-import.test.ts`「往返一致性」10 例 + 真机冒烟 §5 | ✅ nodes/edges `toEqual` 源画布；`listSessions()` 命中且 id/name/messageCount 正确；真机 7 节点 3 边 2 留痕逐项一致 |
| 校验失败（校验和/清单/版本）与恶意包（穿越、超限）全部被拒且**不落任何文件**（原子性断言） | `expectZeroWrite()` 助手对 **14 条**拒绝路径逐条断言 sessions 目录列表前后完全一致 | ✅ 全部 `zeroWrite=true`（含写盘中途失败的回滚） |
| 会话 id 冲突有确定行为 | 一律新 uuid + 新文件名；落盘前对全部目标 `existsSync` 探测 → `target-conflict`（409）；断言既有会话文件字节未变 | ✅ 不提供覆盖（decisions ②） |
| 导入会话带来源标注，可与原生会话区分 | `.import.json` sidecar（`importMetaPathFor`，权威）+ 画布顶层 `importedFrom`（与 `forkFrom` 同层）；`readImportMeta()` 对原生会话返回 null | ✅ 机器可判 + 测试断言；**列表 UI 徽标未做**（需动 X2 契约，design.md 遗留 2） |
| 数据源/DataFrame 不可用时明确降级提示，不静默失败、不抛未捕获异常 | 预览：`PreviewPanel.previewError` + 面板告警块（404 专用文案）；复跑：沿用 T1.2 的 `rerunHistory`/`RerunStatus`；导入结果里报「N 个 DataFrame 需重新加载」 | ✅ 8 例断言，含 `unhandledRejection` 未发生 |
| `npm run build/lint/verify` 全绿；基线零回归 + 新增用例 | §1、§2 | ✅ 671 / 30·452 / 9·84 |
| 走 GitHub PR（用户合并） | 主会话负责 | ⏳ 待主会话推送建 PR |
| scope 5 安全：zip-slip / 绝对路径 / `..`、包与解压后体积上限、文件数上限、类型白名单、不执行包内内容、不覆盖既有会话 | `isSafeBundlePath` 复用 + 元数据闸门 + 三上限 + 只落 5 类固定 sidecar（包内路径不参与拼接落盘路径）+ 冲突探测 | ✅ 8 个穿越样本 + 3 类超限 + 冲突各被拒 |
| scope 8 文档 | `docs/specs/06-backend.md`（路由 + 20 条错误码表 + 校验顺序 + 落地形态）、`docs/specs/08-commands.md`（`/import` + 参数通道）、`docs/USER-MANUAL.md`（7.7 交接流程 + FAQ 5 条 + 术语） | ✅ |
| 不新增 WS 消息类型 / 不 bump `PROTOCOL_VERSION` | 列表刷新走既有 `session_list`；`src/types/ws-protocol.ts` 零改动（`ws-protocol.test.ts` 复绿） | ✅ 仍为 **1** |
| 零新增依赖 | zip 解压用 T3.6 已引入的 `fflate`（`unzipSync` + `filter`） | ✅ `package.json`/`package-lock.json` 零改动 |

## 5. 真机冒烟（仓库真实会话数据，临时脚本跑完即删，不进 commit）

在 **tmp cwd** 下跑完整链路：只**读**仓库 `.govio/sessions/` 里最大的一个真实会话（187,825 字节 transcript，
7 节点 / 3 边画布，含 audit 与 injection 留痕），复制到 tmp 后用 T3.6 真实链路打包 → T3.7 导入 → 校验 →
拒绝路径 → 真 HTTP 层 → 级联删除。结束时断言**仓库 `.govio/sessions/` 未被改动**。

```
repo sessions: 3; picked: 2026-11-15T08-52-22-637Z_01a1de68-….jsonl (187825 bytes)

[1] bundle = 3e27037a8304eb30813a56506240f23b.govio-bundle.zip (65089 bytes)
[1] entries = audit.jsonl, bundle.json, canvas.json, injection.jsonl, manifests.json, report.html, session.jsonl
[1] manifest: format=govio-session-bundle v1 token=3e27037a… files=6 missing=[]
              parquet(count=0, absent=[df_chocolate_metrics, df_sales_amount_by_channel])
[1]   六个文件 bytes 与 sha256 逐条 match=true（导入侧的校验依据成立）

[2] imported session id = b3b72916-a87d-4a4f-bf51-945d4b094311
[2] file = 2026-11-17T04-11-54-760Z_b3b72916-….jsonl        ← 沿用既有文件名约定
[2] name=null messages=52 nodes=7 edges=3 manifests=2         ← 源会话未被 pi 命名过，故 name=null
[2] filesWritten=[session.jsonl, canvas.json, audit.jsonl, injection.jsonl]
[2] sessions dir added: <新>.jsonl / .audit.jsonl / .canvas.json / .import.json / .injection.jsonl（5 个，无多余）

[3] canvas nodes equal=true  edges equal=true
[3] transcript lines 59 -> 59; non-header lines identical=true   ← 除 header 外逐字节不变
[3] header src = {"type":"session","version":3,"id":"01a1de68-…","timestamp":"2026-11-15T08:52:22.637Z",…}
[3] header out = {"type":"session","version":3,"id":"b3b72916-…","timestamp":"2026-11-15T08:52:22.637Z",…}
[3] audit identical=true   injection identical=true
[3] canvas sidecar has importedFrom=true  forkFrom=null
[3] .import.json = { "version":1, "importedFrom": { "token":"3e27037a…", "exportedAt":"…",
                     "originalSessionId":"2026-11-15T08-52-22-637Z_01a1de68-…", … } }

[4] listSessions total=1; imported found=true id=b3b72916-… name=null msgs=52
[4] second import distinct id=true file=true
```

**`[4] total=1` 是 §7「为什么必须改写 header」的直接实证**：tmp 的 sessions 目录里此时有**两份** transcript
（原样拷进来的源会话 + 导入产生的新会话），但 `listSessions()` 只返回 1 条——源会话因 header 的 `cwd`
指向 `D:\Work\gov-io\govio-map`（≠ tmp cwd）被 pi 的 `sessionCwdMatches` 过滤掉了；导入会话因为 header
的 `cwd` 被改写成本机 cwd 而正常出现。**照抄 header 的导入方案会产出一个「文件在、列表里没有」的死会话。**

拒绝路径（每条都同时断言 sessions 目录零写入）：

```
[5] checksum tamper            code=checksum-mismatch      match=true zeroWrite=true
[5] extra entry (清单外夹带)    code=entry-unexpected       match=true zeroWrite=true
[5] missing listed entry       code=entry-missing          match=true zeroWrite=true
[5] zip-slip entry (../evil)   code=unsafe-entry           match=true zeroWrite=true
[5] version bump (v99)         code=version-unsupported    match=true zeroWrite=true
[5] no manifest                code=manifest-missing       match=true zeroWrite=true
[5] not a zip                  code=bundle-unreadable      match=true zeroWrite=true
[5] nonexistent                code=bundle-not-found       match=true zeroWrite=true
[5] directory as bundle        code=invalid-path           match=true zeroWrite=true
[5] .zip 名但是目录             code=not-a-file             match=true zeroWrite=true
[5] non-.zip extension         code=invalid-path           match=true zeroWrite=true
[5] zip too large (cap 16B)    code=bundle-too-large       match=true zeroWrite=true
[5] uncompressed too large     code=uncompressed-too-large match=true zeroWrite=true
[5] too many files (cap 2)     code=too-many-files         match=true zeroWrite=true
[5] empty path                 code=invalid-path           match=true zeroWrite=true
```

### 5.1 真 HTTP 层（真 `node:http` server + 真 `fetch`，挂 `handleBundleApi`）

```
[6] POST ok          -> 200 ok=true nodes=7 cache=no-store acao=http://localhost:5173
[6] POST ghost       -> 404 {"error":"bundle-not-found","message":"找不到打包文件：…ghost.zip","detail":"ENOENT"}
[6] POST 夹带条目     -> 422 {"error":"entry-unexpected","message":"包内出现清单未登记的条目，已整包拒绝（防夹带）","detail":"x.txt"}
[6] POST 缺 path     -> 400 {"error":"invalid-request","message":"缺少 path 字段：用法 /import <bundle 路径>"}
[6] OPTIONS 预检      -> 204 allow-methods=GET, POST, DELETE, OPTIONS  allow-headers=Content-Type, If-None-Match
[6] OPTIONS 非白名单  -> 204 acao=(不回显 ✅)
[6] GET              -> 405 {"error":"method not allowed"}
[6] 响应是否泄漏包内容（SELECT / govio-cli 片段）: 否 ✅

[7] deleteSession 级联: jsonl=false canvas=false import.json=false   ← 三者一并删除
[7] tmp cleaned=true
[7] 仓库 .govio/sessions 未被改动=true（picked file still there=true）
```

关键结论：**OPTIONS 预检真的 204 且带齐 CORS 头**（否则 dev 下 5173→5174 的 `POST` + `application/json`
会被浏览器拦死，`/import` 在 dev 完全不可用）；非白名单 Origin 不回显（CORS 面未扩大）；
错误响应只给码 + 人话 + 包内**路径名**，不回显包内容。

### 5.2 附带取证（本任务范围外，已记 design.md 遗留 6）——**结论已经主会话实证更正**

worker 的同一探针单独测了 T3.5 分享路由的预检行为：

```
handleShareApi OPTIONS /api/shares      → handled=false status=0 acao=-
handleShareApi OPTIONS /api/share-state → handled=false status=0 acao=-
```

worker 据此推断「dev 跨源下撤销分享会被预检拦死」。**该推断不成立**（主会话 2026-11-17 验收时更正）：
上面是**单 handler 隔离**探测，而 `server/backend.ts` 的真实挂载顺序是 `handleParquetApi`（35）→
`handleShareApi`（36）→ `handleBundleApi`（38），且 `parquet-api.ts:88` 的 `OPTIONS` 分支在**任何路径判断之前**，
对所有预检一律回 204 + 完整 CORS 头。按真实三 handler 顺序起临时 server 实测：

```
OPTIONS /api/shares         → 204 allow-methods=GET, POST, DELETE, OPTIONS allow-origin=http://localhost:5173
OPTIONS /api/session-import → 204 allow-methods=GET, POST, DELETE, OPTIONS allow-origin=http://localhost:5173
```

即：**dev 跨源下 T3.5 的撤销分享（`DELETE /api/shares`）预检是通的，无现行故障**；T3.5 `verification.md §5.1`
记的「OPTIONS 预检 204」也成立（它按同一真实顺序挂载）。真实问题是**隐性脆弱**：分享路由的预检依赖一个
无关模块的全局分支 + 挂载顺序（同理本任务给 `bundle-api.ts` 补的 `OPTIONS` 分支在真实服务器上不可达，属
防御代码，其测试是单 handler 隔离断言）。建议修法：给 `share-api.ts` 补自己的 `OPTIONS` 分支，或把全局预检
上提到 `backend.ts` 使其与挂载顺序无关（归口后续 BUGFIX，本任务未动 `share-api.ts` / `backend.ts`）。

## 6. 未覆盖 / 需人工确认

1. **真实浏览器端到端**：本 worker 环境无浏览器、无 puppeteer/playwright（且纪律禁止 `npm install`），
   所以「在聊天框输入 `/import <路径>` → 看到反馈 → 历史列表出现该会话 → 点开画布与对话」这一段
   没有截图。自动化覆盖到：命令解析与接线（UI 测试，真实 `ChatInput` 渲染 + 真实 store）、
   HTTP 契约（真 server + 真 fetch）、落盘产物（真机冒烟逐项核对）。
   人工复现步骤：`npm run dev` → 在会话 A 里 `/export` 拿到 zip → `/import <该 zip 的路径>` →
   看输入框上方反馈 → 顶栏时钟图标打开历史列表 → 选刚导入的会话 → 核对画布与对话。
2. **降级提示的真机观感**：预览面板的「数据不在本机」告警块有 jsdom 渲染断言（含 `role="alert"`、
   空表与页脚不渲染），但真实浏览器里的排版/换行未目视。
3. **超大会话**：三个上限（64MB zip / 256MB 解压后 / 32 条目）用小上限注入触发，未造真实超大包
   （造一个 64MB+ 的真包会拖慢 CI）；解压后体积闸门是在**元数据阶段**按 `originalSize` 判的，
   不依赖真解压，故小上限注入与真实超限走的是同一条代码路径。
4. **`.import.json` 的 UI 呈现**：来源标注目前只有机器可读落点（sidecar + 画布顶层），
   会话列表里没有「导入」徽标（需改 X2 的 `WSSessionListItemSchema`），见 design.md 遗留 2。

## 7. 主会话验收期修正（PR #48 CI 抓到的跨平台测试缺陷）

**现象**：worker 交付的 commit 在 Windows 本地三门槛全绿，但 PR #48 的 ubuntu CI
`build + lint + verify` **红**：`tests/integration/session-import.test.ts > 安全：读侧路径校验（decisions ⑤）
> 不存在 → bundle-not-found；目录与 symlink → not-a-file` 断言
`拒绝路径必须零文件写入: expected [ …(4) ] to deeply equal []`（1 failed / 451 passed）。

**根因**（测试缺陷，非产品缺陷）：该用例在**开头**取 `const before = snapshotSessions()`，随后为造 symlink
样本调用 `buildRealBundle()` —— 它会在 `.govio/sessions/` 里建出源会话（`.jsonl` + canvas/audit/injection
三个 sidecar，正好 4 个文件）。于是 symlink 分支的 `expectZeroWrite(before, …)` 拿**陈旧快照**比较，
把测试自己的夹具误判成「导入写入」。Windows 上 `symlinkSync` 因缺权限抛 EPERM ⇒ 该样本被 `if (linked)`
跳过，所以本地绿；ubuntu 上 symlink 成功 ⇒ 缺陷暴露。**这是纯测试顺序问题**：被拒的导入
（`lstatSync` 识别 symlink → `not-a-file`）确实在抛错前不写任何会话文件。

**修法**：在 symlink 分支内**重新取快照**（`const beforeLink = snapshotSessions()`）再断言，并就地注释
说明为何不能用测试开头的 `before`。全文件其余 20+ 处 `expectZeroWrite` 都是「先建夹具再取快照」的正确顺序，
经 grep 逐处核对无同类倒置。**断言意图与强度不变**（仍然断言被拒导入零写入）。

**连带影响**：CI 的 `verify` 是 `&&` 串接，integration 失败 ⇒ **`verify:ui`（9 文件 84 例）那一轮在 CI 上根本没跑**。
修正后重跑，ubuntu CI 才第一次真正覆盖 UI 那 84 例；主会话另预先排查了两个新 UI 测试文件的平台敏感字面量
（`D:/x.zip` 等只是 `parseSlashCommand` 的不透明字符串入参，不触文件系统）与 integration 里的
UNC/设备路径样本（`resolveBundlePath` 是**先纯字符串拒绝再碰文件系统**，跨平台确定），未见其它 ubuntu 风险点。

**修正后本地复跑**（Windows）：`npm run build`=0 / `lint`=0 / `verify`=0，脚本 671、vitest **30 文件 452 例**、
UI **9 文件 84 例**，`session-import.test.ts` 53/53。ubuntu 侧以 PR #48 重跑后的 CI 为准。
