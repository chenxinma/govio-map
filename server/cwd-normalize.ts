import { realpathSync } from "node:fs";

/**
 * X7：启动时 cwd 规范大小写（Windows 会话恢复静默失败修复）。
 *
 * Windows 的 `process.cwd()` 保留启动路径的大小写（Git Bash 以 `/d/work/...` 启动
 * 即得 `D:\work\...`），而磁盘真实大小写是 `D:\Work\...`。pi `SessionManager` 的
 * 会话发现/过滤（`findMostRecentSession`、`list` → `sessionCwdMatches`）对会话头 cwd
 * 做大小写敏感的 `resolvePath` 字符串比较：cwd 大小写与会话头不一致时全部历史会话
 * 静默落选，后端直接新建空会话（画布空白、无任何报错）。
 *
 * 修法（不 patch pi 内部，从源头保证 cwd 一致）：win32 上用 `fs.realpathSync.native`
 * 取磁盘规范大小写并 `process.chdir`，使 `process.cwd()` 与会话头记录的 cwd
 * （磁盘规范大小写）大小写一致。
 */

/**
 * 返回 cwd 的磁盘规范形式：win32 上取磁盘真实大小写（`realpathSync.native`，
 * 反斜杠分隔；会话头 cwd 与 pi 的 `resolvePath` 比较均不关心分隔符风格），
 * 其它平台原样返回。路径不存在/不可读时原样返回，绝不抛错——启动链路不能因
 * cwd 规范化失败而中断。
 *
 * `platform` 参数仅供测试注入平台，默认取当前平台。
 */
export function canonicalizeCwd(cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return cwd;
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

/**
 * 把进程工作目录切到磁盘规范形式并返回规范后的 `process.cwd()`。幂等。
 *
 * 必须在调用时执行（而非模块初始化）：Electron 主进程可能先行 `chdir()`，
 * 见 `agentSetup()` 顶部注释；`getOrCreateSession()`/`openSessionFile()` 里
 * 传给 `SessionManager.continueRecent/create/open` 的 cwd 也经由此处取值，
 * 保证与历史会话头一致。
 */
export function applyCanonicalCwd(): string {
  const canonical = canonicalizeCwd(process.cwd());
  if (canonical !== process.cwd()) {
    process.chdir(canonical);
  }
  return process.cwd();
}
