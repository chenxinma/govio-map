# T3.7 设计：session 打包导入（`/import <bundle 路径>`）

> 任务事实源：`docs/task-plan.json → .phases[2].tasks[] | select(.id=="T3.7")`（`note` / `decisions ①-⑥` / `scope 1-8` / `acceptance`）。
> 上游契约：T3.6 的包格式（`src/types/bundle.ts` 常量 + `bundle.json`），**本任务直接复用，未另写一套**。
> 交付：`design.md`（本文）/ `CHANGES.md` / `verification.md`。

## 1. 目标与结论

把 T3.6 `/export` 产出的 `<token>.govio-bundle.zip` **反向导入**成本机 `.govio/sessions/` 里的一个历史会话：
出现在会话列表、可打开看到画布与对话、带来源标注、数据不在本机时给明确降级提示。

一句话结论：**校验全在内存里做完才落盘**（不用临时目录），**读宽写严**（包可从任意路径读，写入只在
sessions 目录内），**清单即白名单**（清单外条目一律整包拒绝），**永不覆盖**（一律新会话 id）。

## 2. 裁决落点逐条对照

| 裁决 | 落点 |
|---|---|
| ① `/import <路径>` 斜杠命令，不做界面上传 | `src/commands/built-in.ts` 的 `import` 命令（`args.required`）+ `src/commands/import-session.ts`；路径由**服务端**读（浏览器读不到任意本地路径）。无任何上传/拖拽 UI |
| ① 复用 `assertValidSessionPath` 同款校验纪律 | **不能直接复用它**：该函数要求路径在 sessions 目录内且以 `.jsonl` 结尾，而裁决 ⑤ 明确允许包在任意位置。故按其**同款纪律**另写 `resolveBundlePath()`（resolve → 白名单 → 存在性 → 常规文件 → 扩展名 → 体积），落盘侧则继续用「sessions 目录内 + 本机生成文件名」的更强约束 |
| ② id 冲突 → 新 id + `importedFrom.originalSessionId`，不提供覆盖 | 一律 `randomUUID()` 生成新 id + 新文件名；落盘前对**全部**目标路径做 `existsSync` 探测，任一存在 → `target-conflict`（409），绝不覆盖既有会话（审计留痕不可变） |
| ③ 本期只落本地，不自动绑 S3 | 只写 `.govio/sessions/`；**不写** `.storage.json`；`bundle.json.storageProfile` 有值时仅在结果提示里告知「源实例曾绑定 profile X，本机未绑定」 |
| ④ 校验全绿前零文件写入 | 见 §4：全程内存校验，无临时目录；写盘失败回滚 |
| ⑤ 读任意路径 / 写限定 sessions 目录 | 读侧六道校验（§5）；写侧目标文件名由本机生成，**包内路径不参与拼接落盘路径**，全部落在 `getSessionDir()` 内 |
| ⑥ 不加签名；清单外条目即拒 | 清单内逐文件校 `sha256` + `bytes`；包内出现清单未登记条目 → `entry-unexpected` 整包拒绝。剩余风险见 §10 遗留 1 |

## 3. 前置阻塞项：斜杠命令参数通道（取舍）

**问题**（T3.6 `design.md` 遗留 1 已取证，本次复核确认）：`SlashCommand.handler(ctx)` 不接收原始输入余串，
`/import <路径>` 根本无处安放参数。且 `ChatInput.handleSend()` 只在下拉**不显示**时把整行发给 agent，
输入 `/import D:/x.zip` 时 `filterCommands` 匹配不到任何命令（q = 整行）⇒ 该行会被**当成消息发给 AI**。

**方案对比**：

| 方案 | 评价 |
|---|---|
| A. `handler(ctx, args)` + `SlashCommand.args` 声明式（**采用**） | 改动最小（`useCommands.execute` 多一个默认空串的参数，既有 handler 签名兼容）；**声明了 `args` 的命令才被截获**，所以 `/export foo`、`/clear x` 的行为逐字不变（有反向断言）；命令元数据自描述，帮助文案与用法提示可复用 `placeholder` |
| B. `ctx.rawArgs`（把整行原文塞进 ctx） | 每个 handler 自己解析，重复且易错；且必须给**所有**命令都传原文，等于隐式改变全部命令的输入语义 |
| C. 在 ChatInput 里硬编码 `if (value.startsWith("/import "))` | 命令系统被绕过，第二个带参数命令出现时要再硬编码一次；违背「命令注册单一来源」 |

