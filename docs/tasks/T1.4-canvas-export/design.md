# T1.4 画布交付导出（自包含 HTML）— 设计说明

> 任务：ROADMAP Phase 1 / KR4「交付导出」
> 分支：`feature/phase1-trusted-analysis`，前置任务 T1.1（Analysis Manifest）/ T1.2（复跑与漂移）/ T1.3（权限审计留痕）
> 状态：实现完成。`npm run build` + `npm run lint`（0 error）+ `npm run verify:export`（116 项断言）通过；
> T1.1/T1.2/T1.3 验证脚本无回归（52 / 62 / 86 项）

## 1. 目标与范围

把「画布上这一次分析」变成一份**可以发出去的交付物**：一个 HTML 文件，双击就能离线打开，里面既有给人看的结论（节点卡片 + 血缘图），也有给质疑者查的留痕（附录 A Manifest、附录 B 权限确认记录）。

范围内：画布工具栏「导出交付报告」入口、导出模块（`src/utils/export-report.ts` + 内联样式表）、五类节点的静态快照、简化 SVG 层次血缘图、附录 A/B、一个**只读**审计通道（`GET /api/permission-audit`）、可复跑验证脚本与样例产物。

范围外（本任务不做）：PDF/Word 等其他格式（浏览器打印到 PDF 已经可用，样式里带了 `@media print`）、导出历史与版本管理、导出内容的人工编辑/批注、report 与 chart 节点的留痕（T1.1 遗留问题 5）、跨会话审计检索、导出权限控制（单机单用户）。

**数据来源纪律**：只消费画布 store 已有的节点数据（结构、SQL、Manifest、复跑记录）+ 上述只读审计通道。不读 parquet、不调 `govio-cli`、不调模型、不做任何新的数据采集。

## 2. 交付物形态：为什么是「单文件自包含 HTML」

| 方案 | 取舍 |
|------|------|
| **单文件 HTML（选定）** | 双击即开、无需服务、可邮件/IM 直接发；内联 CSS + 内联 SVG + data URL 图片，**零外部请求**，断网也是同一份排版；纯文本便于 diff 与归档 |
| JSON 快照（既有 `/export` 命令） | 机器可读，但业务方打不开；已有实现，本任务不动它，两者并存（一个给人、一个给机器） |
| PDF | 需要引入渲染/打印依赖或走系统打印对话框；HTML + `@media print` 已能让用户自己「打印成 PDF」，不必多一条依赖 |
| 多文件目录（HTML + assets） | 发出去容易丢文件，「离线可打开」这条验收就无法保证 |

自包含的三条硬约束（验证脚本第 1 节逐条断言）：

1. **无脚本**：产物里不出现 `<script>`。交付物是「快照」，不需要交互；没有脚本也意味着画布里的任何内容都不可能在收件人机器上执行。
2. **无外部引用**：无 `<link>`、无 `@import`、无 `http(s)://` 资源、无协议相对 `//`、无 `<iframe>/<object>/<embed>`；`<img>` 只允许 `data:` URL。应用自身用 Google Fonts 的 DM Sans / JetBrains Mono，导出文件一律退到**本机字体栈**（`-apple-system / Segoe UI / Microsoft YaHei` 与 `JetBrains Mono / Cascadia Mono / Consolas`），断网不缺字。
3. **样式内联**：一份 `REPORT_CSS` 常量写进 `<style>`，配色沿用 `src/index.css` 的 light「Green Deck」令牌（品牌绿 `#1db954`、warning `#f59b23`、error `#e22134`、五类节点色与画布 MiniMap 同值），交付物与应用内观感一致。

## 3. 模块结构与懒加载

