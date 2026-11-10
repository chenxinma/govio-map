# X11 修复设计：LLM 设置对话框 provider name 输入框每字符失焦

- 任务：`docs/task-plan.json → crossCutting[X11]`
- 性质：bugfix（用户可见交互缺陷），按 AGENTS.md「合入 main 纪律」可直接 commit main
- 交付物目录：`docs/tasks/X11-settings-provider-name-input/`

## 1. 问题

用户报告（2026-11-10）：LLM 设置对话框里 provider name 输入框**每输入一个字符光标就跳开**，无法连续输入。

浏览器实测复现（负对照，旧代码 + 真实按键事件，见 `verification.md` §4）：连续输入 `hotfix1` 7 个字符，输入框值只累积到第 1 个字符（`deepseek-my` → `deepseek-myh`），此后每键 `document.activeElement` 都不再是该输入框。

## 2. 根因

**主因：用「可编辑的值」当 React `key`。** 修复前 `src/components/SettingsModal.tsx`：

```tsx
{providerEntries.map(([name, provider]) => (
  <div key={name} ...>                                  // ← key = provider 名称
    <input value={name} onChange={(e) => updateProviderName(name, e.target.value)} />
```

provider 名称既是 input 的受控值，又是整张卡片的 `key`。每敲一个字符 → `updateProviderName` 重建 `providers` Record 的键 → `key` 变化 → React 判定为不同元素，**卸载旧子树、挂载全新 DOM `<input>`** → 焦点与光标位置随之丢失（每键一次），后续按键落到页面别处。

**次生缺陷**（同一函数 `updateProviderName`）：

```ts
if (oldName === newName || !newName.trim()) return;   // ① 吞掉清空/纯空格输入
```

1. 清空输入框（或删到只剩空格）被 early-return 吞掉，界面回弹成旧值；
2. 重命名为已存在的 provider 名 → Record 键碰撞，**静默覆盖并丢掉一个 provider**（用户无感知）；
3. 编辑期不 trim，只在 `handleSave` trim → 可能出现两条 trim 后同名的配置，后者覆盖前者。

## 3. 方案

**把「名称」从身份标识降级为普通字段，身份改用与内容无关的稳定 `uid`。**

新增纯逻辑模块 `src/utils/provider-drafts.ts`：

| 导出 | 职责 |
|---|---|
| `ProviderDraft { uid, name, cfg }` | 编辑态：uid 一经生成不变，name 可自由编辑 |
| `nextProviderUid()` | 进程内单调递增 uid（`pvd-N`），不落盘 |
| `toDrafts(config)` | 落盘 Record → 有序草稿数组；保留键顺序；深拷贝；无配置时回落默认 `deepseek` |
| `toConfig(drafts)` | 草稿数组 → 落盘 Record；语义与修复前 `handleSave` 完全一致 |
| `validateDrafts(drafts)` | 空名 → `empty-name`；trim 后重名 → 每条各一个 `duplicate-name` |
| `canSaveDrafts(drafts)` | 无名称问题 + 每条 baseUrl/api 非空 + 至少一个模型 id 非空 |
| `suggestProviderName(drafts)` | 新增 provider 的占位名（跳过已占用名，行为同修复前） |
| `emptyProviderDraft(name)` | 新建草稿（models 数组独立实例） |

`SettingsModal.tsx` 改造：

1. 状态 `config: ModelsConfig` → `drafts: ProviderDraft[]`；卡片 `key={draft.uid}`（**关键修复**）
2. 所有 handler 改为按 uid 定位（`updateName / updateCfg / updateModel / addModel / removeModel / addProvider / removeProvider`）
3. 名称输入框 `value={draft.name}`，onChange 只改草稿字段，不触碰 key
4. 校验前置到编辑期：空名/重名在**卡片内输入框下方**红字提示 + 输入框红边（`border-error/60`），**页脚**再显示首条问题文案；`保存` 按钮禁用
5. `handleSave` 收敛为 `onSave(toConfig(drafts))`
6. 名称行新增 wrapper `<div className="flex-1 flex flex-col gap-1">` 承载错误文案：宽度由 wrapper 的 `flex-1`（行方向）撑开，input 自身用 **`w-full h-9`**——父级是 `flex-col`，若给 input 留 `flex-1`，`flex:1 1 0%` 的 `flex-basis` 会作用到纵轴并覆盖 `h-9`，把输入框压扁（首轮实现即犯此错，用户验收时反馈「比其它输入框矮」，已修，见 `verification.md` §7）
7. 顺带修掉共享引用：修复前多个新增 provider 复用同一个 `EMPTY_PROVIDER.models` 数组实例，现在每条草稿深拷贝

