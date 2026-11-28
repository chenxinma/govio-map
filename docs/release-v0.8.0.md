# Govio Map v0.8.0 — 5 分钟从 npx 到第一个数据问题，凭据零进大模型

> 覆盖 v0.7.3 之后的全部演进（**X34 首次运行向导 + 数据源管理器 + 秘密结构性路由**，
> 含验收后 bugfix「Windows duckdb URL 双斜杠」）。govio-cli 侧配套为 govio 0.8.0
> （X33：`govio-cli onboard` 非交互图后端配置）。
>
> **北极星**：全新环境 `npx govio-map` → 首次数据问题被回答 ≤ 5 分钟（本地示例库）/
> ≤ 10 分钟（真实库），全程 **0 次**在聊天框粘贴凭据。

## 🧭 首次运行向导：初始配置全 GUI 化

- **单一 4 步 stepper**（环境自检 → LLM → 图谱 → 数据源）+ 完成态 next-best-action，
  每步可跳过/延后、幂等可续做（如实反映当前状态，重复进入不覆盖不破坏）
- **环境自检**：自动安装/升级 `govio-cli`（≥ 0.8.0）并下载 skills，带进度显示
- **配置 LLM**：OpenAI / Anthropic / DeepSeek / Gemini / 自定义（baseUrl + API 协议）
  预置模板任选，可即时「测试模型」；**去 DeepSeek 硬编码**，无默认供应商锁定
- **初始化图谱**：默认 **ladybug 一键**（本地嵌入式 `~/.govio/ontology.lbdb`，零外部
  依赖）；falkordb / networkx 为高级可选（只收参数）
- **数据源管理器**：增删改 + 测试连接（失败按 dns/host/port/auth/timeout 分类给可读
  修复指引）+ 一键导元数据（DuckDB）；删除了「导入元数据」预填回灌聊天的旧路径

## 🔐 秘密结构性路由：凭据只走表单，从软约束变硬拦截

- 后端硬拦截 prompt / steer / followUp 三通道中出现的连接串与明文密码：**拒绝执行**，
  回 `secret_redirect` 可读引导卡片（前端收尾：被拦原文即时替换为脱敏摘要，不留存）
- 凭据生命周期只在「GUI 表单 ↔ 后端子进程 stdin ↔ 加密落盘」：**零进入** LLM 上下文、
  日志、进程参数、环境变量；拦截审计 sidecar 只记 SHA-256，零明文
- 系统提示新增「凭据只走表单」硬约束（`.pi/APPEND_SYSTEM.md`）
- 机器保证：新增 CI 断言 `verify:secrets-isolation`（149 断言，正/负样本矩阵 + 凭据
  通道不变量）与 `verify:onboarding`（63 断言，幂等/可恢复/错误分类）

## 🐛 修复：Windows 下 duckdb 数据源 URL 形态

- 三斜杠 `duckdb:///D:...` 会被当成 POSIX 路径导致访问失败——示例/文案统一为双斜杠
  `duckdb://D:/...`，并新增 `normalizeDatasourceUrl()` 自动纠正盘符形态（POSIX/UNC 不动），
  存盘 URL 保证为可访问形态

## 📦 安装与使用

```bash
npx govio-map
```

前置：Node.js（LTS）+ [uv](https://docs.astral.sh/uv/)（`govio-cli` 安装工具）+ 任一 AI
供应商 API Key（向导中录入）。浏览器打开 `http://localhost:5173/`，首启向导自动弹出。
凭据仅加密存本机（`~/.govio/config.yaml`、`~/.pi/agent/models.json`），不发往大模型。

## ⚖️ 已知取舍

- **可用性证据待补**：TTFV 前后对比 + 5 人冷启动 think-aloud + SUS（验收口径最后一项）
  由用户安排实测后回填；本轮先发布供测试
- **遥测埋点未做**（design 遗留 3，本轮裁决延后）；漏斗观测待埋点落地
- **「测试模型」为保存并测试**（草稿即时探测延后，design 遗留 9）；连接错误分类为
  关键词启发式，阈值样本已固化在 verify 脚本
- 一键导元数据仅支持 DuckDB 数据源；其它类型仍由 agent 经 `govio-cli meta meta` 导入
