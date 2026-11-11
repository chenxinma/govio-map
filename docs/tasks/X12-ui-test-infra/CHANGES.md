# X12 CHANGES：前端 UI 回归测试基建

## 文件清单

| 文件 | 变更 | 摘要 |
|---|---|---|
| `package.json` | 修改 | `verify` 链末尾追加 `verify:ui`；新增 `verify:ui = vitest run tests/ui`；新增 4 个 devDependencies：`@testing-library/dom@^10.4.2`、`@testing-library/react@^16.3.0`、`@testing-library/user-event@^14.6.1`、`jsdom@^27.2.0` |
| `package-lock.json` | 修改 | 同步上述 DOM 测试依赖及 53 个新增依赖记录；无 dependencies/runtime 依赖变更 |
| `vitest.config.ts` | 修改 | 保留 `environment: "node"`、`globals: false`、`isolate: true`；include 增加 `tests/ui/**/*.test.tsx`；既有 integration 文件继续默认 node |
| `tests/ui/settings-modal.test.tsx` | 新增 | 11 例 jsdom 交互回归：加载、连续输入/焦点/选区、provider 身份、空名/重名、禁用保存、模型/provider 增删、取消/Esc/遮罩、onSave 形状 |
| `tests/ui/source-table-node.test.tsx` | 新增 | 5 例 jsdom 回归：字段/PK/FK/数据源/限定名渲染、引用回调、可选字段回退、字段展开/折叠、删除回调；用 `ReactFlowProvider` 提供 Handle context |
| `docs/tasks/X12-ui-test-infra/design.md` | 新增 | A/B/C/D 选型、环境切换、类型检查取舍、jsdom 布局限制与遗留问题 |
| `docs/tasks/X12-ui-test-infra/CHANGES.md` | 新增 | 本文件 |
| `docs/tasks/X12-ui-test-infra/verification.md` | 新增 | 命令、断言/用例数、耗时、反向验证和最终工作树证据 |

## 依赖（仅 devDependencies）

```text
@testing-library/dom@^10.4.2
@testing-library/react@^16.3.0
@testing-library/user-event@^14.6.1
jsdom@^27.2.0
```

实际安装解析版本：`@testing-library/dom 10.4.2`、`@testing-library/react 16.3.0`、
`@testing-library/user-event 14.6.1`、`jsdom 27.2.0`。

## 业务源码

**零业务源码改动**。`src/` 未新增 test hook、data attribute、导出或行为分支；UI
测试直接使用现有 placeholder、button text/title、DOM 结构和 store mock。

## 测试执行说明

- `tests/integration/**/*.test.ts` 的 7 个既有文件不修改断言，默认仍为 node 环境。
- `tests/ui/**/*.test.tsx` 每个文件首行声明 jsdom；不改变全局环境。
- `npm run verify:ui` 可独立运行新增 UI 组。
- `npm run verify:integration` 保持原有 `vitest run`，因此全量 Vitest 为
  9 文件/99 例；随后 `verify:ui` 定向重复 UI 16 例，保证新增入口显式可见。
