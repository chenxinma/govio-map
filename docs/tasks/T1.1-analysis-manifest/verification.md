# T1.1 验证记录

环境：Windows Git Bash · Node 项目根 `D:/work/gov-io/govio-map` · 分支 `feature/phase1-trusted-analysis`
执行时间：2026-10-30

## 1. 门槛：`npm run build`（通过）

```
$ npm run build
> tsc -b && vite build
vite v8.3.3 building client environment for production...
✓ 2459 modules transformed.
dist/index.html                     0.79 kB │ gzip:     0.42 kB
dist/assets/index-DbnQaXcy.css     50.46 kB │ gzip:     9.43 kB
dist/assets/index-LHEKUd8R.js   6,058.97 kB │ gzip: 1,857.06 kB
✓ built in 1.97s
```

`tsc -b` 经 `vite.config.ts → server/index.ts` 传递覆盖全部 server 改动文件（`analysis-manifest.ts`、`extensions/govio-canvas.ts`、`parquet-api.ts`、`govio-node-queue.ts`），无类型错误。强制全量重跑同样通过：

```
$ npx tsc -b --force     # 退出码 0，无输出
```

（`npx tsc -p tsconfig.electron.json` 的 `server/cli.ts:81` 报错为 main 上既有问题，与本任务无关，按任务书忽略。）

## 2. `npm run lint`（通过）

```
$ npm run lint
> eslint .
（无输出 = 0 error / 0 warning）
```

开发过程中曾被 lint 拦下一处 `no-useless-assignment`（`piSessionContext` 里的 `let sessionId = ""`），已重构为 `readSessionId()` 后清零。

## 3. 主验证：`npm run verify:manifest`（52 项断言全通过）

新增脚本 `scripts/verify-manifest-roundtrip.ts`，可反复执行，任一断言失败退出码 1。

```
$ npm run verify:manifest
> tsx scripts/verify-manifest-roundtrip.ts

[1] buildManifest 字段完整性
  ✓ schemaVersion 为当前版本
  ✓ SQL 全文原样保留
  ✓ datasource / dfName / origin
  ✓ 执行时间 ISO
  ✓ 行数/列数
  ✓ 校验和存在且为 schema-v1
  ✓ 校验和哈希为 16 位十六进制
  ✓ 生成模型 ID
  ✓ 会话 ID
  ✓ 权限决策 ID 预留为 null
  ✓ sqlQuery Manifest 无结果指标
  ✓ sqlQuery Manifest 携带 SQL 与模型

[2] saveCanvas -> loadCanvas 往返（canvas sidecar）
  ✓ sidecar 可读回
  ✓ dataFrame Manifest 往返后深度相等
  ✓ sqlQuery Manifest 往返后深度相等
  ✓ SQL 全文（含换行/引号/中文）无丢失
  ✓ 校验和哈希无丢失
  ✓ 模型/会话/权限字段无丢失
  ✓ 校验和可由持久化的节点数据重算（T1.2 复跑前提）
  ✓ 边与节点数量不变

[3] extractSqlFromCommand
  ✓ 提取 "SELECT 1"                    # --sql "..."
  ✓ 提取 "SELECT 2"                    # --sql '...'
  ✓ 提取 "SELECT \"x\" FROM t"          # 引号内转义引号还原
  ✓ 提取 "SELECT 3"                    # --sql=...
  ✓ 提取 "SELECT a\nFROM t\nWHERE b = 1"   # 多行 SQL
  ✓ 提取 "SELECT * FROM t"             # 未加引号，截掉尾部 -o out.parquet
  ✓ 提取 ""                            # 无 --sql → 空串（不伪造 SQL）

[4] govio-canvas 扩展事件流填充 Manifest
  ✓ 扩展注册了 tool_result / message_end 处理器
  ✓ 扩展注册了 govio_show_dataframe 工具
  ✓ observe load 生成 dataFrame 节点事件
  ✓ 节点事件自动携带 Manifest
  ✓ Manifest.origin = observe-load
  ✓ Manifest.sql 还原命令中的 SQL 全文（含转义引号/换行）
  ✓ Manifest.datasource / dfName
  ✓ Manifest 行数/列数
  ✓ Manifest 模型与会话取自 pi 上下文
  ✓ Manifest 校验和与同输入直接构建一致
  ✓ 助手消息 SQL 生成 sqlQuery 节点事件
  ✓ sqlQuery 节点携带 SQL 全文
  ✓ sqlQuery Manifest 记录来源模型与会话
  ✓ sqlQuery Manifest 记录消息时间
  ✓ sqlQuery Manifest 无结果校验和（尚未执行）

[5] store -> canvas_save -> loadCanvas -> hydrateSession
  ✓ store 创建了 sqlQuery + dataFrame 节点
  ✓ dataFrame node.data.manifest 已写入
  ✓ sqlQuery node.data.manifest 已写入
  ✓ sidecar 可读回
  ✓ 画布已清空
  ✓ 会话重开后 dataFrame Manifest 完整恢复
  ✓ 会话重开后 sqlQuery Manifest 完整恢复
  ✓ 恢复后 SQL 全文与校验和未变
  ✓ 同 dfName 不重复建节点
  ✓ 已有 Manifest 不被静默覆盖（漂移判定留给 T1.2）

共 52 项断言，失败 0 项
PASS: Manifest 往返无丢失
```

