# X7：启动时 cwd 规范大小写（Windows 会话恢复静默失败修复）

## 1. 背景与动机

Windows 上 dev server 进程 `process.cwd()` 为磁盘规范小写 `D:/work/gov-io/govio-map`，而历史会话头（Electron/历史启动路径）记录的 cwd 是 `D:/Work/gov-io/govio-map`（大写 W）。pi `findMostRecentSession` 对 cwd 过滤是**大小写敏感字符串比较** → 全部历史会话落选 → 后端静默创建空会话（画布空白、无任何报错）。用户以为会话丢了。这是截图任务中发现的真 bug，必须修复。

## 2. 先读清单（按序）

1. `AGENTS.md`（任务模式、验证门槛、SQL 纪律指针）
2. `docs/task-plan.json` 中 `crossCutting[] | select(.id=="X7")` 条目
3. `server/agent.ts`（`agentSetup`、`getOrCreateSession`、`openSessionFile`；`SessionManager.continueRecent/create/open` 调用点）
4. `server/session-history.ts`（`getSessionDir()` = `process.cwd()/.govio/sessions`）
5. `docs/task-plan.json` 中 X7 的 note（修复方向已写：win32 用 `fs.realpathSync.native` 取磁盘规范大小写并 `process.chdir`，或传入与历史会话一致的 cwd）

## 3. 实证事实（主会话已调研，勿重复踩坑）

- 会话 transcript 文件 `.govio/sessions/*.jsonl` 的首行 `{"type":"session","cwd":"...","id":"...","timestamp":"...","version":"..."}` 含 cwd 字段；历史会话为 `D:/Work/...`（大写 W）。
- `getSessionDir()` 直接用 `process.cwd()` 拼 `.govio/sessions`——cwd 大小写不影响目录解析（Windows 文件系统不区分大小写），**只影响 pi `findMostRecentSession` 的 cwd 匹配**。
- pi 的会话选择逻辑在 `@earendil-works/pi-coding-agent` 的 `SessionManager`（`continueRecent`/`findMostRecentSession`）内部，是大小写敏感字符串比较——不应去 patch pi 内部，应从源头保证 cwd 一致。
- Windows 下 `fs.realpathSync.native("D:/work/...")` 返回磁盘真实大小写（如 `D:\Work\gov-io\govio-map`，反斜杠分隔）。
- 项目约定：bash 中用正斜杠路径；`python` 不可用（用 `jq`/`node`）。

## 4. 实现范围

1. 在 `server/agent.ts` 的 `agentSetup()`（或更早的模块初始化）中，**仅 win32 平台**：用 `fs.realpathSync.native(process.cwd())` 取磁盘规范路径，`process.chdir()` 到规范路径（注意 realpathSync.native 返回反斜杠，`process.chdir` 接受；但后续 `getSessionDir()` 拼出的路径也会反斜杠化——检查 `resolvePath`/`sep` 使用是否兼容，必要时 `normPath = p.split(sep).join("/")` 或 `resolvePath` 归一）。
2. 确保 `getOrCreateSession()` / `openSessionFile()` 之后调用 `SessionManager.continueRecent/create/open` 时 cwd 与历史会话头一致。
3. 回归断言：新建 `scripts/verify-cwd-normalize.ts`（或并入 `session-history`/`agent` 的 NODE_ENV 自检）——构造大小写不同的伪会话头（`D:/Work/...` vs `D:/work/...`），验证归一化后 `findMostRecentSession` 能命中（可 mock `SessionManager` 或直接测归一化函数输出）。验证脚本须不依赖真实 pi 会话、纯本地可跑。
4. `npm run verify` 聚合加入新脚本（更新 `package.json` `scripts.verify` 链与 `scripts.verify:cwd`）。
5. 交付物：`docs/tasks/X7-cwd-case-normalization/{design.md,CHANGES.md,verification.md}`。
6. `docs/task-plan.json` 中 X7 状态 `pending → done`（追加 history，by: worker）。

## 5. 范围纪律

- 不改 pi (`@earendil-works/pi-coding-agent`) 内部代码；只在本仓库 `server/`/`scripts/` 范围内修。
- 不顺带重构 `session-history.ts` 的其它函数；不动会话删除/导出/权限审计逻辑。
- 发现的新问题（如 macOS/Linux 路径大小写、Electron 打包路径差异）写入 design.md 遗留问题，不在本任务处理。

## 6. 环境与协议

- **分支**：`main`（当前 checkout）；**不切分支、不 push**。单次 commit，message 前缀 `X7: `。
- **Windows Git Bash**：正斜杠路径；`jq` 可用（`/d/Work/jq/jq`）；`python` 不可用；bash 脚本注意引号转义。
- **状态协议**：开工先 `jq` 把 X7 置 `in_progress` + history；完成置 `done` + history（绝不置 `accepted`）。任何状态变更刷新顶层 `updatedAt`（ISO 8601）。
- **验证门槛**（全绿才可提交）：`npm run build`、`npm run lint`、`npm run verify`（既有断言零回归），且 verify 全跑后 `git status --porcelain` 干净（除本任务新增/修改文件）。
- **不运行** `govio-cli observe load`（不碰数据）；不读任何数据内容。

## 7. 时间预算

- timeoutMs: 2700000（45 分钟）
- checkpointBeforeDeadlineMs: 600000（到期前 10 分钟先 checkpoint：已改文件、验证状态、剩余工作，写入 CHANGES.md 草稿）

## 8. 最终输出格式（≤15 行）

```
status: done | blocked(原因)
交付物: docs/tasks/X7-cwd-case-normalization/{design,CHANGES,verification}.md
commit: <sha>
验证: build ✓ / lint ✓ / verify:<manifest>/<rerun>/<audit>/<export>/<source-table> 断言数（各自前后对比）
实现要点: <≤3 行>
遗留: <无 或 列出>
```