```
CanvasToolbar「导出交付报告」
  └─ await import('../../utils/export-report')     ← 动态 import，点击时才加载
       ├─ renderChartImages(nodes)                 借浏览器里已有的 Plotly 把 chart 画成 data URL
       ├─ fetchAuditAppendix(decisionIds)          只读 GET /api/permission-audit（失败不阻断）
       ├─ buildDeliveryReportHtml(input)           ★ 纯函数：同样的输入 → 同样的字符串
       │    ├─ layoutLineage() / lineageSvg()      血缘层次布局 + 内联 SVG
       │    ├─ renderNodeCard() ×5 类              静态卡片快照
       │    ├─ renderAppendixA() / renderAppendixB()
       │    └─ REPORT_CSS（export-report-style.ts）
       └─ downloadHtml(fileName, html)             Blob + a[download]（与既有 export-session.ts 同一套机制）
```

- **`buildDeliveryReportHtml` 是纯函数**：不读时钟、不碰 DOM、不发请求，`exportedAt` 与图表图像都由入参给定。这是验证脚本能在 Node 里直接构造样例画布、逐字节比对产物的前提，也让「导出可复现」成为结构性质而不是自觉。
- **样式单独成文件**（`export-report-style.ts`）：模板字符串常量，与结构/内容渲染分开，两边都好读。
- **懒加载已验证生效**：`npm run build` 产出独立 chunk `dist/assets/export-report-*.js`（40.38 kB / gzip 15.01 kB），主 bundle 只增加了工具栏按钮那几行（6,065.50 kB → 6,069.33 kB）。
- **没有新增任何 npm 依赖**。Plotly 是既有依赖（`ChartNode` / `ChartModal` 已静态引入，本来就在主 bundle 里），导出时 `await import('plotly.js-dist-min')` 命中的是同一个模块，不额外增加体积。

### 措辞单一来源（顺带去重）

节点「详情」面板与交付报告展示的是同一份留痕，措辞必须一致，否则「画布上叫 A、交付物里叫 B」。为此把两处会重复的标签抽成共享常量，**不改任何行为**：

- 新增 `src/utils/manifest-labels.ts`：`MANIFEST_ORIGIN_LABELS` / `manifestOriginLabel()` / `manifestModelLabel()`；`ManifestDetails.tsx` 改为引用它（删掉本地的 `ORIGIN_LABELS` 与 `modelLabel`，展示文本逐字不变）。
- `src/utils/rerun.ts` 增加 `RERUN_OUTCOME_LABELS`（复现一致 / 漂移 / 复跑失败），`RerunStatus.tsx` 的 `OUTCOME_META` 从这里取 label（图标与颜色仍留在组件里）。

## 4. 节点卡片：五类静态快照

卡片 = 头部（类型徽标 + 标题 + 创建时间 + 节点 ID + 状态徽标）+ 主体（按类型）+ 脚部（上游/下游节点锚点链接）。全部字段取自 `node.data`，与画布节点组件同源。

| 类型 | 导出内容 | 取舍 |
|------|----------|------|
| `sourceTable` | 表名 / 数据源 / 行数 / 说明 + 字段表（# / 字段 / 类型 / 可空 / PK·FK→引用 / 说明） | 字段表**全量**列出（上限 200 行，超出写明「仅列出前 200 个」），因为表结构就是交付物的一部分 |
| `sqlQuery` | SQL 全文（`<pre>`，不截断）+ 输出列 chips + Manifest 摘要 | SQL 是口径的唯一凭据，宁长不截 |
| `dataFrame` | 漂移/一致/失败状态框 + DataFrame·数据源·行×列·内存 + 列结构表（列名/Non-Null/dtype）+ **复跑记录全量列表** + Manifest 摘要 | 见 §8：**不导出 `previewData`** |
| `report` | 报告类型 + 对比对象 chips + 正文 | 正文用**自带的极简 markdown 渲染**（`## / ### / - / 1. / \| 表格 \| / **粗体** / \`code\``），不内联 markdown 运行时、也不复用 `ReportNode` 的 React 版解析器（它产出 ReactNode 不是字符串）。报告正文由助手生成、格式稳定，子集够用 |
| `chart` | 静态图像（优先）**或**配置摘要（降级） | 见下 |

### chart：静态渲染，不内联 Plotly（核心取舍）

三种可能：

