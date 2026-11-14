# X18 · verification.md（验证命令与关键输出）

环境：Orca worktree `x18-semantic-badges`，分支 `chenxinma/x18-semantic-badges`，Node v24.16.0，Windows。
`.agents/` 已按任务书第一步从主仓拷入（`cp -r /d/Work/gov-io/govio-map/.agents ./`，349K）。

> **沙箱说明**：Codex 沙箱内 `os.userInfo()` 抛 `ERR_SYSTEM_ERROR (uv_os_get_passwd ENOMEM)`，
> `tsx` 启动即失败，故所有 `npm run *` 门槛都在沙箱外（escalated）执行；命令与输出如下，未做任何改写。

## 1. 三道门槛

| 命令 | 结果 | 关键输出 |
|---|---|---|
| `npm run build` | **exit 0** | `tsc -b` 无错；`✓ built in 14.15s`；`dist-server\cli.mjs 159.4kb`（chunk 体积告警为既有现象，非本任务引入） |
| `npm run lint` | **exit 0** | `> eslint .` 无任何输出（0 error / 0 warning） |
| `npm run verify` | **exit 0** | 11 个子命令全绿，逐项断言数见 §2 |

## 2. 断言数变化（基线 → 现状，零回归）

### 验证脚本：**624 → 639**（+15）

| 脚本 | 基线 | 现状 | 变化 |
|---|---|---|---|
| `verify:manifest` | 92 | 92 | — |
| `verify:rerun` | 71 | 71 | — |
| `verify:audit` | 119 | 119 | — |
| `verify:export` | 138 | **147** | **+9**（新增 `[3c]` 小节） |
| `verify:source-table` | 39 | 39 | — |
| `verify:semantic-lineage` | 48 | **54** | **+6**（新增 `[7]` 小节） |
| `verify:caliber-conflict` | 46 | 46 | `46/46 checks passed` |
| `verify:cwd` | 13 | 13 | — |
| `verify:prompt-injection` | 58 | 58 | `58/58 通过` |
| 合计 | **624** | **639** | **+15** |

`verify:export` 新增 9 条（逐项）：口径引用小节计数只算可展示徽标（4）／Metric 排在 Dimension 前／
code 缺失回落 name／code+name 都缺整条跳过（图谱 ID 不进产物）／重复注入只渲染一条／注入内容被转义／
无 `semanticRefs` 整节不渲染／refs 只有 Col 整节不渲染／新增内容不破坏自包含。

`verify:semantic-lineage` 新增 6 条（逐项）：Metric 产出徽标且 Col 跳过／hover 全文逐字（类型+编码+名称+图谱 ID）／
Metric 优先 + name 回退 + 非指标前缀类型名／重复注入去重／空入参 → `[]`／导出 HTML 同步渲染「口径引用（1）」。

关键输出摘录：

```
[3c] 口径引用（X18，PD-1 方案 1）：sqlQuery 卡片渲染 semanticRefs
  ✓ X18：口径引用小节进卡片，计数只算可展示徽标（4 条：3 指标 + 1 维度）
  ✓ X18：Metric 排在 Dimension 前（表格行序 = 画布徽标序）
  ✓ X18：code 缺失时回落 name 呈现
  ✓ X18：code/name 都缺的引用整条跳过（图谱 ID 也不进产物）
  ✓ X18：同一实体重复注入只渲染一条（去重口径与语义边一致）
  ✓ X18：口径引用里的注入内容被转义（不变成脚本）
  ✓ X18：无 semanticRefs 的 SQL 节点不渲染口径小节（不留空壳行）
  ✓ X18：refs 只有无短名的 Col 时同样整节不渲染
  ✓ X18：新增内容不破坏自包含（无 script、无外部引用）
共 147 项断言，失败 0 项

[7] X18 口径徽标：同一份 semanticRefs 在画布与导出都可见
  ✓ 徽标取值：Metric 产出徽标（code 优先），Col 无 code/name 整条跳过
  ✓ 徽标 hover 全文含类型 / 编码 / 名称 / 图谱 ID（多行，缺项省略）
  ✓ Metric 优先排序 + code 缺失回落 name（非指标前缀类型名）
  ✓ 同一实体重复注入只留一条（去重口径与语义边一致）
  ✓ 无 semanticRefs / 空数组 → 徽标为空（整节不渲染的前提）
  ✓ 导出 HTML 同步渲染口径引用（计数只算可展示徽标，Col 不进产物）
共 54 项断言，失败 0 项
```

### vitest：**15 文件 194 例 → 16 文件 219 例**（+1 文件 / +25 例）

```
> npm run verify:integration
 Test Files  16 passed (16)
      Tests  219 passed (219)
```

- 新增文件 `tests/integration/semantic-refs-ui.test.ts`：**19 例**（展示模型边界穷举）
- `tests/ui/sql-query-node.test.tsx`：**+6 例**（既有 2 例零回归）

### UI 子集：**4 文件 31 例 → 4 文件 37 例**（+6 例）

```
> npm run verify:ui
 Test Files  4 passed (4)
      Tests  37 passed (37)
```

新增 6 例（逐项）：「口径」小节渲染（指标 code 优先 + 维度带类型前缀 + 计数）／hover title 四项完整信息／
code 缺失回落 name + code/name 都缺跳过且无 `undefined` 文案／无 `semanticRefs` 整节不渲染／
超 3 条默认折叠 + `+2 more refs` 展开 + `Collapse` 收起／与 T2.3 口径警示共存（警示文档顺序在前、
徽标无内联色值、徽标用 token class、警示黄未被改写）。

### 工作树洁净

`npm run verify` 全跑后：

