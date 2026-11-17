# T3.6 重做 `/export`：session 打包（zip）— 设计说明

> 任务：ROADMAP Phase 3 / T3.6（`docs/task-plan.json → phases[2].tasks[] | select(.id=="T3.6")`）
> 分支：`t36-export-session-bundle`（基于合并态 main `4c0af31`，已含 T3.5）
> 用户裁决：`decisions ①-⑤`（HTML 报告入包 / zip + fflate / parquet 排除但记账 / 仅浏览器下载 / 重做对象是简陋 JSON 快照）
> 主会话补充裁定：C1（`.storage.json` 不入包，只留 profile 引用名）、C2（包名 `<token>.govio-bundle.zip`，清单固定包根 `bundle.json`）

## 1. 目标与语义定位

T3.5 把只读分享改成了**活视图**（链接内容随源画布实时变化），于是「不可变留痕」这件事没有了归属。
T3.6 把它交给重做的 `/export`：**同一个会话 → 同一个 token → 同一份可离线归档、可校验、可被导入的产物**。

三条链路的分工（写进 `docs/USER-MANUAL.md` 7.4 / 7.5 / 7.6）：

| 链路 | 产物 | 语义 | 给谁 |
|---|---|---|---|
| 只读分享（T3.5） | `/share/<token>` 链接 | **活视图**，随源画布变 | 在线协作/围观 |
| 导出交付报告（T1.4） | 单文件 HTML | 某一刻的**可读**交付物 | 业务方（人） |
| **`/export`（本任务）** | `<token>.govio-bundle.zip` | 某一刻的**完整会话归档**（含那份 HTML） | 交接/归档/导入（机器 + 人） |

**基线更正（decisions ⑤，task-plan note 已记）**：重做对象是 `src/commands/export-session.ts` 那个 28 行的
前端 JSON 快照（`{exportedAt, messages[], canvas{nodes,edges}}`，无 Manifest、无 sidecar、无 token、不经服务端），
**不是** T1.4 的 HTML 交付报告。后者是 `CanvasToolbar` 的独立按钮 → `src/utils/export-report.ts`，本任务
**一字未改**，只是把它的产物作为 `report.html` 一并放进包里（decisions ①）。

## 2. 事实基线（实现前取证）

- 会话 sidecar 全集（`<cwd>/.govio/sessions/`）：`<s>.jsonl`（pi transcript）、`.canvas.json`、`.audit.jsonl`
  （T1.3，路径函数 `auditPathFor`）、`.injection.jsonl`（T2.1，`injectionTracePathFor`）、`.storage.json`
  （T3.1，`storageBindingPathFor`）、`.share.json`（T3.5，`shareStatePathFor`）；另有 1 个孤儿 `.injection.zip`。
- **Analysis Manifest 没有独立文件**：它固化在 `.canvas.json` 的 `node.data.manifest` 上（T1.1 设计），
  `server/share.ts` 的 `extractManifests(nodes)` 已能从画布抽出清单 ⇒ 复用，不另写一套。
- token：`deriveShareToken(sessionId)` / `sessionIdFromFile()` 已由 T3.5 导出 ⇒ 直接复用（scope 2「token 一致性」）。
- 浏览器拿不到本地文件 ⇒ 会话 sidecar **只能**由服务端读；`report.html` 的图表静态渲染
  （`renderChartImages` 借页面里的 Plotly `toImage`）**只能**在浏览器做。这决定了下面的分工。
- `export-report.ts` 的 `buildDeliveryReportHtml()` 是纯函数（`scripts/verify-export-report.ts` 在 Node 里直接调它），
  但 `exportCanvasDeliveryReport()` 会**自带下载**，不能复用于打包；它内部依赖的
  `renderChartImages` / `collectPermissionDecisionIds` / `parseAuditEntries` / `buildDeliveryReportHtml` 都是导出的
  ⇒ 组合它们即可，**无需改动 T1.4 模块**。
