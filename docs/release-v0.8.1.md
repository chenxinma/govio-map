# Govio Map v0.8.1 — govio-cli 0.8.1 兼容性提升（patch）

> v0.8.0 的补丁发版：把首启向导自动安装的 govio-cli 最低版本提升到 **0.8.1**
> （含 X34 可用性 Round 1 发现的两缺陷修复），并同步发版记账。
> govio 侧变更见 govio Release v0.8.1（PR #26）。

## 变更

- **`MIN_GOVIO_CLI_VERSION` 0.8.0 → 0.8.1**（`server/govio-installer.ts`）：
  向导 Step0 环境自检对已装 0.8.0 的用户自动升级到 govio-cli 0.8.1
- **依赖的 govio-cli 0.8.1 修复**（详见 govio Release v0.8.1）：
  - `meta rel` 边 CSV 表头规范化：0 有效关系导出不再产生杂散 `source,target` 表头，
    历史脏产物自动治愈；`meta graph` 导入容错（端点列重排兜底、可读报错）
  - `meta graph --mode update` 旧库（缺 `node_id` 属性列）不再裸报
    `Cannot find property node_id for n`，改为跳过缺失列 + `--mode rebuild` 迁移指引

## 安装

```bash
npx govio-map@0.8.1
```

前置：Node.js（LTS）+ [uv](https://docs.astral.sh/uv/) + 任一 AI 供应商 API Key。
已装 0.8.0 的用户：`npx govio-map@0.8.1` 启动后向导 Step0 自动升级 govio-cli。

## 已知取舍

- 同 v0.8.0（可用性测试持续收集中；遥测埋点延后；「测试模型」为保存并测试）
- 旧 lbdb 库的 `--mode update` 为「跳过 + rebuild 指引」而非自动迁移（Ladybug DDL 限制）
