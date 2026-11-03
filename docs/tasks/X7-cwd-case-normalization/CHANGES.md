# X7 CHANGES：启动时 cwd 规范大小写

## 文件清单

| 文件 | 变更 | 摘要 |
|---|---|---|
| `server/cwd-normalize.ts` | 新增 | `canonicalizeCwd()`（win32 用 `fs.realpathSync.native` 取磁盘规范大小写，失败/非 win32 原样返回）+ `applyCanonicalCwd()`（`chdir` 到规范路径并返回规范后 `process.cwd()`，幂等） |
| `server/agent.ts` | 修改（4 处） | ① 新增 `import { applyCanonicalCwd }`；② `agentSetup()`：`const cwd = process.cwd()` → `applyCanonicalCwd()`（调用时归一，兼容 Electron 主进程先行 chdir）；③ `getOrCreateSession()`：同上，保证 `SessionManager.continueRecent/create` 的 cwd 与历史会话头一致，新会话头记录规范大小写；④ `openSessionFile()`：同上，`SessionManager.open` 的 cwdOverride 规范化 |
| `scripts/verify-cwd-normalize.ts` | 新增 | X7 回归断言（13 项）：tmp 伪会话头 + 真实 pi `SessionManager.continueRecent/list`，覆盖归一化单测、bug 复现、修复命中、cwd 过滤仍生效、列表面板同语义、`applyCanonicalCwd` 端到端；纯本地可跑、不依赖真实 pi 会话 |
| `package.json` | 修改（2 处） | `scripts.verify` 链末尾追加 `npm run verify:cwd`；新增 `scripts.verify:cwd` |
| `docs/task-plan.json` | 修改 | X7 条目 `pending → in_progress → done` + history 两条，刷新 `updatedAt` |
| `docs/tasks/X7-cwd-case-normalization/{design,CHANGES,verification}.md` | 新增 | 三件套交付物 |

## 关键实现点

- 归一化放在 `applyCanonicalCwd()` 的**调用时**（`agentSetup`/`getOrCreateSession`/`openSessionFile`），
  而非模块初始化——`agent.ts` 原注释明确 Electron 主进程会先 `chdir()` 再 boot agent。
- 采用 `process.chdir` 全局归一而非局部改传参：`getSessionDir()`、`SessionManager.list`、
  `assertValidSessionPath` 等所有 `process.cwd()` 调用点自动一致。
- `realpathSync.native` 返回反斜杠路径：pi 的 `resolvePath` 比较归一分隔符（只比大小写），
  下游 `resolvePath`/`sep` 用法兼容（`getSessionDir()` 本来就产出反斜杠形态），无需再归一分隔符。
- 不改 pi 内部代码；不动会话删除/导出/权限审计逻辑（范围纪律）。
