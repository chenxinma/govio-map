import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * `observe load` / `observe info` 输出的共享契约（X5）。
 *
 * 一处定义、三处消费：
 *  - `extensions/govio-canvas.ts` handleLoadResult（agent 会话的加载事件 → 画布节点）
 *  - `dataframe-rerun.ts` parseLoadOutput / extractLoadError（复跑留痕比对）
 *  - `parquet-api.ts` /api/execute-sql（SQL 编辑器人工执行）
 *
 * 此前三处各自手写同形状 interface（ObserveInfo / ObserveLoadOutput / 裸 JSON.parse），
 * CLI 字段改名或形状漂移时只有运行时才暴露。统一为 typebox schema 后：
 *  - 类型层：三处消费同一 `ObserveLoadOutput` 派生类型，字段改名编译期即报错；
 *  - 运行时层：`parseObserveLoadOutput` 用 Value.Check 校验，类型漂移（如 rows 变
 *    字符串、输出根本不是对象）被拒绝，不再流入节点创建/留痕固化。
 *
 * 契约是**宽松**的（所有字段 Optional、对象开放额外属性）：
 *  - CLI 新增输出字段不误杀；
 *  - jq 摘要管道产生的显式 `null`（如 `{"name":null,"rows":null,...}`）仍是合法
 *    JSON 形状，必须能通过校验——它「合法但不可信」，交给
 *    `isTrustworthyLoadOutput`（govio-canvas.ts）按成功信号判定，两层职责不同：
 *    schema 管形状合法，trust 谓词管语义可信（见 docs/tasks/BUGFIX-load-parse.md）。
 */

/**
 * 列描述。CLI 两种命令的列名键不统一：load 输出用 `name`，info 输出用 `column`，
 * 历史输出出现过 `col`——三键 Optional 互补，取值统一走 `observeColumnName`。
 */
export const ObserveColumnSchema = Type.Object({
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  column: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  col: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dtype: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type ObserveColumn = Static<typeof ObserveColumnSchema>;

export const ObserveLoadOutputSchema = Type.Object({
  /** CLI 显式成败信号；SQL 执行失败时退出码仍可能为 0、仅靠 success:false 表达 */
  success: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  /** DataFrame 名（load 输出） */
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  rows: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  columns: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  /** load 输出的列信息 */
  column_info: Type.Optional(Type.Union([Type.Array(ObserveColumnSchema), Type.Null()])),
  /** info 输出的列信息 */
  schema: Type.Optional(Type.Union([Type.Array(ObserveColumnSchema), Type.Null()])),
  /** success:false 时的失败原因（SQL 错误、表不存在等） */
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** 失败原因的备选键（部分命令用 message） */
  message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** --memory 加载时上游 DataFrame 名列表（血缘用；仅 load 输出携带） */
  source_tables: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});

export type ObserveLoadOutput = Static<typeof ObserveLoadOutputSchema>;

/**
 * 解析并校验 CLI stdout。返回 null 的两种情形（调用方按各自策略处理）：
 *  - 非法 JSON：典型是 `| head`/`| tail` 截断了输出；
 *  - 形状漂移：JSON 合法但不是契约对象（数组/标量），或已知字段类型不符。
 *
 * 注意：null ≠ 加载失败。显式失败（success:false）是**合法形状**，会正常返回，
 * 由 `isLoadFailure` 判定——失败原因需要透传给用户（extractLoadError / 400 响应）。
 */
export function parseObserveLoadOutput(stdout: string): ObserveLoadOutput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Value.Check(ObserveLoadOutputSchema, raw)) return null;
  return raw as ObserveLoadOutput;
}

/**
 * 显式失败：CLI 退出码 0 但 `{success:false, error/message}`（SQL 错误、catalog 歧义等）。
 * 类型守卫用交叉型（而非 `parsed is ObserveLoadOutput`），避免 false 分支被 TS
 * 收窄成 never（消费方在排除失败后还要继续读 rows/column_info）。
 */
export function isLoadFailure(parsed: ObserveLoadOutput | null): parsed is ObserveLoadOutput & { success: false } {
  return parsed !== null && parsed.success === false;
}

/** 列名归一：与三处消费此前各自手写的 `name ?? column ?? col ?? "unknown"` 同一优先级 */
export function observeColumnName(col: ObserveColumn): string {
  return col.name ?? col.column ?? col.col ?? "unknown";
}
