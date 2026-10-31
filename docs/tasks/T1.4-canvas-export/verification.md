# T1.4 验证记录

环境：Windows Git Bash · 项目根 `D:/work/gov-io/govio-map` · 分支 `feature/phase1-trusted-analysis` · Node 项目 `govio-map@0.6.1`
执行时间：2026-10-31

## 0. 结论速览

| 门槛 | 结果 |
|------|------|
| `npm run build` | **通过**（`tsc -b` + `vite build`，2465 modules，2.07s） |
| `npm run lint` | **通过**（0 error / 0 warning，无输出） |
| `npm run verify:export`（本任务新增） | **通过**（116 项断言，失败 0） |
| `npm run verify:manifest`（T1.1 回归） | **通过**（52 项，失败 0） |
| `npm run verify:rerun`（T1.2 回归） | **通过**（62 项，失败 0） |
| `npm run verify:audit`（T1.3 回归） | **通过**（86 项，失败 0） |
| 样例产物落盘 | `docs/tasks/T1.4-canvas-export/sample-export.html`（43,877 字节，两次运行逐字节一致） |
| 浏览器/Electron 人工冒烟 | **待执行**（见 §6，附步骤）——自动化断言只覆盖产物结构与内容，视觉可读性、真实 Plotly 渲染、真实下载对话框需要人工确认 |

## 1. `npm run build`（通过）

```
$ npm run build
> tsc -b && vite build
✓ 2465 modules transformed.
dist/index.html                            0.79 kB │ gzip:     0.42 kB
dist/assets/index-fb6Qk2D-.css            51.25 kB │ gzip:     9.55 kB
dist/assets/export-report-CTwTUGeG.js     40.38 kB │ gzip:    15.01 kB   ← 导出模块独立 chunk（动态 import 生效）
dist/assets/index-BdXk-HmH.js          6,069.33 kB │ gzip: 1,860.78 kB
✓ built in 2.07s
```

两个关键读数：

- **懒加载确实生效**：`export-report.ts` + `export-report-style.ts` 被拆成独立 chunk（40.38 kB / gzip 15.01 kB），不在主 bundle 里；主 bundle 从 T1.3 的 6,065.50 kB 变为 6,069.33 kB（+3.83 kB，即工具栏按钮那几行）。
- 主 bundle 的体积告警是**既有问题**（plotly 全量打包，见 X3 / T1.3 verification.md），本任务未引入新依赖，也未改变它。
- `tsc -b` 经 `vite.config.ts → server/index.ts` 覆盖 `server/parquet-api.ts`（新路由）；`tsconfig.app` 覆盖 `src/` 全部新增与修改文件。

## 2. `npm run lint`（通过）

```
$ npm run lint
> eslint .
（无输出 = 0 error / 0 warning，退出码 0）
```

## 3. 主验证：`npm run verify:export`（116 项断言全通过）

新增脚本 `scripts/verify-export-report.ts`，可反复执行，任一断言失败退出码 1。不调 govio-cli、不调模型、不读任何数据内容、不碰 `.govio/`。

### 样例画布（含全部五类节点 + 四种 dataFrame 形态）

| 节点 | 类型 | 关键状态 |
|------|------|----------|
| `src-1` orders / `src-2` customers | sourceTable | 4 / 3 个字段，含 PK、`FK→customers.id`、中文说明；`src-1` 的说明里埋 `<script>alert('xss')</script>` 哨兵 |
| `gov-1` 月度销售额汇总 SQL | sqlQuery | 7 行 SQL（含 `--` 注释、`<`、单引号、中文列名）+ 3 个输出列 + `assistant-sql` 留痕（`permissionDecisionId: null`） |
| `gov-2` df_monthly_sales | dataFrame | **漂移态**：`rerunHistory = [drift, identical]`，Manifest 带 `permissionDecisionId = pd-1111aaaa-2222`、checksum、`responseModel`；`previewData` 里埋数据行哨兵 |
| `gov-3` df_region_top | dataFrame | `--memory` 派生（`datasource: memory`、`sourceDataFrames`），**复跑失败态**（上游已释放），`permissionDecisionId: null` |
| `gov-4` df_legacy_restored | dataFrame | **无 Manifest / 无复跑记录**（restoreCanvas 路径） |
| `gov-8` df_channel_check | dataFrame | **复现一致态**，`sql-editor` 留痕（无模型 → `—（人工执行）`） |
| `gov-5` 月度销售额柱状图 | chart | 渲染**成功**（内联 data URL 图片） |
| `gov-6` 区域占比饼图 | chart | 渲染**失败** → 降级为配置摘要（原因写明） |
| `gov-7` 9 月 vs 10 月差异分析 | report | diff 类型，正文含 `##/###` 标题、`-`/`1.` 列表、`| 表格 |`、`**粗体**`、`` `code` ``、XSS 哨兵 |
| 血缘 | — | 9 条有效边（`src-1/src-2 → gov-1 → gov-2/gov-8 → gov-3/gov-5 → gov-6/gov-7`）+ 1 条悬空边 + 1 条自环 |
| 审计 | — | 模拟 `GET /api/permission-audit` 返回 6 条（请求、`edit` 决策含改前/改后命令、超时 `deny`、模式变更、1 条缺 decisionId 的坏行、1 条非对象），并夹带一个非白名单字段 |

