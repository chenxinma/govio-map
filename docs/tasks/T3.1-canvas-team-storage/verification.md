# T3.1（merged T3.2）验证记录

环境：Orca worktree t3-storage-sharing（Windows Git Bash，node 24.16）。
门槛三连为同轮连续执行：`npm run build && npm run lint && npm run verify`，退出码 0/0/0。

## 断言与用例（对照基线 2026-11-14 主会话实测）

| 类别 | 基线 | 本轮 | 增量 |
|---|---|---|---|
| 脚本断言 | 624 | **624**（92+71+119+138+39+48+46+13+58，全部 0 失败） | 0（既有脚本零改动、零回归） |
| vitest 集成 | 15 文件 194 例 | **17 文件 215 例** | +2 文件 +21 例 = canvas-storage.test.ts 12 例 + share-fork.test.ts 9 例 |
| vitest UI | 4 文件 31 例 | **4 文件 31 例** | 0（ChatPanel 新按钮未破坏既有 UI 断言） |
| ws-protocol.test.ts | 19 例（含计数断言 17/25） | 19 例（计数登记 18/26 + 新样本 2 条） | X2 漂移防护的登记义务，属协议演进的同步更新，非回归 |

canvas-storage.test.ts 12 例 = 契约套件 4×2 后端（往返/etag 稳定性、miss-null/remove 幂等/list 排序、
ifMatch 冲突→StorageConflictError、非法 canvasId 拒绝）+ 绑定门面 5 例（无绑定逐字节旧行为、
同步上传与 hash 去重、冲突 LWW、refresh 拉取与未同步改动保护、autosave 挂点）+ 安全边界 1 例。

## build / lint

- `tsc -b`（app+server+scripts 三工程）、vite build（2474 modules）、esbuild compile:server：全过。
- `eslint .`：0 error（本轮修掉 6 处自引入 unused-var，模式=去解构改显式键复制）。

## verify 全跑后 git status

`git status --porcelain` 仅剩本任务文件改动（无脚本污染）；`_w/`、`_jqfilter.jq` 为工作笔记，交付 commit 前删除。
（注：既有 verify 脚本会写 `.govio/`，该目录 gitignore，不构成脏树。）

## 真实 S3 验证记录（RustFS，2026-11-14 worker 按用户指示补录）

**结论：15/15 PASS（SigV4 真实网关兼容性坐实）。** 环境：`wslc run -d -p 9000:9000 -p 9001:9001` RustFS
（docs/rustfs-usage.txt 流程；数据/日志在 %TEMP%/rustfs-t31/，容器名 rustfs-t31，stopped 保留可复用）。
驱动方式：临时 tsx 脚本（已删）直调**产品真实模块**（canvas-storage bind/sync/refresh、S3CanvasBackend、
share createShare/resolveShare/forkShare、s3-client SigV4），零 mock。

| # | 断言（全 PASS） | 证据摘要 |
|---|---|---|
| 1 | CreateBucket PUT SigV4 被 RustFS 接受 | status=200（错误签名必 403，即签名正确性证明） |
| 2 | ListObjectsV2 bucket root | status=200 |
| 3 | syncCanvasToRemote 真实上传 | synced=true，远端 etag=e1519fa8…（S3 原生 ETag，非本地 sha256 前缀） |
| 4 | 远端对象字节等值 | GET 200，与本地 sidecar 逐字节一致 |
| 5 | 内容未变跳过重复上传 | synced=false |
| 6 | S3 list() prefix 过滤 | 命中本画布 id |
| 7 | 对端改远端 → refresh 拉回 | pulled=true，本地 loadCanvas 变 peer-edit |
| 8 | 本地未同步改动不被覆盖 | pulled=false + conflict=true |
| 9 | 冲突后 sync LWW | synced=true + conflict=true + warn 留痕日志 |
| 10 | 远端终态=本地版本 | body 含 local-wip |
| 11 | 分享记录写远端 shares/ key | GET 200 |
| 12 | 删本地记录后跨实例经 profile 枚举发现分享 | resolveShare 命中，manifests=1 |
| 13 | 视图载荷无凭据/profile/endpoint 字样 | 深度字符串断言过 |
| 14 | fork 暂存 + forkFrom 血缘（shareId/canvasId 对齐） | readStagedFork 校验过 |
| 15 | 远端 remove 幂等 | true→false |

延迟观测：本地回环全程（含建桶）15 步 513ms，单对象 GET/PUT 亚 10ms 级——满足「秒级可接受」。

复现步骤：
1. 按 docs/rustfs-usage.txt 启动（凭据 env：RUSTFS_ACCESS_KEY/RUSTFS_SECRET_KEY 自选）；
2. 写 profiles 文件 {endpoint:"http://127.0.0.1:9000", region 任意, bucket:"govio-e2e", prefix:"t31", accessKeyIdEnv/secretAccessKeyEnv 指 env}，GOVIO_S3_PROFILES_FILE 指向它；
3. 直调 server/storage/* 与 server/share.ts 产品函数即可（本轮 e2e 脚本模式）。

### 仍未做（留给主会话的真实浏览器项）

1. `npm run dev` 起栈 → 活动会话 `POST /api/canvas-storage {"profile":…}` → S3 控制台确认对象 → 对端绑同 canvasId 打开会话验证自动 refresh。
2. 浏览器打开 `/share/<token>`：只读渲染、右栏 Manifest、复跑按钮、Fork 跳转续写（UI 冒烟）。
3. ListObjectsV2 >1000 key 翻页仍未实现（RustFS 实测通过不改变该边界；量级评估后处理，见遗留 1/7）。

## 手工冒烟（本机可验部分，已通过）

- `GET /api/shares/<bogus32hex>` → 404 `{error:"share not found"}`；非法形状 token → 404（不泄露路径）。
- 无 profiles 文件时全部新路径 no-op：`verify-permission-audit`（624 内）含 deleteSession 级联断言原样绿。