- **A. 把 `plotly.js-dist-min` 内联进导出文件**，让图表在收件人浏览器里交互渲染。否决：压缩后约 3.5 MB，一份「交付报告」会比整个应用还大；而且违反 §2 的「无脚本」约束。
- **B. 自己写一个图表渲染器**（按 trace 类型画 SVG）。否决：等于在交付模块里重新实现 Plotly 的一个子集，是明确的能力重复建设。
- **C. 选定：导出瞬间把图渲染成静态图片内联**。`renderChartImages()` 建一个离屏容器（`position:fixed; left:-100000px`，显式 680×400），对每个 chart 节点用**节点已有的 `config.data` / `config.layout`** 调 `Plotly.newPlot(..., { staticPlot: true })`，再 `Plotly.toImage()` 拿 data URL，`finally` 里 `purge` 并移除容器。产物是 `<img src="data:image/svg+xml;base64,...">`：零脚本、零外部依赖、矢量可放大。

细节与降级：

- 格式优先 **SVG**（矢量、文字清晰），失败退 **PNG**（WebGL trace 如 `scattergl` 只能栅格化）；两者都失败 → 该节点降级为**配置摘要**，并在卡片、摘要区都写明失败原因（不静默降级）。
- 配置摘要包含：图表类型、标题、X/Y 轴标题、trace 数、每个 trace 的「类型 / 名称 / **数据点个数** / 模式与参数（`mode`、`hole`、`branchvalues`、`key`、`treeDf`、`orientation` 白名单标量）」、布局键名。
- **绝不导出 trace 的数据值**：`tracePointCount()` 只数数组长度；白名单只取标量元信息。图上的数值本来就在图像里（那是图表的意义），但把原始数组再抄一遍进 HTML 既无必要又违反 §8。
- 为此给 `src/types/plotly.d.ts` 补了 `newPlot` / `toImage` 两个声明（原本只声明了 `react` / `purge`）——按项目惯例只声明用到的表面，不引 `@types/plotly.js`。

### dataFrame：漂移警告态与复跑记录摘要（验收要求）

- 漂移判定**复用 T1.2 的 `hasDrift()` / `latestRerun()`**，不在导出模块里重写规则：漂移 = `rerunHistory[0].outcome === 'drift'`。
- 漂移节点：卡片边框与状态框走 warning 色、头部有「漂移」徽标、摘要区顶部有「N 个 DataFrame 处于漂移警告态」清单（可点击跳卡片），文案明确写「**原 Manifest 未被覆盖：下方的行 × 列仍是已交付的那份结果**」——这是 T1.2 的核心语义，交付物上必须说清，否则读者会以为卡片上的数字是最新的。
- 复跑记录**全量列出**（最新在前，与画布同序）：结论、原值 → 本次值、差异摘要、失败原因、耗时、临时 DataFrame 名。附录 A 的「最近复跑」列给一行结论。
- 三种状态（漂移 / 复现一致 / 复跑失败）在样例产物里各有一个节点，加上「无 Manifest」的恢复节点，四种 dataFrame 形态都被覆盖。

## 5. 血缘图：自研层次布局，不复用 ReactFlow

`layoutLineage()` 用**最长路径分层**（`level(n) = 0` 若无入边，否则 `1 + max(level(父))`），层内按画布插入顺序纵向排列，从左到右画成内联 SVG：盒子（类型色左边条 + 标题 + 类型 + 节点 ID）、三次贝塞尔连线（源盒右侧中点 → 目标盒左侧中点）+ 箭头 marker + `<title>` 提示。每个盒子是 `<a href="#card-<id>">`（同时写 `href` 与 `xlink:href`），点一下跳到对应卡片。

取舍：

- **不复用 `@dagrejs/dagre`**（画布自动布局用它）也**不复用 ReactFlow 运行时**：导出是一次性静态渲染，几十行确定性布局换来「产物不依赖任何运行时库、验证脚本能在 Node 里直接断言坐标」。代价是没有 dagre 的边路由/避让，交叉边较多时不如画布好看——交付物里的血缘图是**示意图**，精确坐标不重要，层次与方向重要。
- **环不会死循环**：`visiting` 集合在递归里断开回边（该节点本层记 0）。画布上允许画出环，导出不能因此挂掉。
- **无效边如实计数**：端点不在画布上的悬空边、自环边被丢弃，`droppedEdges` 显示在报头「忽略的连线」里，不静默吞掉。
- 节点卡片的排列顺序 = 血缘阅读顺序（`layout.order`），所以「看图」和「读卡片」是同一个顺序。

