/**
 * X7 验证脚本：启动时 cwd 规范大小写（Windows 会话恢复静默失败修复）。
 *
 * 复跑：`npm run verify:cwd`（等价于 `npx tsx scripts/verify-cwd-normalize.ts`）
 *
 * 覆盖：
 *  1. canonicalizeCwd：win32 上把大小写错误的路径规范为磁盘真实大小写；幂等；
 *     路径不存在时原样返回不抛错；非 win32 平台原样返回
 *  2. bug 复现：pi SessionManager.continueRecent 按会话头 cwd 大小写敏感过滤，
 *     cwd 大小写与历史会话头不符时历史会话静默落选、指向尚未落盘的新会话文件
 *     （即后端静默新建空会话，本次修复的 bug）
 *  3. 修复效果：归一化后的 cwd 命中历史会话头（会话头为前向斜杠写法同样命中，
 *     分隔符差异不影响匹配），且更新但属于其它 cwd 的会话不会被误选
 *  4. SessionManager.list 同一过滤语义（/sessions 会话列表）：归一化后可见，
 *     大小写不符时不可见
 *  5. applyCanonicalCwd：进程以错误大小写 chdir 后恢复为磁盘规范大小写、幂等
 *
 * 全部使用 tmp 目录下的伪会话头（`{"type":"session",...,"cwd":...}` 首行），
 * 不依赖真实 pi 会话、纯本地可跑。依赖大小写不敏感文件系统（Windows）的断言
 * 在无法构造大小写漂移的平台上跳过并明示。任一断言失败退出码为 1。
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as nodeResolvePath } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { applyCanonicalCwd, canonicalizeCwd } from "../server/cwd-normalize.js";

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 翻转路径最后一个段中首个字母的大小写，构造「同一目录的错误大小写写法」。 */
function flipLastSegmentCase(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const head = p.slice(0, i + 1);
  const tail = p.slice(i + 1);
  for (let k = 0; k < tail.length; k++) {
    const c = tail[k] as string;
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (flipped !== c) return head + flipped + tail.slice(k + 1);
  }
  return p;
}

/** 写一个仅含会话头的伪 transcript（pi `readSessionHeader` 只需首行 type/id 合法）。 */
function writeSessionHeader(file: string, id: string, cwdHeader: string, timestamp: string, mtime: Date): void {
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: cwdHeader }) + "\n");
  utimesSync(file, mtime, mtime);
}

const tmpRoot = mkdtempSync(join(realpathSync.native(tmpdir()), "govio-x7-"));
const originalCwd = process.cwd();

try {
  const projectDir = join(tmpRoot, "proj");
  const sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(projectDir);
  mkdirSync(sessionsDir);

  const canonicalProject = realpathSync.native(projectDir);
  const wrongCaseProject = flipLastSegmentCase(canonicalProject);
  // 当前文件系统能构造出大小写漂移（Windows NTFS）时才可跑大小写敏感断言
  const caseDrift = wrongCaseProject !== canonicalProject && canonicalizeCwd(wrongCaseProject) === canonicalProject;

  // 伪会话头：
  //  hit   = 历史会话（磁盘规范大小写、前向斜杠写法，较旧）——真实 bug 场景的会话头
  //  other = 更新但属于其它项目的会话（证明 cwd 过滤不会被「取最新」覆盖）
  const hitFile = join(sessionsDir, "2026-01-01T00-00-00-000Z_01a00000-0000-4000-8000-000000000001.jsonl");
  const otherFile = join(sessionsDir, "2026-01-02T00-00-00-000Z_01a00000-0000-4000-8000-000000000002.jsonl");
  writeSessionHeader(hitFile, "01a00000-0000-4000-8000-000000000001", canonicalProject.replaceAll("\\", "/"), "2026-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:00Z"));
  writeSessionHeader(otherFile, "01a00000-0000-4000-8000-000000000002", "X:\\other\\project", "2026-01-02T00:00:00.000Z", new Date("2026-01-02T00:00:00Z"));

  const sameFile = (a: string | undefined, b: string) => a !== undefined && nodeResolvePath(a) === nodeResolvePath(b);

  console.log("[1] canonicalizeCwd（磁盘规范大小写）");
  if (caseDrift) {
    check("大小写错误的路径被规范为磁盘真实大小写", canonicalizeCwd(wrongCaseProject) === canonicalProject,
      `期望 ${canonicalProject}，实际 ${canonicalizeCwd(wrongCaseProject)}`);
  } else {
    console.log("  - SKIP：当前平台/文件系统无法构造大小写漂移，跳过大小写相关断言");
  }
  check("幂等：规范路径再次规范化不变", canonicalizeCwd(canonicalProject) === canonicalProject);
  check("路径不存在时原样返回、不抛错", canonicalizeCwd(join(tmpRoot, "no-such-dir")) === join(tmpRoot, "no-such-dir"));
  check("非 win32 平台原样返回", canonicalizeCwd(canonicalProject, "linux") === canonicalProject);

  console.log("[2] pi 会话匹配语义（SessionManager.continueRecent）");
  check("会话头为前向斜杠写法同样命中（分隔符差异不影响匹配）",
    sameFile(SessionManager.continueRecent(canonicalProject.replaceAll("\\", "/"), sessionsDir).getSessionFile(), hitFile));
  if (caseDrift) {
    const raw = SessionManager.continueRecent(wrongCaseProject, sessionsDir);
    // 未命中时 SessionManager 指向一个尚未落盘的新会话文件（即后端静默新建空会话）
    const rawFile = raw.getSessionFile();
    check("bug 复现：cwd 大小写与会话头不符时历史会话静默落选（→ 新建空会话）",
      rawFile === undefined || !existsSync(rawFile),
      `实际选中已存在会话 ${rawFile ?? "(无)"}`);

    const fixed = SessionManager.continueRecent(canonicalizeCwd(wrongCaseProject), sessionsDir);
    check("修复后：归一化 cwd 命中历史会话", sameFile(fixed.getSessionFile(), hitFile),
      `实际选中 ${fixed.getSessionFile() ?? "(无)"}`);
    check("cwd 过滤仍然生效：更新的其它项目会话未被误选", !sameFile(fixed.getSessionFile(), otherFile));
  }

  console.log("[3] SessionManager.list（会话列表同过滤语义）");
  const okList: SessionInfo[] = await SessionManager.list(canonicalProject, sessionsDir);
  check("归一化 cwd 可见历史会话", okList.some((s) => sameFile(s.path, hitFile)));
  check("其它项目会话不混入", !okList.some((s) => sameFile(s.path, otherFile)));
  if (caseDrift) {
    const wrongList: SessionInfo[] = await SessionManager.list(wrongCaseProject, sessionsDir);
    check("大小写不符时会话不可见（列表面板同 bug）", !wrongList.some((s) => sameFile(s.path, hitFile)));
  }

  console.log("[4] applyCanonicalCwd（进程 cwd 归一）");
  if (caseDrift) {
    process.chdir(wrongCaseProject);
    const applied = applyCanonicalCwd();
    check("以错误大小写 chdir 后恢复为磁盘规范大小写", applied === canonicalProject && process.cwd() === canonicalProject,
      `实际 ${applied}`);
    check("applyCanonicalCwd 幂等", applyCanonicalCwd() === canonicalProject);
    process.chdir(originalCwd);
  }
} finally {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n共 ${checks} 项断言，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("失败项：\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: cwd 规范大小写后 Windows 会话恢复命中，静默失败消除");
