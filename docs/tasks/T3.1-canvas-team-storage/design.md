# T3.1 画布团队存储抽象 · 设计（含 T3.2 合并阶段）

任务：`docs/task-plan.json → P3.T3.1`（与 T3.2 合并单 worker，用户决策 2026-11-14）。
分支：t3-storage-sharing；commit 前缀 `T3.1:`（正文注明 merged with T3.2）。

## 0. 技术可行性评估（先于编码的结论）

**结论：可行（有条件）。** 有条件指：真实 S3 环境的端到端延迟与凭据下发需主会话补录验证；
本机以 mock/契约测试证明正确性。

### 0.1 架构约束与写入模型

| 事实 | 推论 |
|---|---|
| pi `SessionManager` 直接写本地会话 jsonl，外部依赖不可改 | 会话正文**不可能直写 S3**；跨端共享的只能是「画布工件 + Manifest + 分享记录」 |
| 三类 sidecar（canvas/审计/注入）是本仓自有代码 | sidecar 可插拔后端化；其中**画布 sidecar 是团队协作真源**，审计/注入是本机留痕（合规、含命令原文），保持本地不上云 |
| `saveCanvas/loadCanvas` 是**同步** API，被 9 个脚本 + 多个测试同步调用 | 接口化不能把同步签名改异步（回归成本不可控）；采用「本地同步写 + fire-and-forget 异步同步 S3」 |
| S3 无原子 rename、无文件锁 | 并发写必须显式选策略（见 0.3） |
| canvas.json 可到 MB 级 | 读路径只在会话打开/分享解析时异步拉取（秒级可接受）；交互路径（canvas_save/loadCanvas）保持纯本地微秒级，交互不卡死 |

**写入模型（定案）：本地写 + 异步同步（write-local + background sync）**
- `saveCanvas`：同步写本地 sidecar（既有行为逐字节不变）→ 成功后若该画布有 S3 绑定，fire-and-forget `syncCanvasToRemote`（内容 hash 未变则跳过）。
- `loadCanvas`：同步读本地（不变）。
- 会话打开（`pushSessionState`）：`await refreshCanvasFromRemote` 把远端更新拉回本地缓存（无绑定 = no-op；失败降级本地缓存不阻塞打开）。
- 多端「同一画布」的最终一致性窗口 = 同步队列延迟（亚秒）+ 对端重新打开/显式 refresh。这是画布协作（低频编辑 + 秒级容忍）可接受的一致性级别，符合任务「可接受秒级加载、不可接受交互卡死」约束。

### 0.2 依赖取舍（S3 客户端）

| 方案 | 评估 |
|---|---|
| `@aws-sdk/client-s3` | 30+ 传递依赖、体积大；本仓 `package.json` 纪律克制（新依赖需论证）；锁定文件与 CI 安装面扩大 |
| **零依赖 SigV4 REST 自实现（定案）** | SigV4 用 `node:crypto` + 全局 `fetch` 约 130 行即可覆盖所需四操作（PUT/GET/DELETE/ListObjectsV2）；同一实现天然兼容 S3 网关（MinIO/R2/阿里云 OSS S3 兼容层，path-style + endpoint 覆写）；可用 fetch 替身做无网络契约测试 |
| 委托 S3 兼容网关代理 | 违背「不新作文件服务后端」用户决策 |

风险与缓解：自实现签名的正确性——SigV4 为定规范算法（HMAC-SHA256 链式密钥派生），已按规范实现 `server/storage/s3-client.ts`；真实凭据冒烟列入「待主会话补录」。

### 0.3 并发写与一致性（定案：乐观锁 + 最后写入胜出）

- 每次同步携带上次记录的 `remoteEtag` 做 `If-Match`；412 → 判定并发冲突。
- 冲突处理：默认**最后写入胜出**（重读远端后无锁覆写 + `console.warn` 留痕，不静默）。理由：画布编辑节奏是前端 debounce 1s 的整幅快照，字段级合并（CRDT）在此规模是过度设计；冲突留痕 + 会话打开时 refresh 保证可见性收敛。
- `refreshCanvasFromRemote` 的对称规则：本地存在**未同步改动**（内容 hash ≠ lastSyncedHash）且远端不同时，不强覆盖本地，返回 `conflict: true`——用户下一次保存自然走 LWW。

### 0.4 凭据安全（硬边界）

- 凭据只存在于**服务端 profile 配置文件 + 环境变量**两层：配置文件仅存 **env 变量名**（`accessKeyIdEnv/secretAccessKeyEnv/sessionTokenEnv`），运行时 `resolveS3Target` 从 `process.env` 取值。
- 画布 JSON、存储绑定 sidecar（`.storage.json`，只记 profile 名/canvasId/同步元数据）、分享记录、HTTP 响应、日志错误消息（只含 env 名，不含值）均**不含凭据**——有集成测试对全部工件做深度字符串断言。
- 分享链接携带的只有随机令牌（`randomBytes(16)` hex）；`GET /api/shares/<token>` 视图载荷连 profile 名都剥除。

### 0.5 配置粒度与多端发现（任务留给 worker 定案项）

