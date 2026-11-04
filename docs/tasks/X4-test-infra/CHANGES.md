# X4 CHANGES：核心链路集成测试基建

## 文件清单

| 文件 | 变更 | 摘要 |
|---|---|---|
| `vitest.config.ts` | 新增 | vitest 配置：environment node、include `tests/integration/**`、isolate 每文件独立 worker、20s 超时 |
| `tests/integration/ws-handler.test.ts` | 新增 | 链路①：真实 setupWebSocket + ws 客户端，vi.mock agent/backend/models-config；session_ready 推送、prompt REF 前缀、权限 allow/deny/edit 三分支、accept-all 留痕、非法 JSON / 越界 session_open / abort / canvas_save 边界（10 用例） |
| `tests/integration/govio-canvas-extension.test.ts` | 新增 | 链路②：stub pi 驱动扩展；observe load → dataFrame 事件（列结构/Manifest/血缘）、success:false 与非法 JSON 不建节点、非法 dfName 注入防护、govio_show_dataframe / govio_create_source_table 工具、message_end ```sql → sqlQuery 事件（10 用例） |
| `tests/integration/canvas-store.test.ts` | 新增 | 链路③：createGovioNode 各 nodeType 字段、referencedNodes/sourceRefs 自动边、positionNewNode 布局不变量、dataFrame 去重回填 Manifest、未知 nodeType 忽略（11 用例） |
| `tests/integration/canvas-sidecar.test.ts` | 新增 | 链路④：saveCanvas/loadCanvas 往返深度相等、中文/引号/换行无损、store→sidecar→hydrateSession 全链路、文件缺失/损坏 JSON/形状不合法返回 null（7 用例） |
| `package.json` | 修改（2 处） | ① `scripts.verify` 链末尾追加 `npm run verify:integration`；② 新增 `verify:integration` / `test:integration`（均 = `vitest run`）+ devDependencies `vitest@^5.1.0` |
| `package-lock.json` | 修改 | vitest 5.1.0 及其依赖树 |
| `docs/tasks/X4-test-infra/{design,CHANGES,verification}.md` | 新增 | 三件套交付物 |

## 关键实现点

- **零业务代码改动**：`server/`、`src/` 均未修改；mock/stub 全部在测试侧
  （vi.mock 模块替换 + `vi.stubGlobal` localStorage stub）。
- ws-handler 首帧竞争：`connectWithCollector()` 在同一 tick 内先挂 message listener 再等 open，
  避免丢 `session_ready` 首帧（服务端 connection 回调 async，首帧可能在 open 后同步段内发出）。
- govio-canvas 失败载荷回退路径由 vi.mock 的 `runGovioCli`（抛错 → readObserveInfo 返 null）覆盖，
  固化 BUGFIX-load-parse / BUGFIX-df-columns 教训为断言。
- 既有 6 个 verify 脚本零改动、零回归；断言数前后不变（92/71/119/126/39/13）。