### 分节断言数

```
$ npm run verify:export
> tsx scripts/verify-export-report.ts

[1] 产物结构：自包含、离线可打开          18 项
[2] 血缘图：层次布局与 SVG                19 项
[3] 节点卡片：五类静态快照                16 项
[4] 漂移告警与复跑记录                    14 项
[5] 附录 A：DataFrame Manifest            15 项
[6] 附录 B：权限确认记录（只读通道）      23 项
[7] 转义、确定性与样例产物                11 项

共 116 项断言，失败 0 项
样例交付报告：D:\Work\gov-io\govio-map\docs\tasks\T1.4-canvas-export\sample-export.html（双击可在浏览器离线打开）
PASS: 交付报告自包含、含五类节点与血缘图、附录 A/B 齐全、漂移有警示、内容全部转义
```

### 各节覆盖要点（择要）

**[1] 自包含 / 离线**：`<!DOCTYPE html>` 开头、`lang="zh-CN"` + UTF-8、样式内联在 `<style>`；**不含** `<script>` / `<link>` / `@import` / `http(s)://` 外部引用（先剥掉 SVG 命名空间声明再查）/ 协议相对 `//` / `<iframe>|<object>|<embed>`；`<img>` 只允许 `data:` URL；报头含导出时间（本地可读格式 + ISO 原文）与应用版本；五个章节 id 与目录锚点齐全；含 `@media print`；页脚声明「不含数据行内容」。

**[2] 血缘图**：10 个盒子 / 9 条边 / `droppedEdges === 2`（悬空边 + 自环）；层次断言（源表 0 层、SQL 1 层、df_monthly_sales 2 层、派生 DF 与图表 3 层、依赖两个上游的报告 4 层、无血缘的恢复节点停在 0 层）；同层按画布插入顺序纵向排列、层次越深 x 越大；画布尺寸 = 5 层 × 最多 3 行的精确值（`1474 × 248`）；阅读顺序覆盖全部节点且不重复；SVG 里边数与 `marker-end` 数一致、盒子数与 `#card-*` 锚点数一致；自环不会让递归死循环。

**[3] 五类卡片**：sourceTable 的表名/行数(`128,450`)/字段表/`PK`/`FK→customers.id`；sqlQuery 的 SQL 全文与输出列；dataFrame 的列结构（列名 + Non-Null + dtype）与行×列/内存；report 的 markdown 渲染结果（`<div class="h2">结论</div>`、`<strong>总销售额</strong>`、`<td>+20%</td>`、列表）与对比对象；chart 成功时内联 `<img class="chart" src="data:...">` 并标注「静态、不可交互」，失败时降级并写明原因、给出 trace 摘要；**图表原始数据值（哨兵 424242）不出现在产物里**；卡片带上下游链接、创建时间与节点 ID；10 张卡片；摘要区统计（节点 10 / 连线 9 / DataFrame 4）。

**[4] 漂移与复跑**：漂移卡片带 `class="card drift"` 与「漂移」徽标、警示框给出差异摘要（`行数 12 → 13（+1）；结构哈希变化`）与复跑时间、文案写明「原 Manifest 未被覆盖」；一致节点有绿色徽标与结论框（`6 行 × 2 列，校验和与原留痕一致`）；失败节点有独立告警与原因；摘要区列出漂移清单并统计复跑次数 4；复跑记录最新在前编号（`#1 … · 漂移`、`#2 … · 复现一致`）、含原值 → 本次值对比、耗时、临时 DF 名；未复跑过的节点如实说明；**漂移节点卡片上的行×列仍是已交付的 `12 × 3`，不是新值 `13 × 3`**。

