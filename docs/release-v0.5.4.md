## Govio Map v0.5.4 - 版本号与 govio 同步 + Subagent 委托能力

> 从本版本开始，Govio Map 的版本号与 **govio（govio-cli）保持同步**：govio 0.5.4 ↔ Govio Map 0.5.4。
> 此前 Govio Map 独立编号（0.2.x），自本版本起跳转至 0.5.4 对齐 govio，后续版本将随 govio 一起演进。

### 🤖 Subagent 委托能力（pi-subagents 集成）

- 以 npm 依赖方式集成 **pi-subagents 0.54.0**（版本随 package.json 管理），主 Agent 获得多 Agent 委托与编排能力
- 新增 `subagent` / `subagent_wait` 工具：支持单 Agent 委托、并行 fan-out、后台异步运行、断点恢复（resume）
- 6 个内置子 Agent，各有分工：
  - **worker** - 实现型 Agent，执行正常任务与已批准的 oracle 交接
  - **reviewer** - 审查专家：代码 diff、方案评审、代码库健康度、PR/issue 验证
  - **researcher** - 自主 Web 研究员：搜索、评估并综合出聚焦的研究简报
  - **scout** - 快速代码侦察，返回压缩上下文用于交接
  - **oracle** - 高上下文决策一致性 oracle，防止继承状态漂移
  - **delegate** - 轻量委托，继承父模型
- 6 个工作流 Prompt 模板：council（多角色评审）、parallel-research、parallel-review、review-loop、gather-context-and-clarify、parallel-cleanup
- Electron 桌面环境完整支持：子 Agent 以 Node 模式（`ELECTRON_RUN_AS_NODE`）运行，使用与宿主一致的内嵌 pi 运行时

### 📊 Plotly 图表引擎（替换 Chart.js）

- 画布图表节点全面迁移到 **Plotly**：内置缩放、悬停详情、图例交互
- `govio_show_chart` 契约更新为 Plotly figure（`config.data` traces + `config.layout`）
- 新增 **treemap（矩形树图）** 图表类型，支持 classify-stats 分析流程
- **treeDf 引用**：treemap 数据可直接引用 ObserveStore 中的 DataFrame 名，服务端自行取数构建树（2000 行上限，NULL 归一为「未指定」），Agent 无需导出数据内容、不再受工具参数大小限制
- 图表弹窗放大至 1200px / 75vh，查看更舒适

### 💬 聊天面板模型选择器

- 输入框上方新增模型下拉选择，切换即时生效（`set_model`）
- 选择持久化到 localStorage，重启后保持
- 已记住的模型从配置中移除时，自动回退到第一个可用模型

### 🗂️ 数据源浏览器增强

- 数据源弹窗可浏览 govio 数据源与已加载的 DataFrame（名称、行数、列数、字段 schema）
- DataFrame 一键**添加到画布**：自动估算内存占用、画布节点去重、直接创建 dataFrame 节点并可预览

### ✨ Other Changes

- WebSocket 工具执行结果增加调试日志，便于排查 Agent 工具调用
- 自动安装 govio-cli（uv tool）与技能包下载逻辑保持不变，首次配置 LLM 后自动完成

---

**安装说明**

下载 `Govio Map Setup 0.5.4.exe`，双击运行安装程序。安装完成后从桌面或开始菜单启动 Govio Map。

- 首次启动需要配置 AI Provider API Key（支持 Anthropic、OpenAI、Gemini、Mistral 等），在应用内设置中填写即可
- 配置完成后应用会自动安装 govio-cli（需系统已安装 [uv](https://docs.astral.sh/uv/)）并下载 govio 技能包

**从 0.2.x 升级**

直接安装新版覆盖即可；本版本版本号跳变（0.2.3 → 0.5.4）是与 govio 版本对齐所致，无破坏性变更。
