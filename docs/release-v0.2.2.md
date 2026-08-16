## Govio Map v0.2.2 — Desktop App + Chart Visualization

Govio Map 首次发布为桌面应用（Electron），并新增了基于 Chart.js 的画布图表可视化能力。

### 🖥️ Desktop App

- 打包为 Windows 桌面应用，提供 `Govio Map Setup 0.2.2.exe` 安装程序
- 内置后端服务，启动即用，无需手动运行开发服务器

### 📊 Chart.js Visualization

- 新增 `chart` 节点类型，直接在画布上渲染 Chart.js 图表
- `govio_show_chart` 工具支持传入完整的 Chart.js 配置（支持 line、bar、pie、doughnut 等类型）
- 图表点击全屏放大查看（ChartModal），支持缩放交互
- 图表错误边界（ChartErrorBoundary），渲染失败时优雅降级显示错误信息
- 画布缩放与平移功能

### 🧩 DataFrame Nodes

- `govio observe --memory` 加载操作会在画布上自动创建 DataFrame 节点
- `govio_show_dataframe` 工具支持显示 DataFrame 数据预览
- 支持 Parquet 文件预览（hyparquet）

### 🎨 Green Deck Light Theme

- 应用 Spotify 风格的 "Green Deck" 浅色主题
- 统一的背景色、边框色、文字色体系
- DM Sans + JetBrains Mono 字体搭配

### ✨ Other Features

- **节点查找栏（Find Bar）**：在画布上快速搜索和定位节点
- **边删除**：支持选中并删除画布上的边（数据血缘关系）
- **选中边高亮**：选中的边显示绿色高亮样式
- **会话重置**：`/clear` 命令可重置 Agent 会话，清理前端消息
- **权限提示**：`govio observe load -o` 操作触发权限确认
- **JSON 输出支持**：CLI 支持 JSON 格式的流式输出
- 扩展工具白名单：`npm install`、代理命令、`rtk cat`、`rtk zip` 等

### 🐛 Bug Fixes

- 修复 ChartModal 中 setState-in-effect 警告
- 修复 ChartModal Canvas 挂载策略，允许错误恢复
- 修复选中边样式未覆盖内联样式的问题
- 修复 WebSocket 断开时前端消息未清理的问题
- 修复 govio-canvas 执行处理器中的未使用参数

---

**安装说明**

下载 `Govio Map Setup 0.2.2.exe`，双击运行安装程序。安装完成后从桌面或开始菜单启动 Govio Map。

首次启动需要配置 AI Provider API Key（支持 Anthropic、OpenAI、Gemini、Mistral），在应用内设置中填写即可。
