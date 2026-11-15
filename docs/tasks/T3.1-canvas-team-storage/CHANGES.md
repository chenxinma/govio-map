# T3.1（merged with T3.2）文件清单

## 存储抽象层（新增 server/storage/）
- backend.ts：`CanvasStorageBackend` 接口（read/write/remove/list + etag/ifMatch）、`StorageConflictError`、
  `assertValidCanvasId`/`assertValidShareId` 白名单（与 assertValidSessionPath 等价安全边界）、`canvasIdFromSessionFile`。
- paths.ts：canvas sidecar 与 `.storage.json` 绑定文件路径单一来源。
- local-backend.ts：`LocalCanvasBackend`（生产默认；etag=sha256 前 16；ifMatch 冲突；解析后 root 内双保险）。
- config.ts：S3 profiles（`GOVIO_S3_PROFILES_FILE` / `.govio/storage-profiles.json`）；凭据 = env 变量名引用 +
  全字段白名单校验 + mtime 缓存；`resolveS3Target` 错误消息只含 env 名。
- s3-client.ts：零依赖 SigV4 REST（HMAC 密钥派生链 + UNSIGNED-PAYLOAD-哈希头，PUT/GET/DELETE/ListObjectsV2、
  If-Match、AbortController 超时、fetchImpl 注入点）。
- s3-backend.ts：`S3CanvasBackend`——key 布局 `<prefix>/<canvasId>/canvas.json`、`shares/<shareId>.json`；
  412→StorageConflictError；targetResolver/fetchImpl 测试替身钩子。
- canvas-storage.ts：绑定读写（`bindCanvasStorage/clearStorageBinding`）+ `syncCanvasToRemote`（hash 去重 +
  If-Match 冲突→LWW 留痕）+ `refreshCanvasFromRemote`（本地未同步改动保护）+ `queueRemoteSync/queueRemoteDelete`
  挂点 + `setBackendFactoryForTests`。

## 既有文件改动
- server/session-history.ts：saveCanvas 增第 4 参 meta 且无 meta 时保留顶层附加键（T3.2 血缘抗 autosave）+
  成功后 queueRemoteSync；deleteSession 级联绑定 sidecar（先 queueRemoteDelete 再 unlink）；canvasPathFor
  re-export（公共 API 不变）。
- server/ws-handler.ts：pushSessionState 前 await refreshCanvasFromRemote（失败降级日志）；新增 `canvas_fork_apply` case。
- server/backend.ts：挂载 handleShareApi。
- src/types/ws-protocol.ts：+`canvas_fork_apply`（client 18）/`fork_applied`（server 26）；PROTOCOL_VERSION=1（论证见 design.md §3）。
- src/main.tsx：/share/<token> 分支（不建 /ws）。
- src/hooks/useChat.ts：?fork= 接力 + session_ready 首发 fork 应用。
- src/components/Chat/ChatPanel.tsx：分享按钮（POST /api/shares + 复制链接）。
- src/components/Share/ShareView.tsx（新增）：只读视图（ReactFlow 只读 + Manifest 右栏 + 复跑 + Fork）。

## 分享/fork（T3.2，同 commit 族；清单亦见 docs/tasks/T3.2-sharing-fork/CHANGES.md）
- server/share.ts、server/share-api.ts（新增）。

## 测试
- tests/integration/canvas-storage.test.ts（新增，12 用例）：接口契约双后端 4×2、绑定同步门面 5、安全边界。
- tests/integration/share-fork.test.ts（新增，9 用例）。
- tests/integration/ws-protocol.test.ts：按 X2 漂移防护登记新消息（样本 +2，计数 18/26）。

## 文档
- docs/specs/06-backend.md：画布存储与分享 API 小节；docs/tasks/T3.1-*/、docs/tasks/T3.2-*/ 三件套。