**匹配规则**：`parseSlashCommand(input, commands)` 取首个空白前的段与命令名**全等**（大小写不敏感），
余串 trim 后作为**单个参数**（路径可含空格）。不做前缀模糊匹配 ⇒ `/important x` 不会被误判成 `/import`（有断言）。

**交互**：下拉里选中带参数的命令 = **预填** `/import `（与 skill 命令的 `prompt` 预填同款），不是立即执行；
必填参数为空时给 `用法：/import <bundle 路径>` 提示并预填，不打后端。

## 4. 校验与原子性：为什么选「全程内存」而不是「临时目录」

decisions ④ 的原文是「先解到临时目录，全部校验通过后再落位」，⑤ 进一步要求「**推荐直接在内存中**完成校验，
全绿后才写盘」。本实现选**内存方案**，理由：

1. **更强的不变式**：临时目录方案在「校验失败」时磁盘上已经有解压产物（哪怕随后清理），清理失败就留残留；
   内存方案下失败路径**根本没有任何写 syscall**，「零文件写入」是结构性保证而不是清理纪律。测试因此可以对
   每条拒绝路径断言 `sessions 目录列表前后完全一致`（14 条拒绝样本全部 `zeroWrite=true`，见 verification.md §5）。
2. **体积本来就有界**：包上限 64MB（zip）/ 256MB（解压后），且**先判后解压**（§6）保证不会解压出超过上限的字节，
   内存峰值可控；不存在「必须落盘才装得下」的场景。
3. **⑤ 的写侧约束更简单**：临时目录也必须落在 `.govio/sessions/` 内（否则违反写侧限定），等于在会话目录里
   制造隐藏中间态，还要处理进程被杀时的孤儿目录。内存方案没有这个问题。

**写盘阶段**：先对全部目标路径做 `existsSync` 探测（`target-conflict`），再按 `plan` 逐个写；
任一写失败 → `rollback()` 删除本次已写文件 → `write-failed`（500）。回滚路径有专门断言
（注入 `writeFileImpl` 让第 2 个文件失败，断言第 1 个已被删、目录零残留）。
`writeFileImpl` 是**有意的测试缝**（与 `now` / `newSessionId` 同款）：ESM 下 `vi.spyOn(fs, "writeFileSync")`
会被 `Module namespace is not configurable` 拦住，没有它就无法覆盖回滚分支。

## 5. 读侧路径校验（decisions ⑤，六道）

顺序有讲究：**先纯字符串拒绝，再碰文件系统**，这样连 `stat` 都不会对设备路径发起。

1. 类型/非空（`invalid-path`）
2. 不含 NUL（`invalid-path`）
3. 不是 UNC / 设备路径：`^[\\/]{2}` 拦 `\\host\share`、`//host/share`、`\\.\C:`、`\\?\C:`；`resolve` 后再拦一次（`invalid-path`）
4. 扩展名 `.zip`（大小写不敏感）（`invalid-path`）
5. `lstatSync`（**不跟随符号链接**）：不存在 → `bundle-not-found`；symlink / 目录 / 设备 → `not-a-file`
6. 体积 ≤ `MAX_IMPORT_ZIP_BYTES`（64MB）→ 否则 `bundle-too-large`

包内容**永不写进日志**：错误响应的 `detail` 只放包内**路径名**或 fs 错误码，不放文件内容（有断言：
校验失败的响应里搜不到只存在于包内容里的哨兵串）。

## 6. zip 两段式：先判后解压（zip 炸弹防线）

fflate 的 `unzipSync(data, { filter })` 会对每个条目回调 `UnzipFileInfo`（`name` / `size` 压缩后 /
`originalSize` 解压后 / `compression`），**`filter` 返回 `false` 即不解压该条目**。据此：

