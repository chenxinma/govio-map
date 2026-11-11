# X12 设计：前端 UI 回归测试基建

## 1. 目标与边界

为 `SettingsModal` 与 `SourceTableNode` 建立可常态运行的 DOM 组件测试，并接入
`npm run verify`。目标是覆盖受控输入、焦点/节点身份、条件渲染、校验状态、关闭路径、
保存载荷与画布节点回调；不改变业务交互、样式或文案。

本任务同时回答 X11 暴露的两个问题：

1. `key={name}` 这类「可编辑值当 React key」能否被组件测试拦住：**能**。
2. `flex-1 h-9` 这类「父级方向变化导致高度压扁」能否被 jsdom 拦住：**不能**。

## 2. 方案对比

| 方案 | 依赖体积与安装成本 | `npm run verify` 耗时增量 | 可测范围（含布局/高度） |
|---|---|---|---|
| **A. jsdom + Testing Library + user-event**（选定） | 4 个直接 dev 包（jsdom 27.2.0、RTL 16.3.0、RTL DOM 10.4.2、user-event 14.6.1）；实测新增 53 个包记录，直接包目录约 6.24 MiB；无浏览器二进制、离线可重复 | 本机实测约 +5.93s（DOM 相关全量 Vitest / targeted UI 约 2.8–2.9s） | 能测真实 DOM 事件、焦点、`selectionStart`、节点引用、React key 重挂载、条件渲染、回调与保存对象；**不能测 CSS 布局、`getBoundingClientRect` 高度、flex 简写或视觉像素** |
| B. Playwright E2E/组件 | 需 Playwright 包 + Chromium/WebKit 等浏览器二进制；安装和缓存体积显著大于 A，CI 首次安装可能依赖网络 | 需启动应用/server，通常显著高于 A；若纳入每条回归链会放大波动 | 能测真实布局、computed style、尺寸、截图和完整导航；适合少量关键视觉/E2E 冒烟，不适合作为每个 UI 单测的默认门槛 |
| C. Vitest browser mode（Playwright/WebdriverIO provider） | 仍需 provider 与真实浏览器二进制；比 A 多了 provider/config 约束，且需确认 vitest 5 + Vite 8 的版本组合 | 比 A 高，取决于浏览器启动/复用策略；首次下载和冷启动明显更慢 | 能测真实布局与 CSS；但本轮验收不需要为两个组件付出浏览器冷启动和二进制可重复性成本 |
| D. 仅静态约束 | 零直接依赖，最快 | 几乎 0 | 只能约束源码字符串或简单 lint 规则；无法验证事件、焦点、重挂载、回调或运行态条件渲染 |

### 决策

采用 **A**，并保留 X11 已有的源码契约断言作为 **D 补充**：

- `key={draft.uid}` 由 `SettingsModal` DOM 交互测试直接验证；连续输入测试在反向改回
  `key={name}` 后真实失败。
- 名称 input 的 `w-full h-9` / 禁止 `flex-1 h-9` 由既有
  `tests/integration/settings-provider-drafts.test.ts` 的源码契约守住。这是 jsdom
  无布局能力下的明确补偿，不把“DOM 测试通过”误报成“视觉回归已被自动捕获”。
- B/C 暂不纳入常规门槛：二进制体积、首次下载、冷启动和离线可重复性成本高于当前
  两个高频组件的收益；如后续要覆盖真实高度/间距/对齐，应单独立项并固定已安装的
  Chromium，且 CI 必须有明确缓存/无网络策略。

## 3. 环境切换与测试布局

采用 Vitest 文件头环境切换，而不是 `test.projects`：

```text
tests/integration/**/*.test.ts   # 默认 node，既有 7 文件不修改断言
tests/ui/**/*.test.tsx           # 每个文件首行 // @vitest-environment jsdom
```

原因：

1. 改动只落在 `vitest.config.ts` 的 include 和每个 DOM 测试文件头，现有 node 测试
   不需要迁移/拆分项目。
