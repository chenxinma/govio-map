# T3.2 只读分享与 fork 续写 · 设计（简版，存储层引用 T3.1 design.md）

任务：`docs/task-plan.json → P3.T3.2`；与 T3.1 合并单 worker 串行实施。
存储/绑定/凭据模型章节全部见 `docs/tasks/T3.1-canvas-team-storage/design.md`（§0.4 凭据安全、§0.5 配置与发现）。

## 1. 只读分享链接

- **形态**：`GET /share/<token>`（前端静态路由，token = `randomBytes(16).hex` 32 位）+ JSON API
  `GET /api/shares/<token>`。鉴权 = 「链接 + 随机令牌」级（任务纪律：不做账号体系，T3.3 再谈 SSO）。
- **内容**：ShareRecord 快照 = `{canvasId, sessionName, createdAt, canvas:{nodes,edges}, forkFrom?, manifests[]}`；
  manifests 从画布节点 `data.manifest` 抽取（AnalysisManifest 原文），只读视图右栏逐节点展示
  SQL/数据源/行列数/checksum/模型——即「打开时含 Analysis Manifest」。
- **只读的实现方式（三层，无一是「君子协定」）**：
  1. 视图层：ReactFlow `nodesDraggable=false / nodesConnectable=false / elementsSelectable=false`；
  2. 连接层：`/share/*` 页面**不建立 /ws 连接**（main.tsx 分支），agent 会话与 canvas_save 通道物理不存在；
  3. API 层：share 路由只有 GET 快照 / POST fork / POST rerun——没有任何能写源画布 sidecar 的入口；
     写回源画布唯一路径是会话态 WS `canvas_save`，只读视图无从触达。集成测试断言
     resolve/fork/rerun 之后源 `.canvas.json` 字节与 etag 恒定。

## 2. 只读态复跑（对齐 T1.2 语义）

T1.2 的复跑输入纪律是「只取 Manifest 固化的 SQL，不接受前端传入」——分享快照的 manifests 就是这份固化输入。
- `POST /api/shares/<token>/rerun {nodeId}` → `rerunDataFrame(manifest, {sessionId:"share:<token>"})` → 返回 RerunRecord
  （outcome identical/drift/error + before/after 快照）。
- **新副本语义**：结果只进 HTTP 响应与分享视图内存态（右栏「复跑结果」卡片）；不写任何画布 sidecar、
  不进 localStorage、不回源画布。govio-cli 复跑临时 DataFrame 按 T1.2 既有纪律以临时名加载并 release。
- 无快照 Manifest 的节点：409（与主界面复跑同文案纪律）。

## 3. fork 续写与派生血缘

流程：分享视图「Fork 续写」→ `POST /api/shares/<token>/fork`（服务端把快照暂存
`.govio/forks/<forkId>.json`，含 `forkFrom`）→ 跳转 `/?fork=<forkId>` → 主界面会话就绪后
WS `canvas_fork_apply {forkId}` → 服务端写入**本地当前会话** sidecar（顶层键 `forkFrom`）→
`fork_applied` + `canvas_restore` 水合成可写画布，暂存文件消费即删。

- **血缘记录在哪**：新画布 `.canvas.json` 顶层 `forkFrom = {kind:"share", shareId, canvasId, sessionName, sharedAt, forkedAt}`
  ——随画布工件走（本地/绑定 S3 后同步远端/再分享继承），**画布级派生关系可追溯**；
  派生画布再分享时 ShareRecord.forkFrom 直接继承（测试断言链式传承）。
- **抗 autosave**：`saveCanvas` 无 meta 调用（前端 1s debounce 快照）时保留既有顶层附加键——
  否则 forkFrom 会在第一次自动保存时被抹掉（集成测试「血缘抗 autosave」专门锁这一行为）。
- **不动数据血缘**：`src/utils/lineage.ts` 语义边逻辑零改动；forkFrom 是画布对画布的关系，不是节点间边。
- fork 目标 = fork 操作者本机的新会话画布；**源画布零写入**（第一性原则，见 §1.3）。

## 4. WS 协议（X2 契约）与版本决策

新增 `canvas_fork_apply`（客户端）/ `fork_applied`（服务端），走版本化 schema（`$id: govio-ws/v1/<type>` + version 元数据）。
`PROTOCOL_VERSION` 维持 1：X2 既有语义是 version 不上线、前后端同仓同构建；新增成员对旧端分别由
「客户端忽略未知服务端消息」「旧服务端拒绝未知客户端消息（同仓部署对里不存在该组合）」兜住。
契约测试登记了新样本并把计数 17→18 / 25→26（漂移防护按 X2 设计意图同步更新，属协议演进的登记义务）。

## 5. 遗留问题

1. 分享无过期/撤销（同 T3.1 遗留 4）。
2. fork 不携带会话对话历史（pi SessionManager 边界，T3.1 遗留 5）。
3. ShareView 用轻量自绘卡片（type/标题/SQL 摘要），未复用 Nodes/*.tsx 全功能渲染（依赖 store/context 较深）；
   图表节点在分享视图暂以占位卡展示，Plotly figure 数据在快照里完整保留，渲染器升级留待后续。
4. 令牌可被同网络任意人使用（本地工具基线 + 只读）；若部署到共享主机需 T3.3 会话隔离兜底。