## 6. 附录 A：每个 dataFrame 节点的 Manifest

一张总表（节点 / DataFrame / 来源 / 数据源 / 执行时间 / 行 × 列 / 结构哈希 / SQL 哈希 / 生成模型 / **权限决策 ID** / 最近复跑）+ 每个带 Manifest 的节点一个 `<details>`（完整字段 + **SQL 全文原样**）。用 `<details>` 是原生 HTML，不需要脚本，也能让附录在节点多时不至于失控。

`permissionDecisionId` 的**三态**如实展示（语义来自 T1.1/T1.3，不合并、不猜）：

| 值 | 展示 |
|----|------|
| 有值 | 该 ID；若附录 B 里有对应记录则渲染成锚点链接 `#audit-<id>`（点过去就是命令原文与决策） |
| `null` | 「未过确认门」——这次取数没有触发确认门（不带 `-o` 的加载、SQL 编辑器人工执行等） |
| `undefined` | 「—（旧节点无此字段）」——早于 T1.3 的历史 sidecar |

无 Manifest 的 dataFrame 节点（`restoreCanvas` / 数据源面板补出）**仍在表里占一行**，各列显示「—」、权限决策列显示「无 Manifest」，并在摘要区单独列出——「没有留痕」本身是必须交付出去的事实，不能因为没数据就把节点藏掉。

表头说明里写清了 T1.2 的受控例外：Manifest 只读，唯一例外是复跑结论为「一致」时刷新 `executedAt`，原始时间在复跑记录的 `before` 里。

## 7. 附录 B：权限确认记录与只读审计通道

T1.3 遗留问题①（「审计日志没有读取入口」）的建议落地：导出时带出与画布节点关联的确认记录。

### 通道：`GET /api/permission-audit?decisionIds=<id,id,...>`

选 HTTP 而不是 WS，理由与 T1.2 复跑通道一致（一次性请求-响应、不需要扩 `WSMessage` 协议、调用点也在前端服务层）；端口沿用 `http://localhost:{window.location.port + 1}`（Electron 生产模式的静态服务器不代理 `/api`，相对路径会打错地方）。

**安全边界（三条，写在路由注释里）**：

1. **只读**：整个处理只调 `readPermissionAudit()`（`readFileSync` + 逐行解析）。不写、不删、不执行任何命令，也不读数据内容——审计记录里本来就只有命令原文与决策（T1.3 的记录模型明确不记结果）。
2. **只限当前会话**：`sessionFile` 取自服务端会话单例 `getSession().sessionManager.getSessionFile()`，**请求里没有任何路径参数**，因此不存在目录穿越，也不可能读到别的会话的审计。拿不到会话文件 → `409` + 明确文案，不猜、不回退。
3. **只过滤不加工**：`decisionIds` 只用来挑选返回哪些条目（上限 200 个，R2 由 500 下调以留在 HTTP 请求行限制内），条目原样返回；缺省或过滤后为空时返回 400（R1 起不再默认全量返回；前端始终传 ID，所以实际只带出与节点关联的那些）。响应附带 `sessionId` / `sessionFile` / `total`，让报告能写明「来源哪个 sidecar、会话内共几条、带出几条」。

前端 `fetchAuditAppendix()` **任何失败都不阻断导出**：后端没起、409、500、JSON 解析失败都收敛成 `available: false` + 原因，报告里如实写「未获取到审计记录 + 原因 + 这份交付物缺少『谁批准了这次取数』的佐证」。附录 B 有四种诚实形态：有记录 / 通道不可用（含原因）/ 通道可读但匹配不到（给出可能原因）/ 没有任何节点过确认门（说明为什么）。**绝不静默省略章节**。

### 展示与解析