说明：
- 第 [4] 段用 stub 的 pi `ExtensionAPI` 注册真实扩展，再喂造好的 `tool_result` / `message_end` 事件，因此**不依赖 govio-cli 与真实模型**也能验证「observe load 生成的 dataFrame 节点自动携带 Manifest」这条验收项。
- 第 [5] 段直接调用真实的 `useCanvasStore.createGovioNode` / `hydrateSession` 与真实的 `saveCanvas` / `loadCanvas`，覆盖验收项「canvas_save → loadCanvas 往返后 Manifest 无丢失」。
- 运行时会出现 `[zustand persist middleware] Unable to update item 'govio-canvas-state', the given storage is currently unavailable.` —— Node 环境没有 `localStorage`，属预期噪音，不影响断言（浏览器中不会出现）。
- sidecar 写在系统临时目录（`mkdtemp`）并在 `finally` 中清理，不污染 `.govio/sessions/`。

## 4. 模块自检（随导入自动执行）

`server/analysis-manifest.ts` 末尾带 `NODE_ENV !== "production"` 自检块（沿用 `session-history.ts` 惯例），上面每次跑脚本都会执行；断言内容：校验和确定性、`schemaHash` 为 16 位、行数变化可检出、dtype 变化可检出、sqlQuery Manifest 无 checksum、无列信息时不产出 checksum。任一失败会直接抛错使脚本非 0 退出。

## 5. 脚本自身的类型检查

脚本目录不在任何 tsconfig 的 `include` 内，单独按 strict 检查一遍：

```
$ npx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target es2023 --module esnext \
    --moduleResolution bundler --allowImportingTsExtensions --types node \
    scripts/verify-manifest-roundtrip.ts
（无输出 = 通过）
```

## 6. 向后兼容：历史 sidecar

功能上线前的 sidecar 没有 `manifest` 字段，读回后节点照常渲染、只是不显示「详情」按钮：

```
$ jq '{nodes: (.nodes|length), df: ([.nodes[]|select(.type=="dataFrame")]|length), withManifest: ([.nodes[]|select(.data.manifest != null)]|length)}' \
    .govio/sessions/2026-09-13T02-37-48-575Z_01a098a0-c69f-75f5-8f3d-e5ecb9244328.jsonl.canvas.json
{
  "nodes": 7,
  "df": 1,
  "withManifest": 0
}
```

## 7. 建议的真机复核步骤（本任务未执行，需 dev 环境 + govio-cli + 模型 Key）

自动化已覆盖「事件流 → store → sidecar → 恢复」全链路，以下 4 步用于人工确认 UI 与真实 CLI 输出形态：

1. `npm run dev`，在聊天里让 agent 执行一次 `govio-cli observe load --name df_x --datasource <ds> --sql "..."`；等 dataFrame 节点出现后点操作栏「详情」，核对 SQL 全文、数据源、行×列、校验和、生成模型、会话 ID、权限决策显示为「未关联」。
2. 让 agent 在回复中给出一段 ```sql 代码块，核对生成的 sqlQuery 节点「详情」里的 SQL 全文与来源模型（应等于当前会话所选模型）。
3. 侧栏会话列表切走再切回同一会话（触发 `canvas_restore`），确认节点「详情」内容与切换前逐字一致。
4. 落盘核对：
   ```bash
   jq '.nodes[] | select(.type=="dataFrame") | .data.manifest' \
     .govio/sessions/<最新会话>.jsonl.canvas.json
   ```
   应看到 `schemaVersion/origin/sql/datasource/dfName/executedAt/rowCount/columnCount/checksum/model/sessionId/permissionDecisionId` 全部字段。
5. （可选）SQL 编辑器执行一次 SQL，确认 `POST /api/execute-sql` 产出的节点 Manifest `origin` 为 `sql-editor` 且 `model` 缺省（面板显示「—（人工执行）」）。
