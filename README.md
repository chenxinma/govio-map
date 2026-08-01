# Govio Map

无限画布数据治理工具。通过自然语言对话驱动 AI Agent（基于 [pi-coding-agent](docs/pi/)）执行数据查询、探索与分析，结果以可视化卡片节点形式在画布上编排，并自动建立数据血缘连线。

```
SourceTable ──▶ SQL ──▶ DataFrame ──▶ Report / Chart
```

## 快速开始

### 前置依赖

- **Node.js**
- **`govio-cli`**：外部 CLI，需安装并置于 PATH。后端启动时会执行 `govio-cli -V` 校验，缺失则启动失败。运行时数据写入 `.govio/`（已 gitignore）
- 至少一个 AI 提供商的 API Key

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env`，设置至少一个 API Key。pi-coding-agent 经 `ModelRuntime` 读取凭据，优先级：运行时覆盖 > `~/.pi/agent/auth.json` > 环境变量：

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# 或 OPENAI_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY
```

也可将凭据持久化到 `~/.pi/agent/auth.json`。

### 3. 启动开发服务器

```bash
npm run dev
```

- Vite 前端：`http://localhost:5173/`
- 后端服务（HTTP + WebSocket）：端口 `5174`（= Vite 端口 + 1）
  - `ws://localhost:5174/ws` — 对话通道
  - `ws://localhost:5174/canvas` — 画布节点流
  - `GET /api/preview?df=<name>&rows=<n>` — DataFrame 预览（读取 `.govio/observe/dataframes/*.parquet`）

Chat 面板自动连接 `/ws`。**当前不再有 Mock AI 降级**——后端未连接时输入框禁用并提示“未连接到服务器”。

其他脚本：`npm run build`（类型检查 + 构建）、`npm run preview`、`npm run ask -- -m "消息"`（单次 CLI 对话，见 `server/cli.ts`）。

## 工作原理

```
ChatPanel ──(/ws)──▶ ws-handler ──▶ agent.ts (pi AgentSession)
                                       │  govio-canvas 扩展（工具 + 事件钩子）
                                       ▼
                       govio-node-queue（缓冲，message_end / tool_end 时 flush）
                                       │ (/canvas)
                       canvas-service ──▶ canvas-store.createGovioNode()
```

1. 用户在 ChatPanel 输入指令 → `useChat.send()` 经 `/ws` 发送 `{type:"prompt", content, referencedNodes}`。
2. `ws-handler` 将引用节点序列化为 `REF:[...]` 前置到 prompt，调用 pi `session.prompt()`（流式中则 `session.steer()` 插队）。
3. pi 事件流回传：`agent_start` / `message_start` / `text_delta` / `thinking_delta` / `tool_start` / `tool_end` / `message_end` / `agent_end`。
4. `govio-canvas` 扩展拦截 bash 工具结果与 `message_end`：把 SQL 代码块、`govio-cli observe load/compare/explore` 结果、图表配置解析为 `GovioNodeCreateEvent`，入队缓冲后 flush 到 `/canvas`。
5. `canvas-service` 接收事件 → `canvas-store.createGovioNode()` 创建 ReactFlow 节点，按 `referencedNodes` / `sourceRefs` 自动连线，经 `positionNewNode` 增量定位。

pi-coding-agent（`@earendil-works/pi-coding-agent`）是内嵌的 AI 编码 Agent SDK，负责对话推理、流式输出、内置文件/shell 工具、技能（skills）与权限钩子。本项目通过其扩展机制注册 `govio_create_source_table` / `govio_show_chart` 工具与事件钩子，把 Agent 行为桥接到画布。SDK 与 JSON 协议详见 `docs/pi/`。

## 交互操作

### 对话与流式输出

在 Chat 面板输入自然语言（如“按区域统计客户账单”“分析账单与收款的相关性”），Agent 流式回复，支持折叠的 Thinking 与工具调用 pill。流式过程中再次发送会以 `steer` 插队。

### 引用节点到对话

点击卡片底部 **引用**，节点以标签进入输入框；被引用节点的数据（SQL 文本 / DataFrame 名 / 表结构）会作为上下文附加到 prompt，供 Agent 参考。

### 斜杠命令

输入 `/` 触发命令建议：

- **内置**：`/clear`（重置会话）、`/clear-canvas`（清空画布 + 消息）、`/export`（导出会话为 JSON）
- **自定义**（prompt 模板，来自 `src/data/commands.json`）：`/sql`、`/analyze`、`/release-df`

### 节点查找

画布顶部查找栏按标题搜索节点，Enter 循环定位并居中视图。

