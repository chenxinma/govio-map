# X6 用户手册（简版）— 设计说明

> 任务：docs/task-plan.json crossCutting X6 · 分支 feature/phase2-semantic-layer
> 交付物：`docs/USER-MANUAL.md`（368 行，12 节）+ 本三件套

## 1. 受众与写作纪律

**受众**：企业内数据分析用户（分析师 / 业务分析岗），非开发者。由此推出三条硬纪律：

1. **只写已交付功能**：每个按钮、入口、命令、提示文案都先在代码/规格中核实（对照表见
   `verification.md`）。ROADMAP Phase 2/3 的功能（图谱口径注入、口径溯源/冲突检测、团队存储、
   分享/fork、SSO 多用户、Docker 部署等）一律不出现。
2. **不出现源码路径 / 类型名 / 内部模块名**：正文零 `src/`、`server/`、`*.ts(x)`、store/hook 名。
   允许的内部术语以括注方式出现且仅两处：「分析留痕（内部称 Manifest）」、FAQ 里的错误原文
   「该节点没有分析留痕（Manifest），无法复跑」（这是用户会实际看到的文案，必须原样可检索）。
3. **用户语言优先**：写「点引用按钮」而不是「调用 addReference」；写现象与后果
   （「漂移时原结果不会被覆盖」）而不是实现机制（sidecar / JSONL / WS 协议）。

## 2. 结构取舍

采用任务书建议的 11 节框架，做了一处微调：拆出独立的「4. 界面总览」——非开发者用户最先要的
是「屏幕上每个按钮是什么」的全景图，把它从节点章节里独立出来，顶栏/对话面板头部/分隔条各给
一张小表；原第 4 节变为「5. 画布与五类节点」。最终 12 节（含附录术语表）：

| 节 | 覆盖 | 主要事实来源 |
|----|------|--------------|
| 1 是什么 | 定位 + ASCII 血缘流程图 | README / specs/00 |
| 2 安装与启动 | 前置依赖、npm run dev、5173/5174、Electron 一句带过 | README / package.json / govio-installer |
| 3 首次配置 | ConfigModal、LLM 设置、模型下拉 | ConfigModal / SettingsModal / ChatPanel |
| 4 界面总览 | 顶栏、对话面板头部、分隔条 | Header / ChatPanel / AppLayout |
| 5 画布与五类节点 | 五类节点表 + 每类可点操作 + 画布操作表 + 工具栏 | specs/01、02 + 各 Node 组件 |
| 6 对话取数基本流 | 完整取数 5 步、插队/停止、引用姿势、斜杠命令、数据源面板 | specs/03、08 + ChatInput / DataSourcesModal |
| 7 验证与交付 | 复跑四态、漂移读法、留痕字段表、交付报告章节表 | specs/02 + T1.1/T1.2/T1.4 design |
| 8 权限确认卡 | 触发条件、四按钮后果、5 分钟超时、审计 | specs/10 + PermissionCard + T1.3 design |
| 9 会话管理 | 自动保存、历史会话、删除、分页、清空命令 | ChatPanel / useChat / canvas-store / T1.3 |
| 10 SQL 编辑器 | 入口、补全、memory/外部数据源、执行上画布 | SQLModal / parquet-api |
| 11 FAQ | 12 条「现象 → 原因与处理」 | 见 verification.md §11 |
| 12 术语表 | 数据源/DataFrame/血缘/全限定名/留痕/复跑/漂移/校验和/确认门/交付报告 | 全文来源汇总 |

**取舍记录**：

- **斜杠命令按实际代码写**，不按 README/specs-08（两者有出入）：内置 3 条以 `built-in.ts` 的
  description 为准（`/clear` 实为「清理当前会话上下文」）；自定义 4 条以 `commands.json` 为准
  （含 `/release-df`、`/导入元数据`）；`/skill:name` 来自 ChatInput 对 `/api/skills` 的加载。
- **不写侧边栏拖表上画布**：Canvas 仍留有 onDrop 处理，但当前 UI 没有任何拖拽源组件，
  README 的「从 Sidebar 拖入表」是历史描述——按「只写已交付」纪律不收录。
- **不写「自动排版」**：store 里的全量布局能力当前没有 UI 入口，不收录。
- **元数据导入只写按钮行为**（预填命令、补全后发送），不展开知识图谱概念——图谱约束口径
  属 Phase 2，导入命令本身已交付（commands.json + DataSourcesModal 预填）。
- **govio-cli 缺失的表现按当前实现写**：README 说「缺失则启动失败」，但现在
  `ensureGovioCli()` 会先经 uv 自动安装/升级（最低 0.6.0），FAQ 按「自动安装失败 → 对话面板
  保持未连接 → 看启动日志」的实际链路描述。
- **`/clear-canvas` 描述为「清空画布节点与消息」**：这是 handler 的实际行为；built-in 描述文案
  里的「释放所有 dataframe」并未由该命令本身执行（释放走 `/release-df` 让 AI 执行），手册不
  照抄引起误解的文案。

## 3. 篇幅与形态

368 行（任务书建议 200–400）。表格 18 张、有序步骤列表 2 组（首次配置、完整取数流），散文段落仅第 1 节与各节引言，
符合「多用表格与步骤列表」的要求。

## 4. 遗留问题

1. **README 与手册在 govio-cli 安装口径上不一致**（README 说缺失即启动失败，代码已改为
   uv 自动安装兜底）。手册按代码写；建议后续小任务同步 README「前置依赖」一节。
2. **`/clear-canvas` 的命令描述文案（"清理画布并释放所有dataframe"）与实际行为不符**
   （不清后端 DataFrame）。手册按实际行为写；文案是否修正属产品决策，未在本文档任务内改代码。
3. **FAQ 中「API Key 无效」的表现依赖模型提供商的报错透传**，不同 Provider 报错形态不同，
   手册只给了排查入口（LLM 设置核对 Key/BaseURL/余额），未逐一枚举错误文案。
4. **手册未截图**：纯文字 + ASCII 布局图。若需要配图版本，属后续任务（需要运行环境截图）。
5. **版本演进维护**：手册标注「适用版本 v0.6.1」，后续功能变更时需同步更新（建议纳入各任务
   的 DoD 检查项，属流程决策）。
