# X9 对话展示改版 — 验证记录

验证环境：Windows Git Bash，Node v24.16.0，分支 `chenxinma/x9-chat-display`（worktree，不切不 push）。

## 验证门槛（全绿）

| 门槛 | 命令 | 结果 |
|---|---|---|
| build | `npm run build`（tsc -b + vite build） | ✓ built in ~2.5s，0 error |
| lint | `npm run lint`（eslint .） | ✓ 0 error 0 warning |
| verify | `npm run verify`（5 脚本） | ✓ 全部 PASS |

## verify 断言数（前 → 后，零回归）

| 脚本 | 基线（改动前） | 本任务后 | 断言 |
|---|---|---|---|
| verify:manifest | 92 项 / 失败 0 | 92 项 / 失败 0 | PASS: Manifest 往返无丢失 |
| verify:rerun | 71 项 / 失败 0 | 71 项 / 失败 0 | PASS: 复跑链路按固化 SQL 执行… |
| verify:audit | 119 项 / 失败 0 | 119 项 / 失败 0 | PASS: 权限确认全程留痕… |
| verify:export | 126 项 / 失败 0 | 126 项 / 失败 0 | PASS: 交付报告自包含… |
| verify:source-table | 39 项 / 失败 0 | 39 项 / 失败 0 | PASS: sourceTable 数据源标注全链路贯通… |
| 合计 | 447 项 / 失败 0 | 447 项 / 失败 0 | 既有断言零回归（前端视图变更不影响既有断言） |

## 增量断言（session-history 模块自检）

- 命令：`npx tsx server/session-history.ts`（NODE_ENV≠production 触发模块级 self-check，断言失败即抛错退出）
- 结果：✓ 退出码 0（自检含既有 8 项断言 + 新增 `tool args parsed`：toolCall block `arguments` 解析进 `tools[0].args`）

## 收尾检查

- `git status --porcelain` 仅含本任务文件（三件套、5 个实现文件、specs、task-plan），无其它脏文件。

## 人工冒烟（无 React 测试基建，留待主会话/用户验收）

1. 流式：assistant 分段输出（thinking 折叠段 / 工具行 / markdown 正文）无气泡卡片，用户消息仍有气泡。
2. bash 工具行点击展开可见具体命令；其它工具展开为 args JSON（≤20 行截断）。
3. 历史会话回放：工具行同样可展开（args 来自 transcript `arguments`）。
4. 导出会话 JSON 不回归（新增 `tools` 字段，既有字段不变）。
