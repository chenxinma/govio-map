# X7 verification：验证命令与关键输出

工作目录：govio-map worktree（Windows / Git Bash）。全部命令退出码 0。

## 1. 验证门槛

### npm run build

```
$ npm run build
tsc -b && vite build
✓ built in 2.85s
BUILD_EXIT=0
```

### npm run lint

```
$ npm run lint
eslint .
LINT_EXIT=0   （无输出，零告警）
```

### npm run verify（聚合，含新增 verify:cwd）

```
$ npm run verify
VERIFY_EXIT=0
共 92 项断言，失败 0 项     PASS: Manifest 往返无丢失
共 71 项断言，失败 0 项     PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
共 119 项断言，失败 0 项    PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID
共 126 项断言，失败 0 项    PASS: 交付报告自包含、含五类节点与血缘图、附录 A/B 齐全、漂移有警示、内容全部转义
共 39 项断言，失败 0 项     PASS: sourceTable 数据源标注全链路贯通，旧节点兼容
共 13 项断言，失败 0 项     PASS: cwd 规范大小写后 Windows 会话恢复命中，静默失败消除
```

断言数前后对比（既有脚本零回归）：

| 脚本 | 前 | 后 |
|---|---|---|
| verify:manifest | 92 | 92 |
| verify:rerun | 71 | 71 |
| verify:audit | 119 | 119 |
| verify:export | 126 | 126 |
| verify:source-table | 39 | 39 |
| verify:cwd（新增） | — | 13 |

### verify 全跑后 git status

```
$ git status --porcelain
 M docs/task-plan.json
 M package.json
 M server/agent.ts
?? scripts/verify-cwd-normalize.ts
?? server/cwd-normalize.ts
```

仅本任务新增/修改文件，verify 跑动未产生任何临时/残留文件（脚本全部用 tmp 目录并在
finally 清理）。

## 2. npm run verify:cwd 明细（13 项断言）

```
$ npm run verify:cwd
[1] canonicalizeCwd（磁盘规范大小写）
  ✓ 大小写错误的路径被规范为磁盘真实大小写
  ✓ 幂等：规范路径再次规范化不变
  ✓ 路径不存在时原样返回、不抛错
  ✓ 非 win32 平台原样返回
[2] pi 会话匹配语义（SessionManager.continueRecent）
  ✓ 会话头为前向斜杠写法同样命中（分隔符差异不影响匹配）
  ✓ bug 复现：cwd 大小写与会话头不符时历史会话静默落选（→ 新建空会话）
  ✓ 修复后：归一化 cwd 命中历史会话
  ✓ cwd 过滤仍然生效：更新的其它项目会话未被误选
[3] SessionManager.list（会话列表同过滤语义）
  ✓ 归一化 cwd 可见历史会话
  ✓ 其它项目会话不混入
  ✓ 大小写不符时会话不可见（列表面板同 bug）
[4] applyCanonicalCwd（进程 cwd 归一）
  ✓ 以错误大小写 chdir 后恢复为磁盘规范大小写
  ✓ applyCanonicalCwd 幂等

共 13 项断言，失败 0 项
PASS: cwd 规范大小写后 Windows 会话恢复命中，静默失败消除
```

要点：脚本在 tmp 目录构造伪会话头（hit=磁盘规范大小写+前向斜杠写法的历史会话；
other=更新但属于其它项目的会话），用真实 pi `SessionManager.continueRecent/list`
验证（无 mock）；「未命中」判别式为 `getSessionFile()` 指向尚未落盘的新会话文件
（pi `newSession()` 预分配路径但不写盘）——这是首版脚本用 `getSessionFile() === undefined`
误判、修正后的准确判别式。大小写相关断言在无法构造大小写漂移的平台上跳过并明示。

## 3. 修复机理实证（调研阶段记录，均已在 design.md 归档）

```
$ node -e "console.log(require('fs').realpathSync.native('D:/work/gov-io/govio-map'))"
D:\Work\gov-io\govio-map                      # 磁盘真实大小写 = 大写 W（历史会话头同款）
$ node -e "console.log(require('path').resolve('D:/work/x') === require('path').resolve('D:/Work/x'))"
false                                         # pi 的比较是大小写敏感词法比较 → 失配根因
```

历史会话头抽样（`D:/Work/gov-io/govio-map/.govio/sessions/*.jsonl` 首行）：
全部为 `"cwd":"D:\\Work\\gov-io\\govio-map"`，与 `realpathSync.native` 的输出一致，
即归一化后 `continueRecent`/`list` 的 `resolvePath` 字符串比较直接命中。