- 表列：时间 / 类型 / 决策 / 来源 / decisionId / 耗时 / 命令（改前）/ 改后命令 / 备注·闸门 / 关联节点。
- 「来源」是审计的核心列（T1.3）：用户 / 全局放行（自动）/ 超时自动拒绝 / 中止自动拒绝 / 会话重置自动拒绝——`deny` 只说明没执行，`source` 才说明是谁决定的。
- 长命令折进 `<details>`（短的直接 `<pre>`），避免一条多行 SQL 把表格撑爆；改前/改后命令都带出（`edit` 决策的取证价值就在这里）。
- 同一 `decisionId` 的「请求 + 决策」两条记录都渲染，但**锚点只给第一条**（否则 HTML 里出现重复 id）。
- 关联节点由前端用 `manifest.permissionDecisionId` 反查，能从审计记录点回节点卡片。
- **`parseAuditEntries()` 是白名单解析器**：只挑已知字段（`type/at/decisionId/sessionId/command/editedCommand/reason/decision/source/gate/followsDecisionId/elapsedMs/v/acceptAll/pendingAffected`），未知字段丢弃、坏行（缺 `type` 或 `decisionId`、非对象）跳过——准入规则与服务端 `parsePermissionAuditLine()` 一致。

### 为什么前端不直接 import 服务端的审计类型

线格式的真源是 `server/permission-audit.ts` 的 `PermissionAuditEntry`。前端不 import 它，两个原因：(1) `src/` 反向依赖 `server/` 会把 `node:fs` 拖进 app 的 tsconfig；(2) HTTP JSON 本来就需要在边界上校验一次（服务端与打包后的前端可能版本错配）。所以用 `AuditEntryView` + 白名单解析器，而不是 `as` 强转。**取舍代价**：字段名在两边各写一次，服务端新增字段时前端要同步（验证脚本对解析器有断言，漏改会红）。

## 8. 不导出什么（数据内容纪律）

- **不导出 `node.data.previewData`**：那是打开预览面板时从 `/api/preview` 拉的数据行。交付报告要的是「这个数怎么来的、可不可复现、谁批准的」，不是数据本身；把数据行抄进 HTML 等于绕过「非必要不读取数据内容」的纪律，还会让文件体积随行数膨胀。验证脚本用哨兵值断言 previewData 不出现在产物里。
- **不导出 chart trace 的原始数组**（见 §4）。
- **不调用任何取数通道**：导出过程不产生新的 `observe load`、不触发确认门、不进 transcript，因此也不会给审计日志添新条目。

导出文件里出现的所有「数字」只有：行数/列数/Non-Null 计数、校验和哈希、耗时、数据点个数、报告正文里助手自己写的数值。

## 9. 转义、确定性与产物安全

- **全量转义**：`esc()` 覆盖 `& < > " '`，所有来自节点与审计的字符串（表名、字段说明、SQL、报告正文、命令原文、错误信息）都过它；只有本模块自己生成的标签与已转义内容是原样拼接。`kv()` / `table()` 的契约写明「值由调用方负责转义」。验证脚本用 `<script>alert('xss')</script>` 哨兵断言：产物里没有 `<script`，且哨兵以 `&lt;script&gt;` 形式出现在表说明、报告正文与审计命令三处。
- **确定性**：`buildDeliveryReportHtml` 不读时钟；千分位用手写正则而不是 `toLocaleString()`（ICU 随环境变化会破坏逐字节可复现）。同一输入两次调用产物完全相同（脚本断言），因此样例产物 `sample-export.html` 是可复跑的固定证据。
- **文件名**：`govio-delivery-report-YYYYMMDD-HHmm.html`（本地时区）。
- **下载**：Blob + `a[download]`，`setTimeout` 4s 后 `revokeObjectURL`（立即 revoke 在部分浏览器会取消下载），与既有 `export-session.ts` 同一套机制。
- **空画布**：工具栏按钮禁用（`title` 说明原因）；`exportCanvasDeliveryReport` 也会抛「画布为空」，`buildDeliveryReportHtml` 对空画布仍产出合法 HTML（各章节写「画布为空」）。

