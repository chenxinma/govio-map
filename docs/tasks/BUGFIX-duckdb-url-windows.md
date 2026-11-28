# BUGFIX：Windows 下 duckdb 数据源 URL 形态错误（三斜杠 → 双斜杠）

> 2026-11-28，X34 验收后 bugfix。分支 `fix/x34-duckdb-url-windows`。

## 问题现象

Windows 下数据源 URL `duckdb:///D:...`（三斜杠）不能正确访问，必须 `duckdb://D:...`（双斜杠）。
三斜杠形态会被解析成 POSIX 路径 `/D:/...`，报「目录不存在」类失败（`.pi/APPEND_SYSTEM.md`
「环境提示 → 路径」节的环境规则）。X34 新增代码的示例/文案用了三斜杠错误实例，把用户带进坑；
用户粘贴三斜杠形态时无自动纠正，直接失败。

## 根因

1. X34 文案/示例用了错误实例：`src/components/DatasourceForm.tsx` URL placeholder
   `duckdb:///D:/data/sales.duckdb`、`server/onboarding.ts` `datasourceHint` 的
   `duckdb:///path/to/file.duckdb`；
2. wrapper `test_connection` 按 `url[len("duckdb://"):]` 取路径：双斜杠形态取出 `D:/...`
   正确，三斜杠取出 `/D:/...`（POSIX 路径）连不上；入口无形态纠正，用户粘贴三斜杠即失败。

## 修复点

1. `server/onboarding.ts`：新增纯函数 `normalizeDatasourceUrl(url)`——仅当 URL 形如
   `duckdb:/+<盘符>:`（`duckdb:///D:/x.db`、`duckdb:////D:/x.db`、`duckdb:///D:\x.db` 等）时
   把盘符前多余斜杠收敛为 `duckdb://D:/...` 双斜杠（盘符后路径原样保留）；POSIX 绝对路径
   三斜杠（`duckdb:///home/x.db`）、UNC（`duckdb://server/share`）与其它 scheme 原样返回。
2. `addDatasource` / `testDatasource` / `importMetadata` 入口统一套用（存盘/探测/导入的 URL
   均为纠正后形态）。注：`importMetadata` 的 `--datasource` 常规传数据源名（URL 取自已存配置，
   经 addDatasource 入口保证纠正），名称原样通过，套用属入口统一防御。
3. 文案修正：`DatasourceForm.tsx` placeholder 改 `duckdb://D:/data/sales.duckdb` 并在帮助文案
   补「Windows 盘符路径用双斜杠 duckdb://D:/...（三斜杠会被解析成 POSIX 路径导致访问失败）」；
   `datasourceHint` 改 `duckdb://D:/path/to/file.duckdb`。
4. 测试样本形态统一为双斜杠：`scripts/verify-onboarding.ts` 4 处（157/164/170/191）、
   `tests/integration/ws-protocol.test.ts` 1 处、`scripts/verify-secrets-isolation.ts` 负样本
   1 处（语义不变，仍为零命中负样本）。
5. `scripts/verify-onboarding.ts` 新增 [B2] 节 8 条断言：normalizeDatasourceUrl 纯函数 5 条
   （盘符多斜杠→双斜杠 / POSIX 不动 / UNC 不动 / 其它 scheme 不动 / 双斜杠原样）+
   addDatasource / testDatasource / importMetadata 入口纠正各 1 条。

## 验证记录

- `npm run build` ✅、`npm run lint` ✅、`npm run verify` 全绿 ✅（2026-11-28）
- verify-onboarding 断言数 **55 → 63**（+8，B2 节）；verify-secrets-isolation 149 不变；
  vitest 35 文件 500 用例、UI 12 文件 103 用例全过（ws-protocol 样本改动零回归）
- 断言数变化将反映到 CI 断言看板（`docs/task-plan.json → verificationBaseline` 属主会话记账，
  本 bugfix 不改 task-plan；看板 NON-GATING，仅告警不拦门禁）
