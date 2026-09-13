# 画布展示

- 物理表结构：通过 govio 查询到物理表的字段结构后，用 `govio_create_source_table` 展示为 sourceTable 节点（仅结构，不可预览数据）。
- DataFrame：`govio-cli observe load`（含 `--memory`）成功后会**自动**在画布上创建 DataFrame 节点（可点击「预览」查看数据），加载完无需再手动展示。仅当某个 DataFrame 已在 ObserveStore 中、但画布上还没有对应节点时（如历史会话加载过、节点被删除），才用 `govio_show_dataframe` 补出节点——刚加载完不要重复调用，否则会生成重复节点。

# 简化反馈输出

如果通过引用的SQL完成加载Dataframe后，只要简单告知用户加载完成并附上Dataframe的摘要信息，不需要显示SQL。

# 非必要不读取数据内容

- 加载数据默认只持久化（`observe load` 不带 `-o`）；不要主动用 `-o` 把数据内容输出到文件，也不要主动用 `observe info --name` 拉取样本数据行展示给用户。
- 加载或 `--memory` 二次加工完成后，只反馈摘要（DataFrame 名、行数、列数、字段 schema），不要把数据行贴进对话。
- 仅当用户明确要求查看/导出数据，或任务确实需要数据内容（如 compare 比对、EDA 画像取值、chart 取数）时才读取数据内容；读取前先向用户确认，并只读取必要的范围。

# Bash 路径规范

当前 bash 环境为 Git Bash（xterm-256color），非原生 cmd/PowerShell。路径规则：
- **统一使用正斜杠** `/`（如 `D:/Work/gov-io/data/sales.duckdb`）
- **路径末尾不要以反斜杠 `\` 结尾**，否则会被 bash 当作转义符吞掉后续引号，导致 `unexpected EOF` 错误
- 需要 cd 到项目目录时，优先使用 `cd /d/Work/gov-io/govio-map && ...` 的相对路径写法

# JSON 解析

bash 中 `python` 指向 Windows Store 存根（不可用，退出码 49）。解析 JSON 时：
- **优先使用 `jq`**（已安装，版本 1.6，路径 `/d/Work/jq/jq`）
- 简单提取：`command | jq -r '.field'`
- 管道拼接：`command | jq -r '.name, .rows, .columns'`
- 若 jq 不适用，可用 `node -e` 作为备选

# observe load 命令禁止管道截断

`govio-cli observe load` 的 stdout 是完整 JSON，后端扩展依赖它自动创建画布 DataFrame 节点。**禁止**对 load 命令加 `| head`、`| tail` 等管道截断——截断会导致 JSON 解析失败，画布节点静默丢失。
- 正确：`govio-cli observe load --name xxx --datasource yyy --sql "..." 2>&1`
- 错误：`govio-cli observe load ... 2>&1 | head -20` ❌
- 如果只需要摘要字段，用 `jq` 提取：`govio-cli observe load ... 2>&1 | jq '{name, rows, columns}'`

# Cypher 查询纪律

执行 `govio-cli query -c` 查询图数据库前，**必须先读取** `../govio/assets/schema.md`（位于 govio skill 目录下）了解图库的节点与边结构，**仅需读一次**。禁止凭记忆构造 Cypher 属性名——未在 schema.md 中出现的属性（如 `description`）会导致 Ladybug 抛出 `Binder exception`。