- `export-report.ts` 的 `fetchAuditAppendix()` 用的是它自己那份 `apiBase()`（页面端口 +1 硬编码，X25 遗留 2，
  归口 T3.4）⇒ **刻意不复用**，本任务自己写 `fetchAuditForBundle(ids, apiBase, fetchImpl)`，基址由
  `apiBaseFrom(window.location.origin) ?? ''` 推导（X25 纪律），行为（失败不阻断、如实记 `available:false` + 原因）
  与原函数一致。
- 斜杠命令系统**没有参数通道**：`SlashCommand.handler(ctx)` 只收 ctx，`ChatInput.handleSelect` 也不传原始输入
  余串；且 `handleSend` 对 `/xxx` 文本是**直接发给 agent**，只有从建议列表选中才执行 handler。
- `CommandContext.addSystemMessage` 在 `ChatInput` 里是**空实现**（"System messages are visual-only"），
  所以进度反馈不能走它。
- `ChatInput` 的 `messages/nodes/edges` props **只**被旧 `exportSession` 消费（`ChatPanel` 用
  `useCanvasStore.getState()` 非响应式取值传进来）。

## 3. 选型与取舍

### 3.1 zip 在哪一端组装 —— 选 B「后端给文件集 + 前端打包」

| 方案 | 做法 | 取舍 |
|---|---|---|
| A 后端产 zip | 服务端读 sidecar + 生成 report.html + 打包，返回 zip 字节 | ❌ `renderChartImages` 要浏览器里的 Plotly；服务端生成只能让图表降级为「配置摘要」，交付报告保真度下降（T1.4 的核心价值之一） |
| **B 后端给文件集 + 前端打包（选定）** | `GET /api/session-bundle` 返回 sidecar 文件集（base64 + 服务端算好的 sha256）；前端补 `report.html` 与 `bundle.json`，fflate 打包下载 | ✅ 两端各做自己独占的事；校验和的权威值来自服务端；上传量为 0；代价是 base64 让响应体 +33%（loopback，可接受） |
| C 前端上传 report.html，后端打包 | 前端把 HTML POST 上去，后端合成 zip | ❌ 内联 SVG 图表的报告可达数 MB，需要把请求体上限从 1MB 抬到几十 MB，攻击面与内存峰值都变差 |

选 B 的两个附带好处：`collectSessionBundle()` 是纯 Node 函数（tmp cwd 即可断言，不需要 DOM）；
zip 组装也是纯函数（依赖注入 fetch/hash/download/buildReport），node 环境就能反解产物逐条核对。

### 3.2 压缩库：`fflate@0.8.3`（decisions ②，用户已批准新增依赖）

- 对比：`node:zlib` 只能产 gzip/deflate 裸流，**没有 zip 容器**（本地文件头 + 中央目录 + CRC32），自写 ZIP writer
  等于自己实现一遍容器格式，还要处理 UTF-8 文件名与 DOS 时间戳 —— 不值得；`jszip` 体积约 100KB 且已停止活跃维护。
