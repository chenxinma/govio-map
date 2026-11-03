# X7 设计：启动时 cwd 规范大小写（Windows 会话恢复静默失败修复）

## 1. 问题机理

Windows 上 `process.cwd()` **保留启动路径的大小写**（Git Bash 以 `/d/work/...` 启动即得
`D:\work\...`），而磁盘真实大小写是 `D:\Work\...`。pi（`@earendil-works/pi-coding-agent`）
的会话发现/过滤对会话头 cwd 做**大小写敏感的字符串比较**：

```
sessionCwdMatches(cwd, resolvedCwd)  // dist/core/session-manager.js
  return resolvePath(cwd) === resolvedCwd   // 纯词法归一（盘符大写/分隔符），大小写原样保留
```

`continueRecent` / `list` 在传入自定义 sessionDir（本项目 `getSessionDir()` =
`<cwd>/.govio/sessions`，≠ pi 默认 `~/.pi/agent/sessions/--...--`）时 `filterCwd=true`，
逐个会话头比对 cwd。cwd 大小写与会话头不一致 → 全部历史会话落选 → `continueRecent`
返回**新建的空会话**（`newSession()` 只建 in-memory 头、指向尚未落盘的新会话文件），
后端无任何报错，画布空白。用户以为会话丢了。

会话列表面板同样受害：`SessionManager.list`（`session-history.ts listSessions()`）用同一
`sessionCwdMatches` 过滤，大小写不符时列表为空。

## 2. 实证事实（本次调研/验证确认）

- `fs.realpathSync.native("D:/work/gov-io/govio-map")` → `D:\Work\gov-io\govio-map`
  （磁盘真实大小写为大写 W；`D:/Work/...` 输入同样返回该值）。
- `D:/Work/gov-io/govio-map/.govio/sessions/*.jsonl` 全部历史会话头记录
  `"cwd":"D:\\Work\\gov-io\\govio-map"`（磁盘规范大小写、反斜杠）。
- `path.resolve` 纯词法：`resolve("D:/work/...") !== resolve("D:/Work/...")`（大小写保留、
  分隔符归一）→ 分隔符风格不影响匹配，**只有大小写是失配根因**。
- pi 匹配逻辑定位：`dist/core/session-manager.js` `sessionCwdMatches` /
  `findMostRecentSession` / `list`（均 `resolvePath` 后 `===` 比较）。
- `SessionManager.newSession()` 会给新会话预分配 `<sessionDir>/<ts>_<id>.jsonl` 路径但
  不落盘——「未命中」的判别式是 `getSessionFile()` 指向的文件不存在（回归脚本据此断言）。

## 3. 方案

新增 `server/cwd-normalize.ts`（仅依赖 `node:fs`，无重依赖，可被验证脚本直接引用）：

- `canonicalizeCwd(cwd, platform = process.platform)`：win32 上 `realpathSync.native(cwd)`
  取磁盘规范大小写（反斜杠），非 win32 原样返回；路径不存在/不可读**原样返回不抛错**
  （启动链路不能因规范化失败而中断）。`platform` 参数仅供测试注入。
- `applyCanonicalCwd()`：把进程工作目录 `process.chdir` 到磁盘规范形式并返回规范后的
  `process.cwd()`；幂等。

接入点（`server/agent.ts` 三处，均在取 cwd 的调用时而非模块初始化——Electron 主进程可能
先行 `chdir()`）：

1. `agentSetup()`：`const cwd = applyCanonicalCwd();` → `DefaultResourceLoader` 等全部
   启动期路径一致；
2. `getOrCreateSession()`：传给 `SessionManager.continueRecent/create` 的 cwd 规范化，
   修复恢复静默失败，且**新会话头从此记录规范大小写**，后续会话互相可匹配；
3. `openSessionFile()`：传给 `SessionManager.open` 的 `cwdOverride` 同样规范化。

由于采用 `process.chdir` 归一而非仅改局部变量，其余 `process.cwd()` 调用点
（`getSessionDir()`、`SessionManager.list`、`assertValidSessionPath` 等）自动一致。

## 4. 取舍

- **不 patch pi 内部**（任务约束；且升级即丢）——从源头保证 cwd 与会话头一致。
- **chdir 而非只改传参**：一处归一、全链路一致；副作用是进程工作目录字符串变化，
  但 Windows 文件系统大小写不敏感，任何 fs 操作行为不变。
- **不做大小写不敏感比较**：pi 的比较是 `===`，我们无法在不改 pi 的前提下放宽；
  归一化到磁盘规范大小写后与历史会话头（同为磁盘规范大小写）天然一致。
- **分隔符无需归一**：pi 双侧 `resolvePath` 归一分隔符；历史会话头正/反斜杠写法都能命中
  （回归断言 [2] 首条覆盖）。
- **失败回退**：`realpathSync.native` 抛错时原样返回，宁可维持旧有（可能失配的）行为，
  也不让后端启动崩溃。
- **仅 win32**：POSIX 文件系统大小写敏感，`process.cwd()` 无此漂移场景。

## 5. 回归断言（scripts/verify-cwd-normalize.ts，`npm run verify:cwd`）

tmp 目录下构造伪会话头（首行 `{"type":"session",...,"cwd":...}`），用**真实** pi
`SessionManager.continueRecent/list` 验证（不 mock、不依赖真实 pi 会话）：

1. `canonicalizeCwd`：错误大小写 → 磁盘真实大小写；幂等；不存在路径回退；非 win32 原样。
2. bug 复现：cwd 大小写与会话头不符 → 历史会话落选（指向未落盘新会话 = 空会话）。
3. 修复：归一化 cwd 命中历史会话；更新但属于其它 cwd 的会话不被误选（过滤仍生效）；
   会话头前向斜杠写法同样命中。
4. `SessionManager.list`：归一化后可见 / 大小写不符不可见（列表面板同语义）。
5. `applyCanonicalCwd`：以错误大小写 `chdir` 后恢复规范大小写、幂等。

共 13 项断言。大小写相关断言依赖大小写不敏感文件系统（Windows），无法构造大小写漂移的
平台会跳过并明示（其余断言照常生效）。

## 6. 遗留问题（不在本任务处理）

1. **macOS 大小写不敏感 APFS 理论上同类漂移**：`canonicalizeCwd` 目前仅 win32 生效；
   若需覆盖，可放宽到 `darwin` 并在 mac 上补断言。
2. **`assertValidSessionPath` 的 `startsWith(dir + sep)` 是大小写敏感比较**：前端回传
   路径若与规范 cwd 大小写不一致会被拒。归一化后 `listSessions` 生成的路径大小写已一致，
   实际影响面收窄；彻底修复需大小写不敏感路径比较，另行任务。
3. **Electron 打包安装到不同大小写路径**的场景未实测；设计上 `agentSetup` 调用时点归一化
   已兼容（Electron main 先 `chdir` 再 boot）。
4. **会话头 cwd 指向已删除目录**由 pi 的 `session-cwd`（`MissingSessionCwdError`）流程
   处理，与本修复正交，未动。
5. 历史会话头中存在个别 `cwd: undefined` 的文件（非 pi 正常写入），pi 侧 `sessionCwdMatches`
   对空 cwd 判不匹配，行为与本修复无关，未处理。