2. 现有 7 个 integration 文件的状态隔离、`isolate: true`、20s 超时保持原样。
3. jsdom 文件自描述，新增 UI 测试可复制同一环境声明；`globals: false` 继续保持，
   每个测试显式从 `vitest` 导入 API。

## 4. 测试策略

### `SettingsModal`（11 例）

- 加载骨架（`initialConfig=null`）
- 连续输入：值累积、同一 DOM 节点、焦点仍在 input、选区推进到末尾
- 添加 provider 后既有 card/input 身份稳定
- 空名与重名：卡片内 + 页脚提示共 2/3 处，保存禁用
- 模型行增删、provider 删除
- 取消、Esc、遮罩三种关闭路径；内层点击不冒泡关闭
- `onSave` 载荷：名称/模型 ID trim、空模型过滤

`toDrafts` / `toConfig` 的纯逻辑仍由既有 16 例 node 测试负责，本任务没有重复测试。

### `SourceTableNode`（5 例）

- 字段、PK/FK 徽标、字段描述、数据源类型、限定名与行数
- `引用` 按钮调用 `addReference(id)`
- 缺失 `qualifiedName` / `datasourceType` 时回退旧显示且不出现 `undefined`
- 超过 6 行字段的展开/折叠
- 删除按钮调用 `deleteNodes([id])`

画布节点使用 `ReactFlowProvider` 包裹以提供 Handle 所需的 store context；业务组件
不增加 test id，也不修改可测性 API。

## 5. 类型检查取舍

没有新增 `tsconfig.tests.json`。原因：

- 仓库既有的 `tests/integration/` 同样不在 `tsc -b` 引用中；单独新增 tests project
  会让 build 的 project references 增加一份独立配置与增量输出。
- Vitest 通过 Vite 转译测试文件，ESLint 覆盖 `tests/ui/`；本任务没有引入依赖测试
  类型反射的复杂 helper。
- 若未来把 UI suite 扩展到大型页面/复杂 fixture，建议单独立 `tsconfig.tests.json`
  并在 `verify:ui` 前做一次 `tsc -p ... --noEmit`，而不是把测试类型检查塞进每次
  production `tsc -b`。

## 6. 不在本任务范围

- 不改变 `src/` 业务行为；本次 UI 测试零业务源码改动。
- 不引入运行时依赖，不新增网络/真实 LLM/真实 `govio-cli` 依赖。
- 不把 `npm run verify:integration` 改成只跑 integration：保持既有聚合顺序和
  X4 的“一次 `vitest run`”行为；因此 `verify` 会在 integration 全量跑完后，
  再由 `verify:ui` 定向重复执行 16 例 UI 测试。这个重复约 2.8s，远低于 60s 预算，
  换取既有脚本零改写。

## 7. 遗留问题

1. **jsdom 仍无布局引擎**：`w-full h-9` 与 `flex-1 h-9` 在本轮反向验证中均让
   16 个 UI 用例全绿，不能把组件 DOM 测试当作视觉回归。当前补偿是保持 X11
   源码契约断言；后续若要验证真实高度、间距、对齐或截图，应引入 B/C 的真浏览器
   通道，并把浏览器二进制固定/缓存后单独纳入 CI。
2. **UI 用例尚未做 TypeScript project 类型检查**：原因见 §5；后续扩展复杂 fixture
   前建议补 `tsconfig.tests.json`。
3. **测试目录重复执行**：`verify:integration` 仍为 `vitest run`，会包含 UI 文件；
   `verify:ui` 再定向跑一次以保证新增入口显式可见。若后续 UI suite 变大，应评审
   是否把 integration 脚本收敛为 `tests/integration`，避免重复耗时。
4. **视觉基线未建立**：本任务没有截图快照、像素 diff 或真实浏览器尺寸断言。
   这些属于 B/C 的后续能力，不应由 jsdom 伪装覆盖。
