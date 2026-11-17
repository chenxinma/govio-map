# BUGFIX-model-thinking-sync：模型/思考档链路缺陷

日期：2026-11-18（交互式修复，主会话直接实现）

## 现象与根因

| # | 现象 | 根因 |
|---|---|---|
| 1 | chat 模型下拉含无有效凭证的模型；模型多时不可搜索；缺思考深度设置 | modelOptions 直接 flatten models.json（不经 `ModelRuntime.getAvailable`）；原生 `<select>`；无 thinking level UI/协议 |
| 2 | 选完模型/思考档立刻发 prompt，会用上旧模型/旧档位 | `set_model`/`set_thinking_level` 是异步 WS 往返且 fire-and-forget，prompt 不等回执 |
| 3 | 续会话时前端把会话刚恢复的历史模型/思考档覆盖掉 | `applyModelSelection` 无 localStorage 记忆时强制 `set_model(options[0])`；`setModel` 内部会重算 thinking level |
| 4 | `npm run ask` 永远用默认模型，UI 里的选择不生效 | `server/cli.ts` 无 `--model`/`--thinking`，`getOrCreateSession` 不透传创建选项 |

## 修复

1. `listAvailableModels` 走 `modelRuntime.getAvailable()` 并附各模型 `thinkingLevels`（`getSupportedThinkingLevels`）；协议新增 `get_available_models`/`available_models`、`set_thinking_level`/`thinking_level_set`；模型下拉换可搜索分组组合框（`ModelSelect.tsx`）+ 思考档选择。
2. `src/utils/pending-ack.ts` 回执闸门：`send()` 的 prompt 路径先等 `model_set`/`thinking_level_set` 回执（3s 超时兜底放行，不卡输入）。
3. `session_ready` 附 `currentModel`/`thinkingLevel` 作为事实基准；无 localStorage 记忆时尊重会话当前模型，相同则不发 `set_model`。
4. `getOrCreateSession(forceNew, opts?)` 透传 `model`/`thinkingLevel`/`modelRuntime`；`cli.ts` 加 `--model provider/id`、`--thinking level`（非法值报错退出）。

## 验证

- `npm run build` / `npm run lint` / `npm run verify` 全绿（本分支当时实测：`tests/integration` 目录 **372** 例 + `tests/ui` **87** 例）
- 新增：`tests/integration/pending-ack.test.ts`（4 例）、`tests/ui/model-select.test.tsx`（3 例）
- 协议契约测试计数 20/28 同步更新，e2e 实发链路覆盖 `available_models`/`thinking_level_set`

### 口径澄清与合并后数字（主会话 2026-11-17 于 X26 验收时补记）

上面的 **372** 是「`tests/integration` 目录」计数，且测于 X26（PR #49）合入**之前**——两个数字都对，只是口径与时点不同。
两 PR 合并后的 main（`62c46bc`，主会话独立复跑）实测：

| 口径 | 命令 | 实测 |
|---|---|---|
| 仅 integration 目录 | `npx vitest run tests/integration` | **23 文件 / 389 例**（= 372 + X26 的 `cors-preflight` 17 例） |
| 仅 UI | `npm run verify:ui`（`vitest run tests/ui`） | **10 文件 / 87 例**（本任务贡献 +1 文件 / +3 例） |
| **基线口径** | `npm run verify:integration`（裸 `vitest run`，**包含** `tests/ui`） | **33 文件 / 476 例**（= 389 + 87） |

`docs/task-plan.json → verificationBaseline` 用的是第三种口径，**不要拿「仅 integration 目录」的数字去对基线**。
脚本断言不受本任务影响，仍为 **671**（9 脚本逐项不变）。

## 遗留

- CLI 参数校验未单测（脚本入口，手动核对错误路径文案）
- thinking 档位未持久化全局默认（`persist` 未传）；换模型按 per-model/全局默认重算——如需「记住我的档位」另立任务
