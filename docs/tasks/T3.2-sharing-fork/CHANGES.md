# T3.2 交付文件清单（与 T3.1 同分支单 commit 族，见 git log T3.1 前缀）

- server/share.ts（新增）：ShareRecord 模型、createShare/resolveShare/forkShare/readStagedFork/consumeStagedFork、
  manifests 抽取、远端 share 存取（transport 可注入替身）、shareViewPayload 剥凭据、令牌白名单。
- server/share-api.ts（新增）：HTTP 路由 POST /api/shares、GET /api/shares/<token>、
  POST …/fork、POST …/rerun、GET/POST /api/canvas-storage（绑定配置，响应不含凭据）。
- server/backend.ts：createServer 回调挂载 handleShareApi。
- server/ws-handler.ts：`canvas_fork_apply` case（校验 forkId → 暂存读取 → saveCanvas(meta.forkFrom) →
  fork_applied + canvas_restore → 暂存消费即删）；pushSessionState 前置 refreshCanvasFromRemote。
- server/session-history.ts：saveCanvas 增 meta 顶层键 + 无 meta 时保留既有附加键（血缘抗 autosave）。
- src/types/ws-protocol.ts：新消息 schema 注册（v1 不变，理由见 design.md §4）。
- src/components/Share/ShareView.tsx（新增）：只读画布 + Manifest 右栏 + 复跑 + Fork 续写 + 复制链接。
- src/main.tsx：/share/<token> 路由分支（不建 /ws）。
- src/hooks/useChat.ts：?fork= 接力参数（读后即清），session_ready 首发 canvas_fork_apply。
- src/components/Chat/ChatPanel.tsx：头部分享按钮（POST /api/shares → 复制只读链接）。
- tests/integration/share-fork.test.ts（新增，9 用例）；tests/integration/ws-protocol.test.ts（登记新消息，19 用例复绿）。
- docs/specs/06-backend.md：分享/存储 API 小节。