- **第一遍**（`inspectBundleEntries`）：`filter` 一律返回 `false` ⇒ 拿到全部条目元数据而**一个字节都不解压**；
  在这一遍判完：条目数 ≤ 32、解压后总体积 ≤ 256MB、条目名过 `isSafeBundlePath`、无重名、压缩方式 ∈ {store, deflate}。
- **第二遍**：限额全部通过后才 `unzipSync(zipBytes)` 真正解压。

实证（fflate 0.8.3）：`filter` 全 false 时返回 `{}`（零解压），元数据里能拿到
`{name, size, originalSize, compression}`，且 `../evil.txt` 这类条目名**原样出现**在元数据里
⇒ zip-slip 能在解压前就被拦住。若反过来「先解压再检查」，一个 64MB 的高压缩比包足以把进程内存打爆。

## 7. 为什么必须改写 transcript header（关键取证）

照抄源 transcript 是**导不出可用会话**的，两条硬事实（读 pi `session-manager.js` 取证）：

1. `SessionManager.list(cwd, sessionDir)` 在 `sessionDir` 不是 pi 默认目录时
   （本仓传的正是 `<cwd>/.govio/sessions`）会按 **header 的 `cwd`** 过滤：
   `sessionCwdMatches = resolvePath(header.cwd) === resolvePath(cwd)`，**大小写敏感**。
   源包的 header.cwd 是源机器路径 ⇒ 导入后 `listSessions()` **根本看不到它**。
2. `SessionInfo.id` 直接取 **header 的 `id`**（不是文件名）⇒ 照抄会与源会话 id 撞车，违反 decisions ②。
3. 另外 `buildSessionInfo` 要求**首个可解析条目必须是 `type:"session"`**，否则整个文件被当成非会话丢弃。

**真机实证**（verification.md §5）：把源会话文件原样拷进 tmp 的 `.govio/sessions/` 后，`listSessions()`
返回 **0 条**（header.cwd 指向别处被过滤掉）；导入产生的新会话 `listSessions()` **能看到**
（total=1，id/消息数正确）。这条实证同时说明「改写 header 不是可选项」。

**改写范围刻意最小**：只改 header 一行的 `id`（新 uuid）、`cwd`（本机 `process.cwd()`）、
`parentSession`（→ `null`，源机器的父会话路径在本机不可解析，留着只会指向空气）；
**其余每一行逐字节保留**（含行尾风格 CRLF/LF 与末尾换行），有断言。

`cwd` 取值说明：写 `process.cwd()` 而**不是** `canonicalizeCwd(process.cwd())`——因为 `listSessions()`
比较的基准就是 `process.cwd()`，X7 已在启动链路（`applyCanonicalCwd()`）把它规范成磁盘大小写；
在符号链接路径下再做一次 `realpathSync.native` 反而会与比较基准不一致。

## 8. `importedFrom` 落点论证（scope 3「来源标注」）

要求：可与原生会话区分、不污染 X2 的 WS 契约、不改既有 sidecar 形状、旧会话零影响。

| 落点 | 采用 | 理由 |
|---|---|---|
| **新 sidecar `<session>.jsonl.import.json`** | ✅ **权威记录** | 与既有 sidecar 命名/生命周期完全同构（`.canvas.json` / `.audit.jsonl` / `.injection.jsonl` / `.storage.json` / `.share.json`）；路径函数加进 `server/storage/paths.ts` 保持单一来源；`deleteSession()` 挂上同生命周期删除。**它的存在本身就是「原生 vs 导入」的判别依据**，旧会话没有这个文件 ⇒ 零影响 |
| **画布 sidecar 顶层 `importedFrom`** | ✅ 血缘邻近信息 | 与 T3.2 的 `forkFrom` 同一层、同一机制（`saveCanvas` 的 meta 语义）；保留源包其它顶层键（`forkFrom` 血缘不丢）。画布是「成果物」，来源标注跟着成果物走才有交接意义 |
| WS `session_list_result` 增字段 | ❌ 不做 | 需要改 `WSSessionListItemSchema`（X2 契约）。brief 明确要求「不新增 WS 消息类型、不 bump `PROTOCOL_VERSION`」；且列表徽标属交互增强，不是本期验收必需 ⇒ 记遗留 2 |
| transcript 里追加 `session_info` / `custom` 条目 | ❌ 不做 | 会改动 pi 的 append-only 条目树（`parentId` 链与 leaf），一旦链错会影响 `getBranch()` 与会话恢复；为「列表里显示（导入）」冒这个风险不划算 ⇒ 记遗留 2 |

