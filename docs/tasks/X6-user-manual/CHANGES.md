# X6 用户手册（简版）— 变更记录

## 变更文件

| 文件 | 类型 | 说明 |
|------|------|------|
| `docs/USER-MANUAL.md` | 新增 | 面向企业内数据分析用户的简版手册，368 行 / 12 节 / 18 张表格；只写已交付功能，用户语言，无源码路径与内部模块名 |
| `docs/tasks/X6-user-manual/design.md` | 新增 | 受众与写作纪律、结构取舍（含 5 条取舍记录）、篇幅形态、5 条遗留问题 |
| `docs/tasks/X6-user-manual/verification.md` | 新增 | 手册条目 → 代码/规格出处对照表（覆盖 §2–§12 全部按钮级操作）+ 未交付功能自查 + 非开发者自查 + 构建回归 |
| `docs/tasks/X6-user-manual/CHANGES.md` | 新增 | 本文件 |
| `docs/task-plan.json` | 修改 | crossCutting X6：status `pending → in_progress → done`，追加 history 两条，刷新顶层 `updatedAt` |

> 未改动任何源码 / 配置 / 规格文件（纯文档任务）。

## 手册章节

1. Govio Map 是什么（含 ASCII 血缘流程图）
2. 安装与启动（前置依赖 / npm run dev / Electron 一句带过）
3. 首次配置（ConfigModal 输 API Key / LLM 设置 / 模型下拉）
4. 界面总览（顶栏 / 对话面板头部 / 分隔条）
5. 画布与五类节点（一览表 + 每类可点操作 + 画布操作 + 工具栏）
6. 对话取数基本流（完整取数 / 插队停止 / 引用姿势 / 斜杠命令 / 数据源面板）
7. 验证与交付（复跑四态 / 漂移读法 / 留痕字段 / 交付报告章节）
8. 权限确认卡（触发 / 四按钮后果 / 5 分钟超时 / 审计）
9. 会话管理（自动保存 / 历史会话 / 删除 / 分页 / 清空）
10. SQL 编辑器（入口 / 补全 / 两种数据源 / 执行上画布）
11. 常见问题（12 条 FAQ）
12. 附录：术语小表（10 个术语）

## 验证命令与结果

```bash
# 构建与 lint（纯文档任务，确认不受影响）
npm run build   # ✓ built in 7.15s（仅既有 chunk 体积告警，与本任务无关）
npm run lint    # eslint . → 0 error（LINT_EXIT=0）

# 未交付功能自查：ROADMAP Phase 2/3 关键词零命中
grep -cE "口径命中|语义血缘|口径溯源|冲突检测|团队存储|只读分享|fork|SSO|多用户|Docker|定时调度|告警|协同编辑|自动更新|安装包签名|Prompt 约束|图谱注入" docs/USER-MANUAL.md
# → 0（exit 1，无匹配）

# 非开发者自查：无源码路径 / 类型名 / 内部模块名 / 协议词
grep -nE "src/|server/|\.tsx|\.ts[^a-z]|useChat|canvas-store|ws-handler|WebSocket|sidecar|JSONL|zustand|ReactFlow|/api" docs/USER-MANUAL.md
# → 无输出（exit 1，无匹配）

# 规模
wc -l docs/USER-MANUAL.md          # 368
grep -c "^## " docs/USER-MANUAL.md # 12（h2 章节）
grep -c "^|" docs/USER-MANUAL.md   # 132（表格行）
```

## 事实核对来源（写作前逐一通读）

README.md · package.json · docs/specs/{00,01,02,03,08,10,11} · docs/ROADMAP.md ·
docs/tasks/{T1.1,T1.2,T1.3,T1.4,T2.0}/design.md ·
src/components/{Layout/Header,Canvas/CanvasToolbar,Canvas/Canvas,Canvas/NodeFindBar,Canvas/FloatingPreviewPanel,Chat/ChatPanel,Chat/ChatInput,Chat/PermissionCard,Nodes/DataFrameNode,Nodes/SQLQueryNode,Nodes/SQLModal,Nodes/SourceTableNode,Nodes/ReportNode,Nodes/ChartNode,Nodes/ManifestDetails,Nodes/RerunStatus,SettingsModal,DataSourcesModal,ConfigModal}.tsx ·
src/hooks/useChat.ts · src/store/canvas-store.ts · src/commands/built-in.ts · src/data/commands.json ·
src/utils/{rerun,manifest-labels}.ts · src/types/{index,manifest}.ts ·
server/{backend,ws-handler,agent,govio-installer,dataframe-rerun,models-config,parquet-api}.ts · server/extensions/govio-canvas.ts