- **粒度**：逐画布。绑定 sidecar `<session>.storage.json` = `{backend:"s3", profile, canvasId, lastSyncedHash, remoteEtag}`。
- **谁配**：本会话内用户经 `POST /api/canvas-storage`（profile 名来自服务端配置文件，由部署者维护）；无 UI 入口是本任务刻意取舍（配置即 API），见遗留问题。
- **画布 ID ↔ S3 key 映射**：`canvasId := 会话文件基名（去 .jsonl）`（pi 生成、天然全局唯一、无穿越风险）；key = `<profile.prefix>/<canvasId>/canvas.json`。**多端指向同一 profile+canvasId = 同一地址**（协作的「共享房间」就是显式绑定同一 canvasId）。
- **分享跨实例发现**：分享记录本地必写，S3 绑定画布再写远端 `<prefix>/shares/<shareId>.json`；对端实例解析令牌时先查本地、再逐个已配置 profile 查远端（`resolveShare`），无需全局注册中心。

## 1. T3.1 实施（存储接口化 + Local + S3）

### 1.1 模块图

```
server/storage/
  backend.ts        CanvasStorageBackend 接口 + canvasId/shareId 白名单 + StorageConflictError
  paths.ts          sidecar 路径单一来源（canvasPathFor 由 session-history re-export 保持兼容）
  local-backend.ts  LocalCanvasBackend（etag=sha256 前 16 位；ifMatch 冲突）
  config.ts         S3 profiles 文件（env 引用式凭据）+ resolveS3Target
  s3-client.ts      零依赖 SigV4 REST（PUT/GET/DELETE/ListObjectsV2）
  s3-backend.ts     S3CanvasBackend（<prefix>/<canvasId>/canvas.json + shares/ key 布局）
  canvas-storage.ts 绑定 sidecar 读写 + sync/refresh 门面 + queueRemoteSync/Delete 挂点 + 测试注入钩子
```

### 1.2 安全边界等价性

- 客户端可传的仍是**会话 path**：`assertValidSessionPath` 不变（目录内 .jsonl）。
- 新接口只接受 `canvasId`（白名单正则 + 拒绝 `..`/分隔符/超长），LocalBackend 再叠加「解析后仍在 root 内」双保险；调用方无法注入路径。
- 绑定文件与远端 key 均由服务端从 sessionFile 派生，前端不能指定路径。
- 默认态（无 profiles 文件、无绑定 sidecar）：所有新代码路径为 no-op，行为与 main 完全一致——既有 624/194/31 断言原样通过即回归证明。

### 1.3 与既有子系统的边界

- 审计/注入 sidecar：**不入 S3、不进分享**（本机合规留痕；导出/审计范围不变）。
- 会话 jsonl：不上传（pi 边界 + 隐私）；跨端协作共享的是画布工件与 Manifest。fork 快照只含 canvas nodes/edges/血缘。
- `buildTranscript/buildRounds`：零改动（任务纪律）。

## 2. T3.2 分享与 fork（要点见 docs/tasks/T3.2-sharing-fork/design.md）

摘要：只读链接 `/share/<token>`（静态页，不建 /ws，从连接层杜绝写回源画布）；打开含 Manifest 清单；
只读态复跑 = 按快照 Manifest 固化 SQL 走 `rerunDataFrame`（T1.2 语义），结果只进响应与本视图内存态；
fork = `POST …/fork` 暂存 + 主界面 `canvas_fork_apply`（新 WS 消息）写入**本地新会话**，画布 JSON 顶层
`forkFrom` 血缘键抗 autosave（`saveCanvas` 无 meta 时保留既有顶层附加键），派生链可跨代传承。

## 3. WS 协议（X2 契约）

新增：客户端 `canvas_fork_apply {forkId?}`、服务端 `fork_applied {forkId, forkFrom}`。
**PROTOCOL_VERSION 保持 1**：按 X2 兼容策略——新增服务端消息旧客户端忽略不崩；新增客户端消息只会
出现在同仓同构建的前后端对中（version 不上线的既有语义，见 ws-protocol.ts 文件头）；无存量消息字段变更。
未新增 `$id` 之外的 schema 构件；`scripts/verify-ws-protocol` 型注册表测试由既有 vitest ws-protocol.test.ts
覆盖模式（本次以新增消息进入 union 的形式自动纳入注册表）。

## 4. 遗留问题

1. **真实 S3 端到端未验**：sigv4 正确性、path-style vs virtual-host、ListObjectsV2 分页（>1000 key 未实现翻页——画布数量级远低于此）待主会话用真实凭据补录（verification.md 附步骤）。
2. **绑定无 UI 入口**：仅 API/HTTP 可配（刻意的最小面）；建议后续在画布头部加「团队存储」指示与绑定弹层（属功能不属本任务 scope）。
3. **canvas 冲突仅 LWW + 留痕**：未做整幅快照三方合并（local/remote/base 差异提示）；若团队并发编辑成为常态，考虑把 `conflict` 透传 WS 提示条。
4. **分享无过期/撤销**：令牌永久有效（文件即记录）；`DELETE /api/shares/<token>`（本地删 + 远端尽力删）留待下一迭代——涉及生命周期与合规，暂不拍脑袋加。
5. **fork 的会话 jsonl 不带过去**：fork 副本只共享画布工件（0.1 的 pi 边界决定）；如需「对话历史随 fork 带走」需先突破 SessionManager 写入边界（高风险，单独立项）。
6. **queueRemoteSync 进程退出时可能丢最后一窗口的上传**：未做 flush-on-shutdown；低频协作可接受，出现丢同步再补 `process.on("beforeExit")`。
7. **多画布同 profile 的 list 归集**：`S3CanvasBackend.list()` 一次性 ListObjectsV2 未翻页（同 1）。
