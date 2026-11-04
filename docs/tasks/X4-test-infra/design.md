# X4 设计：核心链路集成测试基建

## 1. 目标

为 govio-map 四条核心链路建立集成测试回归防线（此前 `npm run verify` 只有 6 个专项脚本，
ws 消息处理 / 权限决策流 / govio-canvas 事件转换 / canvas-store 与 sidecar 持久化均无防护）：

- ① ws-handler 消息处理 + permission-manager allow/deny/edit 决策分支
- ② govio-canvas 扩展：工具结果 / `message_end` → `GovioNodeCreateEvent` 转换
- ③ canvas-store：`createGovioNode` 节点创建、自动边生成、`positionNewNode` 布局
- ④ canvas sidecar（.canvas.json）持久化往返

## 2. 框架选型（取舍）

| 候选 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **vitest 5.1.0**（选定） | 与 vite 生态一致（项目已用 vite 8）；`vi.mock` 原生 ESM 模块 mock（ws-handler 测试必需，需替换 `server/agent.js`/`backend.js`/`models-config.js`）；TS/ESM 零配置；`vi.waitFor` 轮询断言 | 引入新依赖 | ✅ 采用 |
| node:test + tsx | 零新依赖 | 无模块级 mock 能力（ws-handler 静态 import 的 agent/backend 无法替换）；断言生态弱 | ❌ 无法满足 ① |
| jest | 生态成熟 | ESM + TS 支持需 babel/ts-jest 配置，与项目 esbuild/vite 栈割裂 | ❌ 过重 |

版本选择 vitest 5.1.0（当前 latest，peer 兼容 vite ^8）。

## 3. 测试布局

```
vitest.config.ts                     # environment: node, include: tests/integration/**
tests/integration/
  ws-handler.test.ts                 # 链路①（10 用例）
  govio-canvas-extension.test.ts     # 链路②（10 用例）
  canvas-store.test.ts               # 链路③（11 用例）
  canvas-sidecar.test.ts             # 链路④（7 用例）
```

与既有 `scripts/verify-*.ts`（断言计数风格的验证脚本）并存、互不干扰；
`npm run verify` 聚合链末尾追加 `npm run verify:integration`（= `vitest run`）。

## 4. 关键实现决策

### 4.1 ws-handler 测试（链路①）

- **真实 `setupWebSocket` + 真实 `ws` 客户端**：不抽接口、不改业务代码（零可测性侵入）。
- **vi.mock 三个模块**：`server/agent.js`（fake session：prompt/steer/followUp/abort 清单可断言）、
  `server/backend.js`（isAgentConfigNeeded 恒 false）、`server/models-config.js`（不读真实 `~/.pi`）。
- **首帧竞争问题（踩坑）**：服务端 `connection` 回调是 async（`await getOrCreateSession()`），
  首帧 `session_ready` 可能在客户端 `open` 事件后同步段内发出。若 `connect()` resolve 后再挂
  message listener，会丢首帧。解决：`connectWithCollector()` 在构造时同一 tick 内先挂 listener
  再等 open。调试期间曾误诊为「服务端 send 被吞」，实际是客户端 listener 挂载时机问题。
- 覆盖 allow/deny/edit 三分支（经 `tool_permission_request` 推送 + `tool_permission_response`
  回写的真实链路），accept-all 不打扰前端但仍返回 decisionId，以及非法 JSON / 越界
  session_open / abort / canvas_save 边界。

### 4.2 govio-canvas 扩展测试（链路②）

- **stub pi**（registerTool / on 捕获处理器），与既有 `verify-source-table.ts` 同款成熟模式。
- `server/agent.js` 的 `runGovioCli` 以 vi.mock 桩掉（`readObserveInfo` 回退路径返回 null →
  失败载荷不建节点，恰好覆盖 BUGFIX-load-parse 场景）。
- 重点断言（BUGFIX 教训固化）：`success:false` 不建节点；非法 JSON 输出回退复核不建节点；
  `column_info` 列结构必须进事件（BUGFIX-df-columns）；非法 dfName 注入防护；
  `--memory` 血缘 `source_tables` 只保留 SQL 提及的 df。

### 4.3 canvas-store 测试（链路③）

- 直接 `useCanvasStore.getState().createGovioNode(...)` 驱动（与 verify-manifest-roundtrip 同款）。
- persist 中间件读 `window.localStorage`：node 环境注入内存 stub（`vi.stubGlobal`）。
- 布局断言用「位置互异 / 单调递增」这类布局意图级不变量，不钉死具体坐标常量
  （坐标随 `GAP_X/GAP_Y` 演进时测试不失效）。

### 4.4 sidecar 往返测试（链路④）

- 真实 `saveCanvas`/`loadCanvas`/`canvasPathFor`（`server/session-history.ts`），tmp 一次性会话文件。
- 往返断言用 `JSON.stringify` 深度相等（与 verify-manifest-roundtrip 风格一致）。
- 失败/边界：文件不存在 / 损坏 JSON / 形状不合法（nodes 非数组）均返回 null。
- 含中文、引号、换行的 SQL/标题往返无损（编码回归）。

## 5. 可测性改动

**零业务代码改动**。所有 mock / stub 均在测试侧完成（vi.mock + stubGlobal），
`server/`、`src/` 均未修改。

## 6. 遗留问题

- ws-handler 的 `handleCanvasConnection`（/canvas 通道广播）未覆盖：其行为 =
  `onGovioNodesFlushed` 回调转发，核心转换逻辑已由链路②覆盖；完整 /canvas WS 广播
  可在后续任务补一条端到端用例。
- `session_open` 成功路径依赖真实 SessionManager 文件交互，当前只测了拒绝分支；
  成功分支可与 X7 的伪会话头 fixture 合并后补测。
- vitest 5.1.0 的 `isolate: true`（每文件独立 worker）保证文件间不共享 govio-node-queue /
  permission 单例状态；若未来测试提速需要改 `isolate: false`，必须先给这些单例加 reset 钩子。