**[5] 附录 A**：说明「共 4 个 dataFrame 节点，其中 3 个带 Manifest」；表格行数 = dataFrame 节点数（4，含无 Manifest 的那个）；含 `permissionDecisionId` 列，且该 ID 渲染成指向附录 B 的锚点；`null` → 「未过确认门」；无 Manifest → 「无 Manifest」；含来源/数据源/执行时间/行×列/两段哈希与算法/生成模型（`anthropic / claude-sonnet-4-5 → claude-sonnet-4-5-20250929`）/会话 ID；SQL 全文折在 `<details id="manifest-gov-2">` 里且原样保留（含注释行）；标注「是否可一键复跑」；人工执行的留痕显示 `—（人工执行）`；无 Manifest 的节点不产生 SQL 详情块。

**[6] 附录 B**：写明来源 sidecar 路径（`….jsonl.audit.jsonl`）与会话 ID、「会话内共 6 条 / 带出 4 条 / 按 1 个 decisionId 过滤」；请求与决策两条都在；`edit` → 「修改后放行」、改前与改后命令都带出、决策备注带出；`source` 翻译成「用户」「超时自动拒绝」；闸门信息与 `elapsedMs`（`4.2s`）；记录可跳回关联节点；**同 decisionId 的锚点只出现一次**；长命令折进 `<details>`；白名单解析丢掉未知字段与坏行（6 → 4 条），保留 `v`/`acceptAll`/`pendingAffected`；模式事件能渲染且备注不重复；声明「不含任何查询结果」；`collectPermissionDecisionIds` 去重且跳过 null；**四种降级形态**（未尝试获取 / 通道不可用含原因与影响说明 / 没有节点过确认门 / 通道可读但匹配不到）都如实渲染，且审计不可用时 `permissionDecisionId` 不再是死链。

**[7] 转义 / 确定性 / 产物**：`<script>alert('xss')</script>` 哨兵在表说明、报告正文、审计命令三处都以 `&lt;script&gt;…` 形式出现，产物里没有 `<script`；SQL 里的 `<` 与单引号被转义；**`previewData` 的数据行哨兵不出现在产物里**；空画布仍产出合法 HTML；同输入两次调用逐字节相同；文件名形如 `govio-delivery-report-YYYYMMDD-HHmm.html`；`tracePointCount` 只数长度；样例产物落盘且与内存产物一致、体积 < 200 KB、剥掉命名空间后无任何外部引用。

### 确定性复核（同一命令跑两次，产物逐字节一致）

注：R1 审查后默认运行**不再落盘**受跟踪样例（避免非 UTC+8 机器把产物改脏）；
重新生成需显式追加 `-- --write`，因此确定性复核改为连续两次 `--write` 后比对：

```
$ npm run verify:export -- --write   # 第一次：重新生成受跟踪样例
$ cp docs/tasks/T1.4-canvas-export/sample-export.html /tmp/sample-a.html
$ npm run verify:export -- --write   # 第二次
$ cmp /tmp/sample-a.html docs/tasks/T1.4-canvas-export/sample-export.html && echo identical=yes
identical=yes
```

脚本钉住 `TZ=Asia/Shanghai` 且导出时间为固定输入，逐字节一致不再依赖机器时区；
默认运行（不带 `--write`）只写系统临时目录并断言受跟踪样例未被改写，跑完 `git status --porcelain` 应为空。

## 4. 回归：T1.1 / T1.2 / T1.3 验证脚本

```
$ npm run verify:manifest   → 共 52 项断言，失败 0 项 / PASS: Manifest 往返无丢失
$ npm run verify:rerun      → 共 62 项断言，失败 0 项 / PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
$ npm run verify:audit      → 共 86 项断言，失败 0 项 / PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID
```

三者与改动前一致（52 / 62 / 86）。本任务对 T1.1–T1.3 代码的触碰只有「措辞常量下沉」：`ManifestDetails.tsx` 与 `RerunStatus.tsx` 改从共享常量取标签（展示文本逐字不变），`src/types/manifest.ts` / `src/types/rerun.ts` / `server/permission-audit.ts` / `server/permission-manager.ts` / `src/store/canvas-store.ts` 一行未改。

## 5. 样例产物的独立复核（不依赖验证脚本的断言）

对 `docs/tasks/T1.4-canvas-export/sample-export.html` 直接用 grep / 结构检查取证：

```
$ grep -o 'src="http[^"]*\|href="http[^"]*\|<script\|<link\|@import' sample-export.html | sort -u
（无输出 = 没有任何外部资源引用与脚本）

$ grep -o '<article class="card' … | wc -l   → 10     # 十张节点卡片
$ grep -o '<rect class="box"'    … | wc -l   → 10     # 血缘图十个盒子
$ grep -o '<path d="M '          … | wc -l   → 9      # 九条血缘连线
$ grep -o 'pd-1111aaaa-2222'     … | wc -l   → 9      # 决策 ID 在卡片/附录 A/附录 B 之间互链
$ grep -o 'badge drift'          … | wc -l   → 2      # 漂移徽标（卡片头部 + 附录 A 最近复跑列）
$ 五类节点徽标：数据源表 / SQL 查询 / DataFrame / 分析报告 / 图表 均出现
```

