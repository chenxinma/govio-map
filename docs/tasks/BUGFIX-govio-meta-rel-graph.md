# BUGFIX：govio-cli 0.8.0 `meta rel` / `meta graph` 两缺陷（X34 可用性 Round 1 发现）

> 发现：X34 首个零环境试用（2026-11-28，`docs/tasks/X34-onboarding-gui/usability-round1.md`）
> 归属：**govio 仓**（`D:/Work/gov-io/govio`），govio-cli 0.8.0 缺陷；govio-map 不受影响（消费侧）
> 状态：待修复（修复走 govio 仓 PR → govio 0.8.1 发版 → govio-map MIN_GOVIO_CLI_VERSION 提升）

## 缺陷 1：`meta rel` 输出 CSV 表头与 `meta graph` 导入不兼容

**现象**：`meta rel` 生成的 `RELATES_TO.csv` 表头带两个前置列 `source,target`（值恒为空），
`meta graph` 导入报 `Binder exception: Table source does not exist`。把端点列
`:START_ID(PhysicalTable),:END_ID(PhysicalTable)` 放到最前即可正常导入（测试者已验证，3 条边全部入库）。

**根因面（主会话定位）**：
- `src/govio/cli/meta/merge.py:60` `merge_edge_csv`：与已有 CSV 合并时 `pd.concat([existing, new_df])`
  列取并集、列序取 existing 优先，且 `to_csv` 不校正列序/不剔除未知列 → 杂散 `source,target`
  留在表头最前（新行该两列值为空，与现象完全吻合）
- `src/govio/graph/ladybug_loader.py` `import_csv_to_ladybug` / `upsert_csv_to_ladybug`：边表
  导入对端点列名/位置敏感，遇未知列报 Ladybug Binder exception（信息不可读）
- 注：`load_relationships`（`src/govio/metadata/relationship.py`）非空分支产 `source,target` 列，
  `step_rel_export`（`src/govio/cli/meta/steps.py:170`）rename 为端点列名——单次全新跑应无
  `source,target`；杂散列的出现路径需复现确认（疑似输出目录已有旧版/别路径产物被 merge 并入）

**修复要求**：
1. `merge_edge_csv` 写盘前**规范化列**：端点列（dedup_cols）置首、元数据列随后、剔除全空/未知列；
   合并旧 CSV 时对不识别的列（如 `source,target`）丢弃或给出可读警告
2. `meta graph` 导入容错：遇到多余列明确报错/忽略并警告，Binder 失败给可读提示（指向表头规范）
3. 回归断言：构造「输出目录已有带 `source,target` 的旧 RELATES_TO.csv」场景，断言 `meta rel`
   重跑后表头 = `:START_ID(PhysicalTable),:END_ID(PhysicalTable),relationship_type,...` 且可被
   `meta graph`（ladybug）成功导入

## 缺陷 2：`meta graph --mode update` 对旧 lbdb 报 `Cannot find property node_id for n`

**现象**：同一旧库上 `--mode update` 报 `Cannot find property node_id for n`；`--mode rebuild`
全量重建正常。旧 lbdb 的 PhysicalTable/Col 节点缺 `node_id` 属性（旧版 DDL 遗留）。

**根因面（主会话定位）**：
- `src/govio/graph/ladybug_loader.py:228` `upsert_csv_to_ladybug`：`CREATE IF NOT EXISTS + UNWIND
  MERGE`（节点按 `id` 主键 MERGE 并 SET 属性）——旧库表 schema 无 `node_id` 列，Ladybug 严格
  schema，MERGE/SET 触发 Binder 异常
- CSV 侧已有兜底（`merge.py:98` `_load_csv_with_node_ids` 缺列重生成），缺口纯在图侧旧库 DDL

**修复要求**：
1. `--mode update` 对旧库自动迁移：检测目标表缺 `node_id` 属性列时 ALTER/重建表结构并回填
   （按自然键 `full_table_name` / `column` 等值回填 node_id），或提供可读的一键迁移提示
2. 回归断言：用旧版 DDL 形态的库跑 `--mode update` 成功（或给出明确迁移指引而非 Binder 裸异常）

## 复现素材（测试机）

- `C:\Work\output\RELATES_TO.csv`（CLI 原样输出，含杂散 `source,target`）
- `/tmp/gtest2`（修正表头版，导入成功）
- `C:\Users\Rachel WANG\.govio\ontology.lbdb.bak-143424` / `ontology.lbdb.old`（旧库备份）
