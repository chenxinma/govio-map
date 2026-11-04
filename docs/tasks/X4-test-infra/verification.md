# X4 verification：验证命令与关键输出

工作目录：govio-map worktree（Windows / Git Bash）。全部命令退出码 0。

## 1. 验证门槛

### npm run build

```
$ npm run build
tsc -b && vite build
✓ built in 2.31s
BUILD_EXIT=0
```

### npm run lint

```
$ npm run lint
eslint .
LINT_EXIT=0   （无输出，零告警）
```

### npm run verify（聚合，末尾含新增 verify:integration）

```
$ npm run verify
共 92 项断言，失败 0 项     PASS: Manifest 往返无丢失
共 71 项断言，失败 0 项     PASS: 复跑链路按固化 SQL 执行，一致刷新时间、漂移保留原留痕并记录对比
共 119 项断言，失败 0 项    PASS: 权限确认全程留痕，edit 记录改前改后命令，Manifest 可回查决策 ID
共 126 项断言，失败 0 项    PASS: 交付报告自包含、含五类节点与血缘图、附录 A/B 齐全、漂移有警示、内容全部转义
共 39 项断言，失败 0 项     PASS: sourceTable 数据源标注全链路贯通，旧节点兼容
共 13 项断言，失败 0 项     PASS: cwd 规范大小写后 Windows 会话恢复命中，静默失败消除
 Test Files  4 passed (4)
      Tests  38 passed (38)
VERIFY_EXIT=0
```

断言数前后对比（既有脚本零回归）：

| 脚本 | 前 | 后 |
|---|---|---|
| verify:manifest | 92 | 92 |
| verify:rerun | 71 | 71 |
| verify:audit | 119 | 119 |
| verify:export | 126 | 126 |
| verify:source-table | 39 | 39 |
| verify:cwd | 13 | 13 |
| **verify:integration（新增）** | — | **38 用例**（4 文件） |

新增用例分布：ws-handler 10 / govio-canvas-extension 10 / canvas-store 11 / canvas-sidecar 7 = 38。

## 2. 独立命令

```
$ npm run verify:integration        # = npx vitest run
 Test Files  4 passed (4)
      Tests  38 passed (38)

$ npm run test:integration          # 同上（别名）
```

## 3. verify 全跑后 git status

```
$ npm run verify >/dev/null 2>&1; echo $?
0
$ git status --porcelain
（仅本任务新增/修改的交付文件，无测试残留临时文件；tmp 会话目录由测试 afterEach 清理）
```

注：`.gitignore` 不覆盖 `tests/` 与 `vitest.config.ts`，均已纳入本次 commit；
测试运行产生的 tmp 目录（`os.tmpdir()/govio-x4-*`）由各测试 `afterEach`/`afterAll` 清理，
不在仓库内留痕。