HTML 结构完整性（标签配平，用一次性 Node 脚本，void 元素与自闭合标签除外）：

```
未闭合栈: []          错配数: 0
结尾: "ooter>\n</div>\n</body>\n</html>\n"
details/summary 配对: 4 4 4 4        table 配对: 10 10
tr: 34 个 <tr> / 37 个 </tr>   ← 差值 3 = 三条带锚点的 <tr id="audit-…">，属正常
```

产物摘要：43,877 字节 / 208 行 / 10 节点 / 9 连线 / 4 个 dataFrame（漂移·失败·一致·无留痕各一）/ 2 个 chart（1 图像 + 1 降级）/ 4 条确认记录。

## 6. 待人工执行的冒烟（自动化覆盖不到的部分）

自动化断言只能证明**产物结构与内容**正确；下面四项需要真实运行环境，本任务未执行，请在 dev 环境按步骤复核：

1. **视觉可读性**：双击打开 `docs/tasks/T1.4-canvas-export/sample-export.html`，确认卡片网格、血缘图、两张附录表在 1280px 宽度下不重叠、不溢出；再试浏览器「打印 → 另存为 PDF」看 `@media print` 效果。
2. **真实 chart 静态渲染**：`npm run dev` → 让 agent 生成一个图表节点 → 点工具栏「导出交付报告」→ 打开产物确认图表是内联 SVG（不是配置摘要），并确认导出过程中画布没有可见闪烁（离屏容器在 `left:-100000px`）。
3. **真实审计通道**：跑一条带 `-o` 的 `observe load` 并在确认门上点「修改后放行」→ 导出 → 确认附录 B 出现该次确认的请求/决策两条记录、命令改前改后都在、`来源 = 用户`，且从附录 A 的决策 ID 能跳到那一行。再验证降级：停掉后端（或断网）导出，确认附录 B 显示「未获取到审计记录 + 原因」而其余章节完好。
4. **下载行为**：Chrome/Edge 下确认文件落到下载目录且文件名形如 `govio-delivery-report-YYYYMMDD-HHmm.html`；Electron 打包版（`npm run build:electron`）确认 `<a download>` + Blob 触发系统保存对话框（`electron/main.ts` 没有 `will-download` 处理器，走 Electron 默认行为）。

## 7. 验收标准照单自检

| 验收标准 | 结果 | 证据 |
|----------|------|------|
| 导出 HTML 离线可打开、布局可读、含全部五类节点与血缘图 | **结构层面通过**（视觉待人工，见 §6.1） | §3[1] 18 项 + §3[2] 19 项 + §3[3] 16 项；§5 grep 无外部引用、10 卡片 / 10 盒子 / 9 连线、标签配平 0 错配 |
| 附录含 dataFrame 节点 Manifest；漂移节点有警示标记 | **通过** | §3[5] 15 项（含 `permissionDecisionId` 三态与锚点互链）+ §3[4] 14 项（卡片徽标/警示框/摘要清单/附录 A 徽标）；§5 `pd-…` 出现 9 次、`badge drift` 2 处 |
| `npm run build` 通过 | **通过** | §1（并证明导出模块被拆成独立 chunk） |
| `npm run lint` 0 error | **通过** | §2 |
| 实际构造含多类节点的样例画布导出并验证 | **通过** | §3 样例画布表（五类节点 + 四种 dataFrame 形态 + 两种 chart 结局）→ `sample-export.html`；§3 末尾两次运行逐字节一致 |
| 既有验证无回归（52 / 62 / 86） | **通过** | §4 |
| 只消费画布 store 数据 + 只读审计通道，不做其他数据采集 | **通过** | 代码层面：导出模块只有 `useCanvasStore.getState()`（工具栏）与 `GET /api/permission-audit` 两个数据入口，无 parquet/CLI/模型调用；§3[7] 断言 `previewData` 哨兵不进产物；§3[6] 断言审计通道失败不阻断 |
| 三件套交付物 + design.md 含取舍与遗留问题 | **通过** | `docs/tasks/T1.4-canvas-export/{design.md, CHANGES.md, verification.md}`；design.md §2–§9 为取舍、§11 为 11 项遗留问题（含只读通道的安全边界 §7） |
