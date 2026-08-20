# DataFrame 分类打标与 Treemap 分层统计展示（设计）

> 状态：方案已评审定稿（2026-08-20），待实施
> 决策：渲染采用 chartjs-chart-treemap 插件（方案 A）；第一版只做静态比例 + tooltip，不做下钻

## 目标

支持用户对已加载的 DataFrame 做条件分类打标（CASE WHEN 语义），按多个分类标识聚合统计行数，并按指定层级路径（如 `catalog1 -> catalog2 -> catalog3`）在画布上以 Treemap 展示各分类的数据量分布。

## 需求场景

典型用户请求：

> "对 df_xxx 按 case when col1='01' then 'TypeA' when col1='02' then 'TypeB' else 'Other' end 生成 catalog1，类似再生成 catalog2、catalog3，然后按这三个标识 group by 统计行数，按 catalog1,catalog2,catalog3 的路径展示一个 treemap 到画布上。"

链路分解为三段：

1. **打标**：为每行派生一个或多个分类标识列（catalog1/2/3...），条件由用户给出
2. **聚合**：按标识列组合 GROUP BY 统计行数
3. **展示**：按层级路径渲染 Treemap 到画布节点

## 现状盘点

| 环节 | 现状 | 结论 |
|------|------|------|
| CASE WHEN 打标 | `observe load --memory` 走 DuckDB，原生支持 | **零改动** |
| GROUP BY 统计 | 同上 | **零改动** |
| 画布图表节点 | `govio_show_chart` 工具 + ChartNode（Chart.js canvas 渲染）+ ChartModal（放大）已存在 | **复用** |
| Treemap 图型 | Chart.js 核心不支持 | **唯一缺口** |

数据链路完全不新增代码；改动集中在渲染链路，总量约 4 处小改。

## 总体架构

```
用户请求（分类条件 + path）
    ↓
agent 构造打标+聚合 SQL
    ↓
govio-cli observe load --name df_cat_stats --memory --sql "..."
    ↓                                    （画布自动出现 df_cat_stats 的 DataFrame 节点）
ObserveStore: df_cat_stats（行: catalog1, catalog2, catalog3, cnt）
    ↓  agent 从 info --name 拿到样本/schema，组装 flat rows
agent 调 govio_show_chart(config)
    ↓  config.type = "treemap"，datasets[0] = { tree: <flat rows>, key: "cnt", groups: [...] }
server push chart node event（config 透传）
    ↓
ChartNode: chartjs-chart-treemap 按 groups 自动聚合分层 + squarified 布局渲染
    ↓
tooltip 显示各分类值 / 占比
```

关键设计点：**flat rows 直传，AI 不组装嵌套树**。chartjs-chart-treemap 的 dataset 接受扁平行数组（`tree`），配 `key`（数值列）和 `groups`（层级列，按序嵌套）后由插件自动完成层级聚合并布局。父级块的面积 = 其子块面积之和，无需 SQL 侧做 ROLLUP/GROUPING SETS。

## 数据链路设计（零改动）

### 单步方案：打标 + 聚合合并为一条 --memory SQL

```sql
SELECT catalog1, catalog2, catalog3, COUNT(*) AS cnt
FROM (
  SELECT
    CASE WHEN col1 = '01' THEN 'TypeA'
         WHEN col1 = '02' THEN 'TypeB'
         ELSE 'Other' END AS catalog1,
    CASE WHEN col2 IN ('A','B') THEN 'Level1'
         WHEN col2 IN ('C','D') THEN 'Level2'
         ELSE 'Other' END AS catalog2,
    CASE WHEN amount >= 10000 THEN 'Big'
         WHEN amount >= 1000  THEN 'Mid'
         ELSE 'Small' END     AS catalog3
  FROM df_base
)
GROUP BY catalog1, catalog2, catalog3
ORDER BY cnt DESC
```

```bash
govio-cli observe load --name df_cat_stats --memory --sql "<上述 SQL>"
```

产物 `df_cat_stats` 的每一行即 treemap 的一个叶子：`tree` 元素。

### 两步方案（可选）

打标中间表落一个 df（`df_labeled`，含 `SELECT *, CASE...`），再在其上聚合。适用于用户还要对打标结果做其他分析的场景。仅展示 treemap 时用单步即可。

### 大基数控制

treemap 叶子过多时视觉不可读，且 `govio_show_chart` 工具调用的 JSON 体积膨胀。约定：

- 层级数建议 ≤ 3（`groups` 最多 3 个）
- 聚合后行数 > 200 时，agent 应改用 `ORDER BY cnt DESC LIMIT N` 截断 + 把剩余桶进 `Other`（SQL 侧窗口函数实现），或建议用户收窄某一层分类
- 各层分类基数（DISTINCT 值个数）本身很大时（如自由文本列），提前提示用户该列不适合做 treemap 分组

### 空值与 ELSE

- CASE WHEN 必须带 `ELSE` 兜底（建议 `'Other'`），避免 NULL 组在 treemap 中显示为空标签
- 源列本身为 NULL 的行会被 ELSE 接住；若希望单列，用 `WHEN col IS NULL THEN 'Unknown'`

## 渲染链路设计

### 选型对比（已评审）

| 方案 | 优势 | 代价 | 结论 |
|------|------|------|------|
| A. chartjs-chart-treemap 插件 | 复用现有 ChartNode/govio_show_chart 管线，前端改动 ~10 行；flat rows 直传 | 新依赖 ~15KB；无原生下钻 | **采用（第一版）** |
| B. 自写 TreemapNode（div + squarified） | 无依赖、交互完全可控（下钻/面包屑） | 新节点类型全套 + ~150 行 | 下钻需求出现时升级 |
| C. ECharts | treemap 最成熟、原生下钻 | ~1MB 重依赖，仅为一个图型不值 | 否决 |