内容：`{token, exportedAt, originalSessionId, originSessionName, bundleFileName, importedAt}`。
`bundleFileName` **只记文件名不记源路径**（避免把源机器的目录布局写进留痕）；
`originSessionName` 从包内 transcript 的 `session_info` 取最新一条（与 pi `buildSessionInfo` 同口径：
空白名等于清除，不拿旧名充数）。

## 9. 落地文件清单（哪些包内文件**不**落地）

| 包内文件 | 落地为 | 说明 |
|---|---|---|
| `session.jsonl` | `<新id>.jsonl` | header 改写（§7），其余字节原样 |
| `canvas.json` | `<新id>.jsonl.canvas.json` | 顶层追加 `importedFrom`，保留 `forkFrom` 等源键；节点内固化的 Manifest 随之过来 |
| `audit.jsonl` | `<新id>.jsonl.audit.jsonl` | 原字节；包里缺就不写 |
| `injection.jsonl` | `<新id>.jsonl.injection.jsonl` | 同上 |
| —（本机生成） | `<新id>.jsonl.import.json` | 来源标注 sidecar（§8） |
| `report.html` | ❌ 不落地 | 它是**给人看的导出产物**（自包含 HTML，双击即开）；写进 sessions 目录只会制造 pi 不认的孤儿文件。仍参与 sha256 校验 |
| `manifests.json` | ❌ 不落地 | 它是 `canvas.json` 的**派生便利产物**（真源在节点 `data.manifest`）；落地就会出现两份可漂移的真相。仍参与校验，并用它给出 `manifestCount` |
| `bundle.json` | ❌ 不落地 | 清单本身；关键内容（token/时间/排除记账/profile）已进 `.import.json` |

## 10. 降级语义（scope 4）

包里**不含 parquet**（T3.6 裁决 ③），所以导入会话的数据侧能力必然降级。三个面：

1. **预览**：改动前 `openPreviewPanel` 的 `.catch()` 只 `console.error`，面板照旧渲染成「0 rows」空表——
   这正是 scope 4 点名的**静默失败**。现在给 `PreviewPanel` 加 `previewError`，失败时面板渲染告警块
   （隐藏空表与分页页脚），404 给专用文案「数据不在本机：DataFrame「X」的 parquet 不存在。导入的会话包
   不含数据文件，需重新加载该 DataFrame 后才能预览。（后端：…）」，其它状态给「预览失败：HTTP N（原因）」。
   `updatePreviewPanelData` 成功时清掉旧错误。**未碰**该函数里的「页面端口 +1」基址（X25 遗留 2，归口 T3.4）。
2. **复跑**：沿用 T1.2 既有链路——失败会把原因记进 `rerunHistory`（`outcome:'error'`）并由 `RerunStatus` 展示；
   没有 Manifest 的节点本就不显示复跑按钮。不新增代码，也不静默。
3. **存储绑定**：不自动绑定；只在导入结果里告知源 profile 名（§2 裁决 ③）。

对话记录**只读展示**：transcript 原样落地，前端用既有 `buildTranscript` 分页渲染，没有任何可编辑入口。
全链路无未捕获异常（`fetch` reject / 非 JSON 响应 / 缺字段都有兜底，有断言）。

## 11. HTTP 面与 CORS