**落盘兼容性**：`toConfig` 保持修复前 `handleSave` 的全部语义（名称 trim、丢弃空名条目、过滤空模型 id、模型全空时回填 `[{ id: "" }]`、保留模型显示名 `name`），`server/models-config.ts`、apiKey 掩码与 WS 协议**一行未动**。

## 4. 取舍

1. **为什么不用 `key={index}`**：index 作 key 在删除中间 provider 时会让 React 把 DOM/受控值错位复用到相邻卡片（同类"输入错乱"缺陷），且与"名称可改"叠加后更难推理。uid 是与内容无关的稳定标识，代价只是多一个草稿类型 + 两个转换函数。
2. **为什么把逻辑抽到 `src/utils/`**：仓库测试基建是 node 环境（`vitest.config.ts` 明确"不需要 DOM"，无 jsdom/@testing-library），纯逻辑抽出后可直接单测（15 例，覆盖 uid 解耦、往返幂等、校验、保存可用性）；组件里只剩事件绑定。
3. **为什么"编辑期允许非法 + 保存前拦截"，而不是输入时阻止非法字符**：受控 input 里拦截字符必然又要与光标位置/选区纠缠——正是本 bug 的病灶；也影响粘贴与退格。允许中间态 + 显式红字提示，交互更可预期，且不可能再静默丢 provider。
4. **为什么不引入 DOM 测试依赖**：加 jsdom + @testing-library/react 属测试基建变更，超出 hotfix 范围。改用双保险：① 真实浏览器 CDP 冒烟脚本（`smoke-browser-cdp.mjs`，用 `Input.dispatchKeyEvent` 发真实按键）② 源码契约静态断言（`key={draft.uid}` 必须存在、`key={name}` 必须不存在）→ 见遗留问题 1。
5. **`INPUT_CLASS` 常量抽取**：6 处长 class 串去重。已验证 Tailwind v4 仍能从字面量常量扫到全部类名——构建产物 CSS 含 `bg-bg-primary`、`placeholder\:text-text-dim`、`focus\:border-brand\/50`、`border-error\/60`（新引入）、`px-2\.5` 等，样式无回归。

## 5. 未做（范围纪律）

- 不动 `server/models-config.ts`（落盘结构、掩码、合并逻辑）与 WS 协议 schema
- 不改 `Header.tsx` 的 `key={modelsConfig ? "loaded" : "loading"}`：它只在配置首次到达时重挂载一次，与逐字符输入无关，行为正确
- 不改 `DataSourcesModal.tsx`：已核查 `key={ds}`(149)、`key={df.name}`(184) 均为只读徽标/表格行，无"可编辑值当 key"问题
- 不加 provider 排序/拖拽、名称字符合法性校验等新交互（见遗留问题 4）
- 不顺带重构其它组件

## 6. 遗留问题

1. **前端组件缺 DOM 级测试能力**：仓库无 jsdom/@testing-library，UI 回归只能靠一次性 CDP 脚本 + 源码契约断言。若要常态化，建议单独立项引入 `jsdom` + `@testing-library/react`，并把 vitest 环境改为按文件混合（`// @vitest-environment jsdom`）。
2. **moli CDP 布局限制（比预想严重）**：该 headless 环境下 `position: fixed` 的 portal 覆盖层 rect 为 0×0，`document.body.innerText` 取不到覆盖层文本（`textContent` 正常）；进一步实测：即使 `Emulation.setDeviceMetricsOverride` 固定视口、把覆盖层临时改成 `position:absolute` + 显式宽高，元素 rect 仍恒为 0，inline `flex:1 1 0%` 也不被解析（`getComputedStyle().flex` 恒返回 `0 1 auto`）。结论：**moli 不能用于任何高度/间距/对齐类视觉验证**，本次仅用于「真实按键事件 → 值/焦点/节点身份/DOM 文案」这类不依赖布局的断言；视觉项必须真实浏览器目视（已因此漏掉一轮高度回归）。若要常态化 UI 视觉回归，需换用具备完整布局引擎的浏览器通道（真 Chrome / Playwright）或引入 jsdom + @testing-library（见遗留问题 1）。
3. **名称大小写敏感**：重名校验按 trim 后精确匹配（与落盘 Record 键语义一致），`OpenAI` 与 `openai` 视为两个 provider。若配置文件所在环境存在大小写不敏感合并风险，需另议口径。
4. **名称未做字符合法性校验**：目前只 trim + 去空 + 去重。落盘为 JSON 键是安全的，但若将来名称要进文件路径 / URL / 图数据库标识，需补白名单校验（如 `^[A-Za-z0-9_-]+$`）。
5. **保存后的 provider 顺序**：草稿顺序 = 加载时 `Object.entries` 顺序，新增追加到末尾；改名不再改变顺序（修复前重命名数字型名称可能因 JS 对象整数键规则被重排）。未提供手动排序能力。
