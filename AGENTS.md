# AGENTS.md

## govio-cli 测试

系统未全局安装 `govio-cli`。如需执行 govio-cli 进行测试，使用以下命令格式：

```bash
uvx --from ./.pi/skills/govio/assets/govio-0.2.2-py3-none-any.whl govio-cli <subcommand> [args]
```

示例：

```bash
uvx --from ./.pi/skills/govio/assets/govio-0.2.2-py3-none-any.whl govio-cli observe load df_bill_cnt IHRO_BILL
```

## 节点创建机制

`server/extensions/govio-canvas.ts` 负责在以下场景自动创建画布节点：

| 触发条件 | 节点类型 | 数据来源 |
|---|---|---|
| assistant 回复包含 ` ```sql ` 代码块 | `dataFrame` | SQL 解析 sourceName/dfName/columns |
| `govio-cli observe load` 执行成功 | `dataFrame` | 命令 stdout JSON |
| `govio-cli observe compare` 执行成功 | `report` (diff) | 命令 stdout JSON |
| `govio-cli observe explore` 执行成功 | `report` (correlation) | 命令 stdout JSON |