- `POST /api/session-import`（body `{path}`，上限 8KB，流式判定超限即 `req.destroy()`）→ 200 `{ok:true, …result}`，`Cache-Control: no-store`
- **本任务显式应答 `OPTIONS` → 204**：POST + `Content-Type: application/json` 不是 CORS 简单请求，
  dev 下页面(5173) → API(5174) 跨源必先预检。`security.ts` 的白名单自 T3.5 起已含 POST 与 Content-Type，
  **故本任务未改 `security.ts`**（与 T3.6 的 GET 通道一样不扩大 CORS 面），只在 `bundle-api.ts` 内
  按 `parquet-api.ts` 的既有写法补预检分支。非白名单 Origin 不回显（有断言）。
- 错误码 → 状态映射集中在 `importStatusFor()`：400（路径类）/ 404（找不到）/ 409（不覆盖）/
  413（三类超限 + 请求体超限）/ 422（**载荷**层面的问题：包不合法、清单不符、校验和不符、夹带、transcript 非法）/
  500（落盘失败）。全部码在 `src/types/bundle.ts` 的 `IMPORT_ERROR_CODES` 里枚举，
  前端 `IMPORT_ERROR_TEXT` 逐码给人话，测试表驱动断言「每个码都有确定状态」。
- 导入成功后前端调 `onSessionsChanged()`（= `useChat().fetchSessions`）走**既有** WS `session_list`
  重拉列表 ⇒ 不新增 WS 消息类型，`PROTOCOL_VERSION` 仍为 **1**（`src/types/ws-protocol.ts` 零改动）。

## 12. 测试策略

| 层 | 文件 | 例数 | 要点 |
|---|---|---|---|
| 服务端逻辑 + HTTP + 前端命令模块 | `tests/integration/session-import.test.ts` | 53 | **往返用真产物**：`collectSessionBundle` + `exportSessionBundle`（注入 fetch/hash/download/report 替身）产出真 zip → 导入 → 逐项核对；14 条拒绝路径**每条都断言零文件写入**；zip 元数据闸门纯函数单测；`rewriteTranscriptHeader` / `newSessionFileName` 纯函数；HTTP 用 fake req（EventEmitter，投喂分块 body 以覆盖流式超限）；前端模块的基址纪律与错误码翻译 |
| 命令接线 | `tests/ui/import-command.test.tsx` | 14 | 参数通道纯函数（全等匹配、大小写、余串含空格、`/important` 不误判、`/export foo` 不截获）；下拉选中 = 预填；回车即导入并交出页面 origin；成功反馈 + 刷新列表；失败人话；缺参数用法提示；并发保护；**既有命令零回归**（`/export` 仍立即执行、`/export 帮我导出一下` 仍走 `onSend`、普通消息照常发送） |
| 降级提示 | `tests/ui/preview-degradation.test.tsx` | 8 | 用**真实 store + 真实面板组件**：404 → 「数据不在本机」文案；500 → 状态码 + 后端原因；fetch reject → 有提示且无 unhandledRejection；成功 → `previewError` 清空；`updatePreviewPanelData` 清旧错；`setPreviewPanelError` 只影响目标面板；有错时渲染告警块且不渲染空表/页脚，无错时表格照常（零回归） |

夹具纪律：假凭据一律 `TEST-ONLY-*`，**不带任何真实凭据前缀形态**（PR #46 的 GitGuardian 教训，就地注释）。

## 13. 遗留问题

1. **包完整性无外层签名（口径 ⑥ 的剩余风险）**：`bundle.json` 无法给自己算校验和，所以「攻击者同时重写清单与
   对应文件」在包内不可检测——此时它等同于「一个自洽的任意包」。本期防线是：清单内逐文件 sha256 +
   清单外条目整包拒 + 路径/体积/条目数闸门 + 不执行包内任何内容 + 不覆盖既有会话。要真正闭合需要
   导出侧额外产出一个包外校验值（如 UI 显示整包 sha256 供人工核对，或旁挂 `.sha256` 文件），
   但 decisions ④ 只允许浏览器下载、不写工作目录，落点需要用户裁决。
