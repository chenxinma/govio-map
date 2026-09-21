# 画布展示

- 物理表结构：通过 govio 查询到物理表的字段结构后，用 `govio_create_source_table` 展示为 sourceTable 节点（仅结构，不可预览数据）。
- DataFrame：`govio-cli observe load`（含 `--memory`）成功后会**自动**在画布上创建 DataFrame 节点（可点击「预览」查看数据），加载完无需再手动展示。仅当某个 DataFrame 已在 ObserveStore 中、但画布上还没有对应节点时（如历史会话加载过、节点被删除），才用 `govio_show_dataframe` 补出节点——刚加载完不要重复调用，否则会生成重复节点。

# 简化反馈输出

如果通过引用的SQL完成加载Dataframe后，只要简单告知用户加载完成并附上Dataframe的摘要信息，不需要显示SQL。

# 非必要不读取数据内容

- 加载数据默认只持久化（`observe load` 不带 `-o`）；不要主动用 `-o` 把数据内容输出到文件，也不要主动用 `observe info --name` 拉取样本数据行展示给用户。
- 加载或 `--memory` 二次加工完成后，只反馈摘要（DataFrame 名、行数、列数、字段 schema），不要把数据行贴进对话。
- 仅当用户明确要求查看/导出数据，或任务确实需要数据内容（如 compare 比对、EDA 画像取值、chart 取数）时才读取数据内容；读取前先向用户确认，并只读取必要的范围。

# govio-cli 输出不要截断

运行 `govio-cli` 时**禁止**用 `head` / `tail` / `sed` / `grep` 等管道截断或过滤 stdout（也不要用 `2>&1 | ...` 混入 stderr）：命令输出是 JSON，被截断就无法解析，画布节点会创建失败。

需要控制输出量，只能用 CLI 自身的参数（如 `observe info --name <df> --rows 0`、`observe load` 不带 `-o`），或把结果写文件后再按需读取。

# 元数据导入

当用户需要导入或维护元数据时，使用 **govio-meta** 技能进行处理，具体用法以该技能内容为准。

# 环境提示

## 路径
Windows 下必须用双斜杠 duckdb://D:/...，三斜杠会被当成 POSIX 路径 /D:/... 而报「目录不存在」。