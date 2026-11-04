# X3 变更清单（plotly 懒加载 / bundle 拆分）

## 新增文件

| 文件 | 说明 |
|---|---|
| `src/components/Nodes/use-plotly.ts` | plotly 懒加载入口：`loadPlotly()` 动态 `import('plotly.js-dist-min')` + 模块级缓存；导出 `PlotlyModule` 类型 |
| `docs/tasks/X3-bundle-splitting/design.md` | 方案与取舍（含遗留问题） |
| `docs/tasks/X3-bundle-splitting/CHANGES.md` | 本清单 |
| `docs/tasks/X3-bundle-splitting/verification.md` | 基线/拆分后体积对比、chunk 断言、冒烟、验证门槛 |

## 修改文件

| 文件 | 改动摘要 |
|---|---|
| `src/components/Nodes/ChartNode.tsx` | 移除静态 `import Plotly`；effect 内 `loadPlotly()` 动态加载后 `P.react(...)` 渲染、卸载时 `plotly.purge(el)` 清理；用 `cancelled` 标记避免异步竞态；加载/渲染失败沿用原 `hasError` 降级 |
| `src/components/Nodes/ChartModal.tsx` | 同 ChartNode：静态 import → `loadPlotly()` 动态加载，渲染与清理逻辑逐字保留，失败沿用 `hasError` |

## 未改动（有意）

| 文件 | 原因 |
|---|---|
| `src/utils/export-report.ts` | 第三个 import 点本就是 `await import()` 动态加载、不在主 chunk；不为统一 helper 引入 utils→components 反向耦合（见 design.md §2.3） |
| `src/types/plotly.d.ts` | 仅类型声明、不打包，无需改 |
| `vite.config.ts` | 动态 import 已足够触发拆分，无需 manualChunks |
| `server/`、`docs/task-plan.json` | 范围纪律：计划记账由主会话统一执行 |

## 关键数字（详见 verification.md）

- 主 chunk：6,071,629 → 1,424,488 bytes（↓ 76.5%）
- 新增懒加载 chunk：`plotly.min-*.js` 4,646,126 bytes（按需加载）
- 产物总计基本不变（仅拆分、不增删功能）
