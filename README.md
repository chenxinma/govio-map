# Govio Map

无限画布数据治理工具。通过自然语言指令生成数据查询逻辑，以可视化卡片形式在画布上编排数据血缘关系。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目根目录创建 `.env` 文件，设置 AI 提供商的 API Key：

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-xxxxx

# OpenAI (GPT)
# OPENAI_API_KEY=sk-xxxxx

# Google (Gemini)
# GEMINI_API_KEY=xxxxx

# Mistral
# MISTRAL_API_KEY=xxxxx
```

至少需要配置一个 API Key。pi-coding-agent 会自动从环境变量读取，也可通过 `~/.pi/agent/auth.json` 持久化存储。

### 3. 启动开发服务器

```bash
npm run dev
```

- Vite 前端：`http://localhost:5173/`
- WebSocket 服务：`ws://localhost:5174/ws`

Chat 面板会自动连接 WebSocket。如果后端未启动或连接失败，自动降级到 Mock 模式。

## 交互操作

### 发送自然语言指令

在底部 Chat 面板输入指令，支持两种模式：

- **pi-coding-agent 模式**（需配置 API Key）：通用问答，流式输出
- **Mock 模式**（无 API Key 时自动降级）：固定规则匹配，生成 SQL/DataFrame/Report 节点

通用对话示例：

- `这个项目的表结构有哪些特点？` — 通过 pi agent 分析代码
- `帮我写一个按客户分组统计的 SQL` — AI 生成 SQL

节点操作示例（Mock 模式）：

- `统计客户账单金额，按月、客户、部门、销售组` — 生成 SQL + 表节点
- `按区域统计客户账单` — 区域维度分析
- `统计每月账单与收款情况` — 账款对比

### 引用节点到对话

点击卡片底部的 **引用** 按钮，节点以标签形式出现在 Chat 输入框中。

- 引用 **SQL 节点** 后发送指令 → 生成 DataFrame
- 引用 **2 个 DataFrame** 后发送指令 → 生成 Report（差异比较 / 相关性分析）

### 拖拽表到画布

从左侧 Sidebar 将表拖拽到画布空白区域，自动创建 SourceTable 节点。

### 预览 DataFrame

点击 DataFrame 卡片的 **预览** 按钮，弹出悬浮面板展示数据表格（支持翻页）。

### 连线

从节点右侧输出端口拖拽到另一节点左侧输入端口，建立连线关系。

## 节点类型

| 类型 | 颜色标识 | 内容 |
|------|---------|------|
| SourceTable | 紫色左边框 | 表名、数据库、字段列表 |
| SQL | 绿色左边框 | SQL 语句、输出列 |
| DataFrame | 橙色左边框 | 数据源、df.info() 信息、预览按钮 |
| Report | 琥珀/紫色左边框 | 差异比较或相关性分析文本报告 |

## 布局

数据血缘从左至右延展：

```
Tables ──▶ SQL ──▶ DataFrame ──▶ Report
```

Dagre 自动排版，支持手动拖拽调整位置。

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | React 18 + TypeScript |
| 构建 | Vite |
| 画布 | @xyflow/react (ReactFlow) |
| 状态 | Zustand |
| 布局 | @dagrejs/dagre |
| 样式 | Tailwind CSS |
| 图标 | Lucide React |
| AI Agent | @mariozechner/pi-coding-agent |
| 通信 | WebSocket (ws) |

## 项目结构

```
server/                    # 后端 (Vite 插件模式)
├── agent.ts               # pi-coding-agent session 管理
├── ws-handler.ts          # WebSocket 消息处理
└── index.ts               # Vite 插件入口

src/
├── components/
│   ├── Canvas/            # ReactFlow 画布 + 浮动预览面板
│   ├── Nodes/             # 自定义节点 (SourceTable, SQL, DataFrame, Report)
│   ├── Chat/              # 聊天面板 + 引用标签 + 流式输出
│   ├── Sidebar/           # 左侧表列表
│   └── Layout/            # Header + 三栏布局
├── store/                 # Zustand 状态管理
├── services/
│   ├── ai-service.ts      # AI 服务层 (WebSocket / Mock 切换)
│   └── mock-ai.ts         # Mock 响应生成 (fallback)
├── data/                  # Mock 元数据（8 张业务表）
├── types/                 # TypeScript 类型定义
└── utils/                 # Dagre 自动排版
```

## 设计规范

暗色主题，基于 Supabase 设计系统：

- 背景：`#171717`，最深 `#0f0f0f`
- 品牌色：`#3ecf8e`（绿色，仅用于标识和连线）
- 层级区分通过边框颜色（`#242424` → `#2e2e2e` → `#363636`），不用 box-shadow
- 字重仅用 400（正文）和 500（交互元素）