```
$ git status --porcelain
 M docs/PENDING-DISCUSSION.md
 M docs/USER-MANUAL.md
 M docs/demo/video-script-chocolate.md
 M docs/specs/02-nodes.md
 M scripts/verify-export-report.ts
 M scripts/verify-semantic-lineage.ts
 M src/components/Nodes/SQLQueryNode.tsx
 M src/utils/export-report.ts
 M tests/ui/sql-query-node.test.tsx
?? src/utils/semantic-refs-ui.ts
?? tests/integration/semantic-refs-ui.test.ts
```

全部是本任务的预期改动，**无验证产物残留**（`verify:export` 只写系统临时目录；受跟踪样例
`docs/tasks/T1.4-canvas-export/sample-export.html` 未被改写，脚本自带断言「默认运行不改写受跟踪样例」仍绿）。

## 3. 人工目视（文字描述 + 真实渲染 DOM 取证）

**取证方式**：本 worktree 无显示环境、未装 `govio-cli`，无法起 `npm run dev` 截图。改为在 jsdom 里
用**真实数据形态**渲染 `SQLQueryNode`（chocolate 场景：`m_sales_amount` / `m_order_count` 两个指标 +
`country` / `channel` 两个维度 + 一条无 code/name 的 Col，并叠加 T2.3 `conflict` 警示），
把 `document.body.innerHTML` 落盘核对（临时用例用后已删除，工作树无残留）。

**看到的效果（对照 DOM 逐条核对）**：

1. **标题行**：节点标题「Q: 2023 各国销售额（偏离口径）」在左，右上角仍是 T2.3 的黄色「⚠ 口径冲突」
   徽标（内联 `color: rgb(245, 155, 35)` = `#F59B23`，取自 `caliberNodeAppearance`）——警示位置与配色**未变**。
2. **SQL 正文**下方出现一节新的「**口径**」小节：左侧 `Tag` 图标 + 小节名「口径」，右侧灰色计数「4」
   （= 可展示徽标数，Col 不计入）。
3. **徽标行**：紫色（`bg-node-source/10 text-node-source`）等宽字体胶囊，依次为
   `m_sales_amount`、`m_order_count`、`维度·country`——**指标排在最前且只显示短名，维度带「维度·」前缀**，
   一眼可辨「哪个是指标」。第 4 条 `维度·channel` 被折叠。
4. **折叠行**：徽标下方一行灰色小字「⌄ +1 more refs」（与字段区 `+N more fields`、关系小节
   `+N more relations` 同一视觉语言）；点开后 4 条全显并变成「⌃ Collapse」（该交互由 UI 用例断言）。
5. **hover**：鼠标停在 `m_sales_amount` 上，浏览器原生 tooltip 分四行显示
   「类型：指标 / 编码：m_sales_amount / 名称：销售额 / 图谱 ID：m_sales_amount」——**中文名在 hover 里可见**
   （画布上显示 code 是契约 `code ?? name` 的结果，见 design.md §3.3 与遗留 1）。
6. **无口径的节点**（旧节点 / 手动建的 SQL 节点 / 只注入 Col）：整节消失，卡片从 SQL 正文直接接「输出列」，
   **没有空壳行、没有计数 0、没有 `undefined` 文案**（UI 用例 + 导出脚本双向断言）。
7. **导出 HTML**：sqlQuery 卡片在「输出列」之后多出「**口径引用（4）**」表，四列
   类型 / 编码 / 名称 / 图谱 ID，中文名直接成列呈现（静态交付物无 hover）。

**取证的真实 DOM 片段**（jsdom 输出，`Tag` 图标的 `<svg>` 已省略）：

```html
<span class="text-[10px] font-mono uppercase tracking-[1.2px] text-text-muted">口径</span>
<span class="ml-auto text-[10px] font-mono text-text-dim">4</span>
...
<div class="flex flex-wrap gap-1">
  <span title="类型：指标&#10;编码：m_sales_amount&#10;名称：销售额&#10;图谱 ID：m_sales_amount"
        class="max-w-full truncate text-[11px] px-1.5 py-0.5 rounded bg-node-source/10 text-node-source font-mono">m_sales_amount</span>
  <span title="类型：指标&#10;编码：m_order_count&#10;名称：订单数&#10;图谱 ID：m_order_count"
        class="max-w-full truncate text-[11px] px-1.5 py-0.5 rounded bg-node-source/10 text-node-source font-mono">m_order_count</span>
  <span title="类型：维度&#10;编码：country&#10;名称：国家&#10;图谱 ID：d_country"
        class="max-w-full truncate text-[11px] px-1.5 py-0.5 rounded bg-node-source/10 text-node-source font-mono">维度·country</span>
</div>
<button class="flex items-center gap-1 text-[11px] text-text-muted hover:text-brand transition-colors mt-1">
  <svg class="lucide lucide-chevron-down" ...></svg>
  <span>+1 more refs</span>
</button>
```

（原始输出里 `title` 是真换行，此处为排版改成 `&#10;`；徽标本身**没有任何 `style` 内联属性**，
配色全部来自 token class——UI 用例 `expect(chip.getAttribute("style")).toBeNull()` 钉住这一点。）

**建议主会话补一步**：PR 复核时 `npm run dev`，让 agent 生成一条引用指标的 SQL，肉眼确认徽标在画布上的
观感（紫色胶囊 + 折叠 + hover），并按需截图归档到本目录。

## 4. 复跑命令

```bash
npm run build
npm run lint
npm run verify                                        # 全量（11 个子命令）
npm run verify:export                                 # 147 项
npm run verify:semantic-lineage                       # 54 项
npx vitest run tests/integration/semantic-refs-ui.test.ts tests/ui/sql-query-node.test.tsx
```
