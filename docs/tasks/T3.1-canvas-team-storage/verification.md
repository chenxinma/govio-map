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

## 待主会话补录（真实 S3 环境）

1. 准备 S3 兼容桶（AWS/MinIO/R2 皆可），写 `.govio/storage-profiles.json`：
   `{"version":1,"profiles":{"team-a":{"endpoint":"https://…","region":"…","bucket":"…","prefix":"govio","accessKeyIdEnv":"GOVIO_S3_AK","secretAccessKeyEnv":"GOVIO_S3_SK"}}}`；
   export 两个 env 后启动 `npm run dev`。
2. 会话 A：画布出几个节点 → `curl -X POST localhost:5174/api/canvas-storage -d '{"profile":"team-a"}'` →
   控制台 `curl -s localhost:5174/api/preview` 无关；直接到 S3 控制台确认 `<prefix>/<canvasId>/canvas.json` 已上传、
   `<session>.canvas.json.storage.json` 记录 lastSyncedHash/remoteEtag。
3. 会话 B（另一台机器/另一份 checkout 同 profile）：把 canvasId 对齐（绑定时传 `{"profile":"team-a","canvasId":"<A的canvasId>"}`）→
   打开会话（pushSessionState 自动 refresh）→ 画布一致；实测 SigV4 签名正确性（错误签名会 403 SignatureDoesNotMatch）。
4. 分享跨实例：A 绑 S3 后 `curl -X POST localhost:5174/api/shares` → 把 `/share/<token>` 链接给 B →
   B 本机无分享记录，resolveShare 逐 profile 扫远端命中 → 只读视图打开（验证 MB 级 canvas.json 的加载延迟在秒级）。
5. 并发写：两端先后 canvas_save（间隔 <1s）→ 观察 `[storage] canvas … last-write-wins` warn 出现且最终一端胜出。
6. ListObjectsV2 >1000 key 分页未实现（遗留 1），量级评估后再定。

## 手工冒烟（本机可验部分，已通过）

- `GET /api/shares/<bogus32hex>` → 404 `{error:"share not found"}`；非法形状 token → 404（不泄露路径）。
- 无 profiles 文件时全部新路径 no-op：`verify-permission-audit`（624 内）含 deleteSession 级联断言原样绿。