## 10. 验证

新增 `scripts/verify-export-report.ts`（`npm run verify:export`，**116 项断言**，失败退出码 1）。构造一个含全部五类节点的样例画布（2 张源表 / 1 个 sqlQuery / 4 个 dataFrame 覆盖漂移·失败·一致·无留痕 / 2 个 chart 覆盖成功·降级 / 1 个 diff 报告，9 条有效血缘边 + 1 条悬空边 + 1 条自环），直接调用纯函数产出 HTML 并逐节断言；产物写到 `docs/tasks/T1.4-canvas-export/sample-export.html`（43,877 字节，可双击离线打开人工复核）。不调 govio-cli、不调模型、不读数据内容、不碰 `.govio/`。详见 `verification.md`。

## 11. 遗留问题

1. **导出模块偏大**（`export-report.ts` 约 1500 行）：结构/内容渲染 + 浏览器侧副作用都在一个文件里，靠 8 个分节注释维持可发现性。若后续要加导出格式（PDF/Markdown）或更多附录，应先把「渲染」与「浏览器侧（Plotly/下载/fetch）」拆成两个文件。
2. **report / chart 节点没有 Manifest**（T1.1 遗留问题 5）：附录 A 只覆盖 dataFrame，所以报告与图表的「谁生成、基于哪份数据」只能靠血缘边与卡片上的 `sourceDf` 推断。补法是先给这两类节点落留痕，再在附录 A 加一段。
3. **图表静态渲染依赖浏览器与 Plotly 的导出能力**：`scattergl` 等 WebGL trace 只能退 PNG（栅格）；离屏容器在某些浏览器缩放/打印场景下可能量不到尺寸而失败——已降级为配置摘要并写明原因，但没有重试或「在画布上就地截图」的备选路径。Electron 生产模式下未做真机冒烟（见 `verification.md` 的人工验证小节）。
4. **审计通道沿用既有 `/api/*` 的 CORS 姿态**（`Access-Control-Allow-Origin: *`，与 `/api/preview`、`/api/rerun-dataframe` 一致）。这意味着本机浏览器里的其他页面理论上能读当前会话的确认记录（命令原文含 SQL，不含数据结果）。收紧（同源校验 / `Sec-Fetch-Site` / token）属于 X1 安全基线，本任务不单独给一个端点开特例，避免造成「只有一个端点安全」的错觉。
5. **`permission_mode`（Accept All 开关变更）事件不进附录 B**：前端按节点引用的 `decisionId` 过滤，而模式事件用 `pm-` 前缀、不与任何节点关联。因此「这段取数发生在全局放行期间」这个上下文在交付物里只能从每条记录的 `source: 全局放行（自动）` 间接看出。若要显式带出，需要在前端多请求一次「本会话模式事件」，属于产品决策。
6. **导出不会主动触发画布保存**：附录 A/B 全部来自前端 store 的当前状态，所以刚产生的节点也能导出（不依赖 sidecar 落盘）；但**审计通道读的是服务端会话**，若用户刚切了会话而画布还是旧的，附录 A 的 `permissionDecisionId` 可能在新会话审计里匹配不到——此时附录 B 走「通道可读但匹配不到记录」分支并给出可能原因，不会静默出错。
7. **没有「导出选中节点/子图」能力**：一次导出整个画布。大画布（几百节点）会产出一个很长的 HTML；血缘图靠 `overflow:auto` 横向滚动，卡片靠响应式网格排列，但没有分页或分章拆文件。
8. **表格类内容有 200 行上限**（`MAX_TABLE_ROWS`，字段表与列结构表）：超出时写明「仅列出前 200 个」。宽表（几百列）会被截断，这是文件体积与信息完整性的折中；若业务上需要全量，应改为「结构附录单独成节 + 折叠」。
9. **JSON 快照导出（`/export` 命令）与本交付报告并存但没有互相引用**：一个给机器、一个给人。若后续要做「从交付报告反查画布状态」，需要在 HTML 里嵌一份压缩的 JSON（会显著增大文件），或在 JSON 导出里带上报告文件名。