### chartjs-chart-treemap 关键事实（已对官方仓库核实）

- peerDependencies: `chart.js >= 3.0.0`，兼容本项目 `chart.js ^4.5.1`
- ESM 入口（`dist/chartjs-chart-treemap.esm.js`）不做自动注册，**必须显式注册**，且注意类名是 `TreemapController`（小写 m，不是 TreeMapController）：

  ```ts
  import { TreemapController, TreemapElement } from 'chartjs-chart-treemap';
  Chart.register(TreemapController, TreemapElement);
  ```

- 分层用法（官方 groups 示例同构）：

  ```js
  {
    type: 'treemap',
    data: {
      datasets: [{
        tree: [ { region: '...', division: '...', state: '...', area: 123 }, ... ],  // flat rows
        key: 'area',          // 数值列（面积权重）
        groups: ['region', 'division', 'state'],  // 层级路径，按序嵌套
        spacing: 1,
        borderWidth: 0.5,
      }]
    }
  }
  ```

- tooltip 数据访问：`item.raw.v` 为该块聚合值，`item.raw._data` 为该块对应的原始分组数据（取层级标签用）
- 分层配色：`backgroundColor` 可传函数，按 `ctx.raw._data.<第一层列名>` 映射固定色板，实现"同 catalog1 同色"的分组视觉

### govio_show_chart 调用模板（agent 侧）

```json
{
  "title": "Chart: df_cat_stats (treemap)",
  "sourceDf": "df_cat_stats",
  "config": {
    "type": "treemap",
    "data": {
      "datasets": [{
        "label": "数据量",
        "tree": [
          { "catalog1": "TypeA", "catalog2": "Level1", "catalog3": "Big", "cnt": 120 },
          { "catalog1": "TypeA", "catalog2": "Level1", "catalog3": "Mid", "cnt": 80 },
          { "catalog1": "TypeB", "catalog2": "Level2", "catalog3": "Small", "cnt": 45 }
        ],
        "key": "cnt",
        "groups": ["catalog1", "catalog2", "catalog3"],
        "spacing": 1,
        "borderWidth": 0.5,
        "borderColor": "rgba(200,200,200,1)"
      }]
    },
    "options": {
      "plugins": {
        "legend": { "display": false },
        "tooltip": {
          "callbacks": {
            "label": "(item) => { const d = item.raw._data; return (d.catalog3 || d.catalog2 || d.catalog1) + ': ' + item.raw.v; }"
          }
        }
      }
    }
  }
}
```

> 注：`backgroundColor`/`callbacks` 等函数值能否透传取决于 govio_show_chart 的 schema 对 `unknown` 的序列化策略；若只允许 JSON 值，则 tooltip 用插件默认行为（显示 value），或后续在 schema 中预留 `labels.formatter` 的字符串模板约定。实施时验证。

### 改动清单

| # | 位置 | 改动 | 规模 |
|---|------|------|------|
| 1 | `package.json` | `npm i chartjs-chart-treemap`（~15KB，peer chart.js>=3 已满足） | 1 依赖 |
| 2 | `src/components/Nodes/ChartNode.tsx`、`ChartModal.tsx` | 各自在 `Chart.register(...registerables)` 后追加 `Chart.register(TreemapController, TreemapElement)`（注册幂等；两处独立 `new Chart`，都需注册） | 各 +2 行 |
| 3 | `server/extensions/govio-canvas.ts` | `govio_show_chart` 的 typebox schema：`config.type` 描述加入 `"treemap"`；dataset 对象增加可选字段 `tree?: Array<Record<string,unknown>>`、`key?: string`、`groups?: string[]`，`data` 改为可选（treemap 用 `tree` 不用 `data`）。否则严格校验会拒绝 treemap dataset | ~10 行 |
| 4 | `src/types/index.ts` | `ChartConfig.datasets[]` 类型同步放宽（`tree?/key?/groups?`，`data?` 可选） | ~5 行 |
| 5 | `.pi/skills/govio-observe/SKILL.md` chart 章节（及 `govio_show_chart` 工具 description 提到的 chart-selector skill，若后续创建） | 补 treemap 模式：单步 --memory 打标聚合 SQL + govio_show_chart treemap config 模板 + 大基数约定 | 文档 |

不新增 CLI 子命令（如 `observe classify`）——SQL 表达力完整覆盖，新增命令只多一条维护路径。

### 不做的事（第一版明确排除）

- **点击下钻**（点 catalog1 块展开 catalog2 层级）：chartjs-chart-treemap 需命令式 onClick + 重建 tree，与 config 透传架构不匹配
- **新 TreemapNode 节点类型**：ChartNode 渲染 `type: 'treemap'` 与其他 chart 类型无差别
- **Sunburst/旭日图** 等其他层级图型：treemap 已覆盖"按 path 看数据量分布"

## 升级路径

下钻需求真实出现时：新建自写 TreemapNode（div + squarified 布局，~150 行），**数据通道不变**——仍接收 flat rows + `groups` 路径定义，仅渲染层从 Chart.js canvas 换为 DOM。届时 chart node 的 config 数据结构直接复用，AI 侧调用方式不变。

## 参考

- chartjs-chart-treemap：<https://github.com/kurkle/chartjs-chart-treemap> / 文档 <https://chartjs-chart-treemap.pages.dev/>
- 官方 groups 示例（flat rows + key + groups 分层）：<https://github.com/kurkle/chartjs-chart-treemap/blob/main/docs/samples/groups.md>
- 本项目 Chart.js 节点设计：`docs/plans/2026-07-06-chart-js-node-design.md`
- observe 命令组：`.pi/skills/govio-observe/SKILL.md`