2. **会话列表里没有「导入」徽标**：来源标注在 `.import.json` 与画布顶层（机器可判、测试可断言），
   但列表 UI 不显示。要显示需给 `WSSessionListItemSchema` 加可选字段（X2 契约变更 + 可能 bump
   `PROTOCOL_VERSION`），或给 transcript 追加 `session_info`/`custom` 条目（动 pi 的 append-only 条目树，
   有 leaf/branch 风险）。两者都超出本期「不动 WS 契约」的纪律。
3. **`/import` 只接一个路径参数，不做批量导入**：命令参数通道当前是「余串整体作为单个参数」。
   批量导入（一个目录 / 多个包）需要参数解析升级与进度 UI，未做。
4. **导入不恢复 DataFrame / 不重连数据源**：只落地会话文件。要「导入即可复跑」需要把数据源配置与
   parquet 一并搬运（涉及凭据与体积），与 T3.6 裁决 ③「大数据不入包」冲突，本期只给降级提示。
5. **`MAX_IMPORT_*` 三个上限是固定常量**（64MB zip / 256MB 解压后 / 32 条目），不可配。
   与 T3.6 的 64MB 导出上限同款取舍；做成设置项需要先有设置面板的存储位。
6. **发现（非本任务范围，隐性脆弱而非现行缺陷；主会话 2026-11-17 实证更正）：分享路由自己没有 `OPTIONS` 分支，预检靠 `parquet-api.ts` 的全局分支兑现。**
   取证：`handleShareApi` 单独探针对 `OPTIONS /api/shares` 返回 `handled=false`（三个探针全 false）——但 `server/backend.ts`
   的真实挂载顺序是 `handleParquetApi`（35 行）→ `handleShareApi`（36）→ `handleBundleApi`（38），而
   `parquet-api.ts:88` 的 `OPTIONS` 分支在**任何路径判断之前**，对所有预检一律回 204 + 完整 CORS 头。
   主会话按真实三 handler 顺序起临时 server 实测：`OPTIONS /api/shares → 204 allow-methods=GET, POST, DELETE, OPTIONS
   allow-origin=http://localhost:5173`（`OPTIONS /api/session-import` 同）。**结论：dev 跳源下 T3.5 的「撤销分享」（DELETE）预检是通的，
   `ShareToggle` 不存在现行故障；T3.5 `verification.md §5.1` 记的「OPTIONS 预检 204」也成立（它按同一真实顺序挂载）。**
   剩余风险是**隐性脆弱**：分享路由的预检依赖一个无关模块的全局分支 + 挂载顺序，若日后重排 `backend.ts`
   或把 `parquet-api.ts` 的 `OPTIONS` 收窄到自己的路径下，撤销分享会静默坏掉。同理，本任务给 `bundle-api.ts` 补的
   `OPTIONS` 分支在真实服务器上也是**不可达的防御代码**（parquet-api 先兑现；它的测试是在单 handler 隔离下断言的）。
   **已由 X26 修复（2026-11-17，`docs/tasks/BUGFIX-share-preflight.md`）**：上面列的两个候选修法中采用了后者——
   预检**上提到 `backend.ts`** 成为单一来源（新增具名导出 `handleBackendRequest`，在所有 `handle*Api` 之前调
   `security.ts` 的 `respondToCorsPreflight`，且只认 `/api/*`），并删除 `parquet-api.ts` 的两处与 `bundle-api.ts` 的一处
   模块内 `OPTIONS` 分支；本文件当初建议的另一候选（给 `share-api.ts` 也补一个分支）被否，因为它把一处死代码
   变成 N 处重复代码，且仍无法保证顺序无关。断言见 `tests/integration/cors-preflight.test.ts`（18 例，含
   「任何 handler 单独都不再兑现预检」与「反向挂载也拿不到 204」两条顺序无关断言）；本任务那条隔离预检断言
   已改写为「模块自身不再应答预检 → 405」。
7. **`server/parquet-api.ts` 仍持有自己的 `PARQUET_DIR` 与 `SAFE_DF_NAME_RE`**（T3.6 遗留 1 同源问题）：
   本任务未新增重复常量（预览降级只改前端），但该收敛仍未做。
