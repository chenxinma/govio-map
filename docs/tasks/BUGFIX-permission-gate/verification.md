# verification：取数/读数据确认门缺口修复

## 验证命令与结果

全部通过（2026-11-01）：

| 命令 | 结果 |
|---|---|
| `npm run build` | ✅ tsc + vite build 通过 |
| `npm run lint` | ✅ 0 error |
| `npm run verify:manifest` | ✅ 92 项断言（无回归） |
| `npm run verify:rerun` | ✅ 71 项断言（无回归） |
| `npm run verify:audit` | ✅ **119 项断言**（修复前 97，新增 22） |
| `npm run verify:export` | ✅ 126 项断言（无回归） |
| `npm run verify:source-table` | ✅ 39 项断言（无回归） |
| `npm run verify`（聚合） | ✅ 全绿 |

## 新增断言（verify:audit）

### 第 8 节：触发条件（+13）
```
✓ info --rows 5（拉样本行）触发确认门
✓ info --rows 10 触发确认门
✓ info 省略 --rows（CLI 默认 10 行样本）触发确认门
✓ info --rows 0（仅结构）不触发
✓ info --rows=0（等号形式）不触发
✓ info --df（DataFrame 列表，仅元数据）不触发
✓ info --datasource（数据源名列表，仅元数据）不触发
✓ info 无 --name/--df/--datasource（help 等）不触发
✓ info --rows abc（非法数值，保守当作读数据）触发确认门
✓ load -o 与 info 样本行都命中时 kinds 可区分
✓ 普通加载不读数据内容
✓ observeInfoTarget 提取 df 名
✓ observeInfoTarget 对非 info 命令返回 null
```

### 第 9 节：条件放行 + 确认队列（+9）
```
✓ 同 df 首次样本读取触发确认门
✓ 命令执行后登记条件放行
✓ 同 df 后续样本读取免确认（方案 B）
✓ 不同 df 的样本读取仍触发确认门
✓ 被拒绝的样本读取被阻断
✓ 被拒绝的命令不产生条件放行豁免
✓ acceptRead 登记后可查
✓ clearAll 清空条件放行登记（跨会话不继承豁免）
✓ -o 导出命令不受 info 条件放行豁免
```

## 原始 bug 复现对照

会话 `2026-10-31T16-22-57`（「销量top3的产品」）中 agent 的命令序列，用 `shouldAskPermission` 直接断言：

| 命令 | 修复前 | 修复后 |
|---|---|---|
| `observe load --name df_top3_products ... LIMIT 3`（无 `-o`） | `false`（不触发） | `false`（仍不触发，按设计） |
| `observe info --name df_top3_products --rows 5` | **`false`（绕过）** | **`true`（触发确认）** |
| `observe info --name df_top3_products --rows 0` | `false` | `false`（仅结构，正确） |

修复后该序列会在第 2 步（`info --rows 5`）弹出确认卡；若用户允许，则本会话内同 df 的后续样本读取免确认（方案 B）。

## 人工冒烟（dev 环境，待补）

1. `npm run dev` 启动，发起「销量top3的产品」查询
2. 预期：agent 执行 `observe info --name <df> --rows N` 拉样本前弹出 PermissionCard「需要权限确认」；`observe info --df` / `--datasource`（列元数据）**不弹卡**
3. 点「允许」→ 后续同 df 样本读取不再弹卡；点「拒绝」→ 命令被 block，agent 拿到拒绝原因
4. 并发两个带 `-o` 的加载 → 两张确认卡**依次**出现（队列），不丢失
5. 确认卡挂起时切换会话 → 卡片消失，`.audit.jsonl` 有 `permission_decision`（`source: "reset"`）

## 回归：info 元数据子命令不误伤（2026-11-01 补）

用户反馈 `govio-cli observe info --df 2>&1` 不应被拦截——`--df`（已加载 DataFrame 列表）/ `--datasource`（数据源名列表）只回元数据摘要、不含数据行。CLI `--help` 佐证：仅 `--name NAME` 显示「结构和样本数据」。

修复：`readsDataContent` 的 `info-sample` 判定收窄为 **`--name <df>` 存在**且 `--rows>0`；无 `--name` 的 `observe info`（含 `--df`/`--datasource`/help）不触发。

| 命令 | `readsDataContent` |
|---|---|
| `govio-cli observe info --df 2>&1` | `null`（不触发）✅ |
| `govio-cli observe info --datasource 2>&1` | `null`（不触发）✅ |
| `govio-cli observe info --name df_x --rows 5` | `"info-sample"`（触发）✅ |
| `govio-cli observe info --name df_x` | `"info-sample"`（触发，默认 10 行）✅ |
| `govio-cli observe info --name df_x --rows 0` | `null`（仅结构）✅ |