- `fflate` 同步 API（`zipSync`/`unzipSync`）+ 零依赖 + ~8KB gzip，浏览器与 Node 同一份代码 ⇒ 测试里能直接反解产物。
- **Windows 路径分隔符**：包内路径全部取自 `src/types/bundle.ts` 的常量（字面正斜杠），不经过 `path.join`，
  所以不存在 `\` 混入；`isSafeBundlePath()` 显式拒绝反斜杠。

### 3.3 `report.html` 的数据源：**包内 `canvas.json`**，不是画布 store 的实时状态

前端拿到服务端文件集后，从**包内的** `canvas.json` 解出 nodes/edges 再渲染报告。理由：

1. **包内自洽**：T3.7 导入后能看到的画布 = `canvas.json`，报告说的必须就是它，否则「归档包内部自相矛盾」；
2. **避开 autosave 竞态**：画布 sidecar 是 1s debounce 落盘，用 store 实时状态会出现「报告比包内画布新」的错位；
3. 顺带让 `ChatInput` 不再需要 `messages/nodes/edges` props（这三个 props 只为旧实现存在，一并删除，
   `ChatPanel` 也不再需要非响应式的 `useCanvasStore.getState()` 取值）。

代价：刚画上去、还没落盘（<1s）的节点不进包。这是「归档 = 会话已持久化状态」的自然语义，写进 USER-MANUAL 与遗留。

### 3.4 校验和分工

- 会话文件（`session.jsonl` / `canvas.json` / `audit.jsonl` / `injection.jsonl`）的 sha256 由**服务端**算
  （`node:crypto`）⇒ 权威值，且前端不用为了校验去解 base64 再哈希一遍；
- `manifests.json` 是服务端派生的内容，同样服务端算；
- `report.html` 只存在于浏览器 ⇒ 前端用 **WebCrypto `crypto.subtle.digest("SHA-256")`** 算。
  非安全上下文（无 `crypto.subtle`）时**明确报错并拒绝产包**，不产出「有一条没有校验和」的坏包
  （localhost / https 都是安全上下文，正常使用不会触发；测试用注入的 hasher）。

### 3.5 可复现性

zip 条目 mtime 一律固定为服务端给的 `exportedAt`，压缩级别固定 `level: 6` ⇒ **同一会话内容两次打包字节完全一致**
（有断言）。这让「同一 token → 同一份可归档产物」这句话在字节层面成立，接收方可以逐字节比对。

### 3.6 bundle 拆分（X3 纪律）：动态 import，主 chunk 不增

`ChatInput` 若静态引入 `commands/export-session.ts`，会把 **fflate + 整个 `export-report.ts`（1654 行）**
拖进主 chunk：实测主 chunk 1457.38 → **1515.21 kB**（gzip 450.79 → 473.33），且 `export-report` 独立 chunk 消失
——等于回退了 X3 的拆分。改为与 `CanvasToolbar` 同款 `await import("../../commands/export-session")` 后恢复：

| 产物 | T3.5 后（本任务基线） | 本任务后 | 差 |
|---|---|---|---|
| `dist/assets/index-*.js`（主 chunk） | 1,457.38 kB（gzip 450.79） | **1,458.25 kB（gzip 451.18）** | +0.87 kB（gzip +0.39）：ChatInput 的导出反馈条 |
| `dist/assets/export-session-*.js` | —（不存在） | **14.11 kB（gzip 7.11）** | 新增懒加载 chunk（fflate + 打包逻辑） |
| `dist/assets/export-report-*.js` | 43.13 kB | 43.24 kB | +0.11 kB（chunk 边界重排；`export-report.ts` 本身零改动） |
| `dist/assets/plotly.min-*.js` | **4,646.12 kB** | **4,646.12 kB** | **0（懒加载 chunk 未回退）** |
| `dist/assets/sql-columns-*.js` | 2,436.98 kB | 2,436.98 kB | 0 |
| `dist-server/cli.mjs` | 198.9 kb | 205.4 kb | +6.5 kb（session-bundle + bundle-api + fflate 无关，纯服务端收集逻辑） |

## 4. 打包清单（逐项取舍）

| 内容 | 包内路径 | 入包？ | 理由 |
|---|---|---|---|
| 会话 transcript（对话） | `session.jsonl` | ✅ | 「打包对话」的主体；pi 原生格式，T3.7 直接落盘即可被 `SessionManager.list` 识别 |
| 画布 sidecar | `canvas.json` | ✅ | 节点/边 + **节点内固化的 Analysis Manifest**（T1.1 的落点）；缺失时记进 `missing` 而不是造假数据 |
| Manifest 清单 | `manifests.json` | ✅（派生） | 复用 `extractManifests()`；让接收方不解画布也能核对留痕。真源仍是 `canvas.json`，文档与注释都写明它是派生物 |
| 权限确认留痕 | `audit.jsonl` | ✅（存在才入） | T1.3 的审计留痕是「谁批准了这次取数」的佐证，属归档内容 |
| 图谱注入留痕 | `injection.jsonl` | ✅（存在才入） | T2.1 的口径可追溯性同上 |
| T1.4 交付报告 | `report.html` | ✅（浏览器生成） | decisions ①：作为**可读入口**。空画布/无画布 sidecar 时不生成，原因写进 `bundle.json.reportOmitted`（如实记账，不静默省略） |
| 包清单 | `bundle.json` | ✅（前端最后组装） | T3.7 校验先行的唯一入口；**不列自己**（自引用无法计算校验和） |
| `.storage.json` | — | ❌ | 主会话裁定 C1：只在 `bundle.json` 留 `storageProfile` 引用名。凭据/endpoint/bucket/region 一律不出现在包里（有反向断言，连 `us-east-1` 都断言不出现） |
| `.share.json` | — | ❌ | 分享开关是**本机运行态**（T3.5：开关即访问控制 + 撤销机制），不是归档内容；带上它会让接收方误以为「这个包正在被分享」 |
| `.injection.zip` | — | ❌ | 旧格式孤儿残留（task-plan note 已点名不入包） |
| parquet 等大数据 | — | ❌ + 记账 | decisions ③：默认排除，但 `excluded.parquet = {count, bytes, names[], absent[]}` 让接收方知道缺什么；`absent` 还顺带告诉 T3.7「这些 DataFrame 本机已无，复跑/预览要降级」 |
| `.env` 与任何凭据 | — | ❌ | 从不读取；测试有反向断言（夹具用不带真实前缀形态的假值，见 §6.4） |

## 5. 包格式契约（T3.7 照这份实现）

```jsonc
// 包根 bundle.json（固定路径常量 BUNDLE_MANIFEST_PATH）
{
  "format": "govio-session-bundle",   // BUNDLE_FORMAT：第一个要核对的字段
  "version": 1,                        // BUNDLE_VERSION：不兼容变更时递增，T3.7 拒绝未知版本
  "token": "5b7497db7b34c02058ac939ce778c355",  // = deriveShareToken(sessionId)，与分享链接同一个
  "sessionId": "2026-11-14T10-57-32-491Z_01a1d9b4-…",
  "exportedAt": "2026-11-17T02:03:04.000Z",     // 服务端时钟；也是 zip 条目 mtime
  "appVersion": "0.7.2",                        // 可选（导出端拿不到时缺省）
  "files": [                                    // 除 bundle.json 自身外的**全部**包内文件
    { "path": "session.jsonl", "bytes": 123, "sha256": "<64 hex>" }
  ],
  "missing": ["audit.jsonl"],                   // 服务端就没读到的可选文件
  "excluded": { "parquet": { "count": 1, "bytes": 1024, "names": ["df_a.parquet"], "absent": ["df_gone"] } },
  "storageProfile": "my-profile",               // 可选：仅引用名
  "reportOmitted": "画布为空，未生成交付报告"      // 可选：只在没生成 report.html 时出现
}
```

- 包内布局是**单层**的（`isSafeBundlePath()` 只允许单层正斜杠相对路径），T3.7 解包不需要递归建目录；
- 常量与类型都在 `src/types/bundle.ts`（前后端共享，服务端以 `../src/types/bundle.js` 导入，与 `src/types/share.ts` 同款）；
- **T3.7 不要依赖文件名**：`<token>.govio-bundle.zip` 只是下载时的默认名，用户可能改名；识别靠 `bundle.json`。
- 契约锁进测试：`tests/integration/export-bundle.test.ts` 断言「`bundle.json.files[]` 与包内实际条目一一对应，
  且每条 sha256/bytes 都能被独立复核」——T3.7 的校验先行直接用同一套断言思路。

## 6. 安全模型

1. **只读**：`collectSessionBundle()` 只 `readFileSync` 会话自己的 sidecar；不写、不删、不执行命令、不读数据内容。
2. **会话路径白名单**：`?session=` 一律过 `assertValidSessionPath()`（必须是 `<cwd>/.govio/sessions/` 内的 `.jsonl`），
   与 `/ws` 的 open/delete 同款纪律 ⇒ 越界 400，且**不泄露存在性**（404 只给 `session-not-found`）。
3. **包内路径白名单**：`isSafeBundlePath()` 拒绝对路径、`..`、反斜杠、盘符、多层目录、空段。打包侧对
   **后端载荷**也做一次校验（防被篡改的后端/中间人塞进穿越路径），T3.7 解包前会再校一次（zip-slip 的正经防线在解包侧）。
4. **总量上限**：`MAX_BUNDLE_TOTAL_BYTES = 64MB`（服务端累加时即时判断，超限立刻抛 `BundleTooLargeError`）
   → HTTP **413** 带 `bytes`/`limitBytes` → 前端给「会话文件过大（X MB > 上限 Y MB）」的人话提示。
   依据：产物要在浏览器主线程 base64 解码 + 压缩，再大就不是「导出会话」而是「搬数据」；parquet 本来就排除。
5. **dfName 防穿越**：parquet 记账走 `dataframeParquetPathFor()`（`server/storage/paths.ts`），
   dfName 必须匹配安全标识符白名单（与 `parquet-api.ts` 的 `SAFE_DF_NAME_RE` 同款），非法名字不会被拼成磁盘路径。
6. **CORS 面未扩大**：只用 GET（CORS 安全方法）、不带自定义请求头 ⇒ 无预检，`server/security.ts` **零改动**
   （T3.5 为 DELETE/If-None-Match 改过一次；本任务刻意不重演）。测试反向断言方法白名单仍是 T3.5 那份，
   且非白名单 Origin 不回显。
7. **不进缓存**：响应 `Cache-Control: no-store`（会话内容）。

### 6.4 一个具体教训（写进代码注释与测试）

「凭据不外泄」的反向断言需要假凭据夹具，而**夹具字面量本身不能长得像真凭据**：T3.5（PR #46）用了带
AWS / OpenAI 前缀形态的假值，被 GitGuardian 当成真泄漏报红，主会话不得不压缩分支历史。本任务的夹具一律用
`TEST-ONLY-AK-8888` / `TEST-ONLY-SK-8888` / `TEST-ONLY-PROFILE` / `test-only-bucket-do-not-leak`，
并在两个测试文件顶部就地写明原因。反向断言本身不缩水：整包所有条目解出的文本里都不得出现这些值，
也不得出现 `us-east-1`、`storage-profiles.json`。

## 7. `/export` 交互

- **入口不变**：输入框键入 `/` → 建议列表选 `/export`（命令描述已改为打包语义）。斜杠命令系统没有参数通道，
  所以 **`/export` = 当前会话**；要导出历史会话，先在会话列表里打开它（服务端 `?session=` 已具备能力，
  UI 未接 —— 见遗留 2）。
- **进度与结果反馈**：`ChatInput` 输入框上方一句话提示条（与 `CanvasToolbar` 的导出提示同款形态与 8s TTL）：
  「正在打包会话（画布 + 对话 + 留痕 + 交付报告）…」→「已导出 `<文件名>`（X KB · N 个文件 · 含交付报告 ·
  未含 M 个 parquet（清单已记账））」/「导出失败：<原因>」。`CommandContext.addSystemMessage` 在 ChatInput 里是
  空实现，所以不走它，也**不改聊天消息语义**（`ChatMessage.role` 只有 user/assistant，塞 system 会动到渲染链路）。
- **并发保护**：打包进行中重复触发直接返回（有断言），不会并发第二次。
- **产物落地**：仅浏览器 `a[download]`（decisions ④：用户明确否决「写入 `.govio/exports/`」开关，未实现）。
- **错误映射**（全部人话，且不产出任何下载）：409 无活动会话 / 404 会话已删 / 400 路径不合法 /
  413 过大（带实际与上限体积）/ 5xx 带后端原因 / 载荷 `format`·`version`·`files` 形状不符 / 非法包内路径 /
  无 `crypto.subtle`。

## 8. 验证策略

新增 3 个测试文件、44 例（分布见 `verification.md §2`）：

- `tests/integration/session-bundle.test.ts`（23）：服务端收集器 + HTTP 路由。用**真实 sidecar 落盘**再收集，
  sha256/base64 与磁盘原字节逐条对账；missing/排除记账/凭据反向断言/穿越/超限/200·400·404·405·409/no-store/CORS。
- `tests/integration/export-bundle.test.ts`（16）：前端组装。载荷由**真实的 `collectSessionBundle`** 产出
  （前后端契约同一份，不各写夹具），产物用 `unzipSync` 反解后逐条核对 `bundle.json`、包内条目、sha256 可复核性、
  report.html 数据源来自包内 canvas、空画布/无画布分支、可复现性（两次字节相同）、基址纪律（dev 端口 +1 /
  生产同源相对路径）、HTTP 错误映射、载荷形状与非法路径拒绝、审计通道基址与三种降级。
- `tests/ui/export-command.test.tsx`（5，jsdom）：命令文案、触发链路、`pageOrigin` 传参、成功/排除 parquet/失败
  三种反馈文案、并发保护。

既有断言**零回归**：`verify:export` 148 项一项未动（`scripts/verify-export-report.ts` 与 `src/utils/export-report.ts`
均零改动），其余 8 个脚本数字逐项不变。

## 9. 遗留问题

1. **`server/parquet-api.ts` 仍持有自己的 `PARQUET_DIR` 常量**：本任务把 parquet 目录的路径规则加进了
   `server/storage/paths.ts`（`DATAFRAME_PARQUET_DIR` / `dataframeParquetDir()` / `dataframeParquetPathFor()`），
   但按范围纪律没有改 `parquet-api.ts`（它被 verify:manifest / verify:rerun / verify:audit 三个脚本覆盖，
   本任务的硬门槛是它们零回归）。两处同值，收敛留给后续（建议随 T3.4 部署收敛一起做）。
   `SAFE_DF_NAME_RE` 同理（`paths.ts` 内联了同款正则）。
2. **`/export` 只能导出当前会话**：斜杠命令系统没有参数通道（`handler(ctx)` 不收原始输入余串），
   要支持 `/export <会话>` 得改 `types.ts` + `useCommands.execute` + `ChatInput.handleSelect` 三处（还要处理
   「输入的命令名与匹配到的命令名不一致」）。服务端 `?session=` 已具备能力并有测试，UI 侧留给后续
   （或直接在会话列表加一个「打包导出」按钮，那时更符合用户心智）。
3. **刚落盘不足 1s 的画布变更不进包**：`canvas.json` 是 1s debounce 写（§3.3 的取舍）。要「导出前先 flush」
   需要在 `canvas-store` 暴露一个显式 flush（目前只有 `subscribeToCanvas` 的 debounce 订阅），属跨任务改动，未做。
4. **`report.html` 的审计附录仍受「当前会话」限制**：`GET /api/permission-audit` 只读服务端会话单例
   （既有设计，spec 06-backend 写明「请求里没有任何路径参数」）。所以导出**历史**会话时，包内 `audit.jsonl`
   是那个会话的（服务端读的），但 `report.html` 附录 B 可能拿不到对应记录 → 报告会如实写「未获取到审计记录」。
   要修需要给审计通道加会话参数（安全面要重新评估），未做。
5. **`bundle.json` 不列自己**：自引用无法算校验和。T3.7 若要防「清单被换」，需要外层签名或对 zip 中央目录另算
   一个哈希；本期靠「逐文件 sha256 + 清单字段齐全」满足验收，跨机防伪留待后续（与 T3.3 鉴权一起考虑）。
6. **包体上限是固定常量**（64MB，不可配）：超长会话只能分段归档。做成设置项需要先有设置面板的存储位，未做。
7. **`.govio/` 下大量历史 `output-*.json` 与 `chk_*.json` 孤儿文件**：与本任务无关（不是会话 sidecar，也不入包），
   但取证时注意到它们无人清理，记一笔。
8. **`package-lock.json` 的 `version` 字段漂移已随本次 `npm install fflate` 自然吸收**（0.7.0 → 0.7.2，
   T3.5 design.md 遗留 8 预告过会发生）。这是 lockfile 与 `package.json` 对齐，不是本任务引入的变更。
