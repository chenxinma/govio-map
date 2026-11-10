# X11 CHANGES

bugfix：LLM 设置对话框 provider name 输入框每输入一个字符即失焦。变更集中在前端设置对话框，**未触碰 server 落盘结构、apiKey 掩码与 WS 协议**。

```
 docs/tasks/X11-settings-provider-name-input/CHANGES.md              | 新增（本文件）
 docs/tasks/X11-settings-provider-name-input/design.md               | 新增（方案与取舍 + 遗留问题）
 docs/tasks/X11-settings-provider-name-input/verification.md         | 新增（验证命令与关键输出）
 docs/tasks/X11-settings-provider-name-input/smoke-browser-cdp.mjs   | 新增（真实浏览器 CDP 冒烟脚本，可复跑）
 docs/task-plan.json                                                 | X11 条目状态推进 + history + updatedAt
 src/components/SettingsModal.tsx                                    | 178 insertions(+), 199 deletions(-)（整体改造）
 src/utils/provider-drafts.ts                                        | 新增 143 行（纯逻辑，可 node 环境单测）
 tests/integration/settings-provider-drafts.test.ts                  | 新增 207 行 / 15 个 it
```

## 1. `src/utils/provider-drafts.ts`（新增）

provider 编辑态纯逻辑模块，与 React/DOM 解耦：

- `ProviderDraft { uid, name, cfg }` / `DraftIssue { uid, kind, message }` 类型
- `nextProviderUid()`：模块级单调计数器生成 `pvd-N`，**与用户输入无关**，故可安全用作 React key
- `cloneConfig()`（私有）：深拷贝 `ProviderConfig`，`models` 数组独立实例（修掉修复前多处共享 `EMPTY_PROVIDER.models` 引用的隐患），字段缺失时给安全默认值
- `toDrafts(config)`：Record → 有序草稿数组，保留键顺序；`null`/`undefined`/空 providers 时回落默认 `deepseek` + `https://api.deepseek.com`（与修复前初始态一致）
- `toConfig(drafts)`：草稿数组 → Record，**逐条对齐修复前 `handleSave` 语义**（名称 trim、丢弃空名、模型 id trim 后过滤空值、全空回填 `[{ id: "" }]`、保留模型显示名）
- `validateDrafts(drafts)`：空名 → `empty-name`；trim 后重名 → 涉及的每条各一个 `duplicate-name`（修复前重名会静默覆盖丢 provider）
- `canSaveDrafts(drafts)`：无 issue + 每条 `baseUrl`/`api` 非空 + 至少一个模型 id 非空
- `suggestProviderName(drafts)` / `emptyProviderDraft(name)`：新增 provider 的占位名与空草稿

## 2. `src/components/SettingsModal.tsx`（改造）

| 位置 | 修改 |
|---|---|
| 导入 | 去掉本地 `EMPTY_PROVIDER` 常量，改从 `../utils/provider-drafts` 导入草稿 API；新增 `useMemo` |
| 状态 | `useState<ModelsConfig>` → `useState<ProviderDraft[]>(() => toDrafts(initialConfig))` |
| **卡片 key** | `key={name}` → **`key={draft.uid}`**（本 bug 的主因修复点） |
| 名称输入框 | `value={draft.name}` + `onChange={(e) => updateName(draft.uid, e.target.value)}`；不再重命名 Record 键，故不再触发重挂载。允许编辑期为空/重名 |
| 错误提示 | 输入框下方新增 `issue && <span className="text-xs text-error">`；命中 issue 时输入框加 `border-error/60`；页脚新增首条问题文案（`flex items-center justify-between` 布局，按钮组包进 `flex gap-2 flex-shrink-0`） |
| handlers | `updateProvider/updateProviderName/addProvider/removeProvider/updateModel/addModel/removeModel` 全部改为按 `uid` 定位的草稿数组不可变更新；`updateProviderName` 的 `!newName.trim()` early-return 删除（清空不再被吞） |
| 名称行布局 | `flex items-center` → `flex items-start`，名称 input 包进 `flex-1 flex flex-col gap-1`（容纳错误文案），删除按钮加 `mt-1` 保持与 h-9 输入框对齐 |
| 校验/保存 | `canSave = canSaveDrafts(drafts)`（useMemo 计算 issues + issueByUid）；`handleSave` 收敛为 `onSave(toConfig(drafts))` |
| 样式常量 | 6 处重复的长 class 串抽为模块级 `INPUT_CLASS`，各 input 用模板串拼接（尺寸/布局类保留在原位）。已验证 Tailwind v4 仍能扫到全部类名（含新引入的 `border-error/60`），产物 CSS 断言见 `verification.md` §3 |
| 未变 | Escape 关闭、点击遮罩关闭、加载中骨架分支、header 结构、模型行 `key={idx}`、所有色值/间距 class、`onSave` 契约与调用方 `Header.tsx` |

## 3. `tests/integration/settings-provider-drafts.test.ts`（新增，15 个 it / 5 个 describe）

node 环境纯逻辑回归测试：

- **uid 与名称解耦（主因回归）**：同名两条草稿 uid 不同；模拟逐字符输入 `openai`，每步 uid 数组不变、顺序不变；uid 不含名称内容
- **toDrafts**：顺序保留 + 深拷贝（改草稿不污染入参）；`null`/`undefined`/空 providers 回落默认 deepseek；新建草稿 models 数组不共享引用
- **toConfig 落盘语义**：trim 名称/过滤空模型 id/保留显示名；丢空名条目 + 模型全空回填占位；`toConfig(toDrafts(cfg))` 幂等；重名草稿被 `canSaveDrafts` 拦下（不静默丢条目）
- **校验与保存可用性**：空名 / trim 后重名（两条 issue）/ 干净配置无 issue；缺 baseUrl、缺 api、缺模型 id、空数组均不可保存；`suggestProviderName` 跳过已占用名
- **SettingsModal 源码契约**（DOM 行为在 node 环境无法直测，静态兜底）：源码含 `key={draft.uid}`，不含 `key={name}` / `key={draft.name}` / `key={provider`；名称输入框受控于 `draft.name` 且 onChange 只调 `updateName(draft.uid, ...)`

## 4. `docs/tasks/X11-settings-provider-name-input/smoke-browser-cdp.mjs`（新增）

真实浏览器冒烟脚本（moli CDP + `Input.dispatchKeyEvent` 真实按键），13 项检查，复跑方式见 `verification.md` §4。放仓库内以便后续 UI 回归复用；不参与 `npm run verify`（需要外部浏览器与 dev server）。

## 5. `docs/task-plan.json`

`crossCutting[X11]`：`pending` → `in_progress` → `done`，各步追加 history 条目；顶层 `updatedAt` 刷新。

## 未改动（明确核查过）

- `server/models-config.ts`、`src/types/models-config.ts`、`src/types/ws-protocol.ts`、`server/ws-handler.ts`
- `src/components/Layout/Header.tsx`（`key={modelsConfig ? "loaded" : "loading"}` 只在配置到达时重挂载一次，行为正确）
- `src/components/DataSourcesModal.tsx`（`key={ds}` / `key={df.name}` 为只读展示，无同类缺陷）
- `package.json`（未引入任何新依赖）