### 预览 DataFrame

点击 DataFrame 卡片 **预览**，弹出可拖拽悬浮面板，分页展示真实数据（经 `/api/preview` 读取 parquet）。

### 图表放大

点击 Chart 卡片放大查看，Esc 关闭。

### 连线

从节点右侧输出端口拖到左侧输入端口建立连线；新建节点也会按引用关系自动连线。

### 权限确认

当 Agent 执行含 `-o` / `--output` 的 `govio-cli observe load` 数据导出命令时，弹出权限卡片，可选 **允许 / Accept All / 编辑 / 拒绝**。Accept All 后本会话内自动放行；超时（5 分钟）自动拒绝。

## 节点类型

| 类型 | 标识色 | 内容 | 创建来源 |
|------|--------|------|----------|
| SourceTable | 紫色左边框 | 表名、数据库、字段（PK/FK） | `govio_create_source_table` 工具 |
| SQL | 绿色左边框 | SQL 语句、输出列（双击编辑） | `message_end` 提取 SQL 块 / 工具栏手动新建 |
| DataFrame | 橙色左边框 | df.info 信息、预览 | `govio-cli observe load` 结果解析 |
| Report | 琥珀(差异) / 紫(相关性) | 差异比较或相关性分析报告 | `observe compare` / `observe explore` 解析 |
| Chart | 蓝色左边框 | chart.js 图表（可放大） | `govio_show_chart` 工具 |

## 布局

数据血缘从左至右延展，Dagre 自动排版（`network-simplex`），支持手动拖拽与 snap-to-grid（15px）。画布状态持久化到 localStorage（`govio-canvas-state`），刷新不丢失。

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript |
| 构建 | Vite |
| 画布 | @xyflow/react (ReactFlow) |
| 状态 | Zustand（persist → localStorage） |
| 布局 | @dagrejs/dagre |
| 样式 | Tailwind CSS v4 |
| 图表 | chart.js |
| AI Agent | @earendil-works/pi-coding-agent |
| 通信 | WebSocket (ws) |
| 数据 | hyparquet（parquet 读取） |
| 图标 / Markdown | Lucide React / react-markdown |

## 项目结构

```
server/                       # 后端（Vite 插件，端口 5174）
├── index.ts                  # Vite 插件入口，启动 http + WS 服务
├── agent.ts                  # pi AgentSession 管理（内存会话、技能过滤、govio-cli 校验）
├── ws-handler.ts             # /ws 与 /canvas 处理、事件转发、权限响应
├── parquet-api.ts            # /api/preview parquet 读取
├── permission-manager.ts     # 数据导出权限确认（allow/deny/edit/accept-all）
├── govio-node-queue.ts       # 节点创建事件缓冲与 flush
├── cli.ts                    # `npm run ask` 独立 CLI
└── extensions/
    └── govio-canvas.ts       # pi 扩展：govio 工具 + tool_call/tool_result/message_end 钩子

src/
├── components/
│   ├── Canvas/               # ReactFlow 画布、工具栏、节点查找栏、浮动预览
│   ├── Nodes/                # SourceTable/SQL/DataFrame/Report/Chart(+Modal) 节点
│   ├── Chat/                 # 聊天面板、输入、消息、权限卡片
│   └── Layout/               # Header + 画布/聊天两栏 + 拖拽分隔
├── commands/                 # 斜杠命令系统（内置 + 自定义 prompt 模板）
├── hooks/                    # useChat（/ws 客户端）、useChatContext
├── services/                 # canvas-service（/canvas 客户端）、mock-ai（ID 工具）
├── store/                    # canvas-store（Zustand）
├── data/                     # mock-tables、commands.json
├── types/                    # 节点 / 事件类型定义
└── utils/                    # layout（dagre 增量 + 全量排版）

.pi/                          # pi 配置：APPEND_SYSTEM.md + skills（govio / govio-query / govio-observe / govio-eda / govio-meta）
docs/pi/                      # pi-coding-agent SDK 与 JSON 协议文档
```

## 设计规范

亮色主题 “Green Deck”（Spotify 风格），完整规范见 `docs/green-deck-DESIGN.md`：

- 背景：`#f5f5f5`（页面/画布），`#ffffff`（卡片/消息），`#f0f0f0`（表面/输入框）
- 品牌色：`#1DB954`（绿色，用于标识、连线和高亮），hover `#1ED760`
- 边框层级：`#ececec` -> `#d4d4d4` -> `#b3b3b3`；不用 box-shadow
- 字体：DM Sans（正文）+ JetBrains Mono（代码），从 Google Fonts 加载
