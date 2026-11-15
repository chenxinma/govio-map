# T3.2 验证（自述验收证据；门槛全量记录见 T3.1 verification.md）

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/integration/share-fork.test.ts` | 9/9 通过 |
| `npx vitest run tests/integration/ws-protocol.test.ts` | 19/19 通过（登记 18/26 新计数） |
| `npm run build` / `npm run lint` | 0（见 T3.1 verification.md 同轮全跑） |

关键断言（share-fork.test.ts）：
- createShare→resolveShare 往返等值、令牌形状、坏记录视为不存在（404 语义）
- 视图载荷剥 profile/originBackend；share 记录、绑定 sidecar、远端 transport 落料——四类工件全深度扫描不含凭据值
- 只读纪律：resolve/fork 前后源 `.canvas.json` 字节与 etag 恒定
- S3 绑定画布分享写远端 key；删除本地记录后仍能经 profile 枚举跨实例发现（分享即 S3 交换层）
- fork：暂存→应用后 forkFrom 落 canvas.json 顶层；kind/canvasId/shareId 齐备；forkedAt 有值
- 血缘抗 autosave：无 meta saveCanvas 后 forkFrom 仍在（nodes/edges 正常覆写）
- 派生链传承：fork 画布再分享，ShareRecord.forkFrom 指向祖先分享与源 canvasId
- 非法令牌/forkId：forkShare 未知令牌 null、readStagedFork 非形状 id null（不 500、不泄露路径）

待主会话补录（真实环境）：
1. 浏览器开 `http://localhost:5173/share/<token>`：只读渲染、右栏 Manifest、复跑卡片、Fork 跳转后画布可编辑且血缘存在。
2. 双实例（两份 checkout 各起 5173/5174）指向同一 profile+canvasId：A 分享 → B 打开链接可见、fork 可续写。
