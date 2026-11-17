/**
 * T3.1 sidecar 路径单一来源：画布工件与存储绑定文件的命名规则。
 * session-history.ts 以 re-export 保持既有公共 API（canvasPathFor）兼容。
 */
import { resolve as resolvePath } from "node:path";

/** 画布 sidecar 路径；同目录下还有权限审计/注入留痕 sidecar 与本绑定文件。 */
export function canvasPathFor(sessionFile: string): string {
  return sessionFile + ".canvas.json";
}

/**
 * 逐画布存储绑定 sidecar（T3.1 配置模型的落盘形态）。
 * 只存 profile 引用与同步元数据；凭据、endpoint 明文一律不在此文件（design.md 凭据安全节）。
 */
export function storageBindingPathFor(sessionFile: string): string {
  return sessionFile + ".storage.json";
}

/**
 * 只读分享开关 sidecar（T3.5）：`<session>.jsonl.share.json`。
 *
 * 文件存在且 `enabled:true` 即「该会话已开启活视图分享」——它同时是 token 的
 * **访问控制**（未开启的会话其派生 token 解析不到）与**撤销机制**（删除文件即失效）。
 * 仅本地，不随 T3.1 同步到 S3（活视图只读本地当前会话，见 T3.5 design.md）。
 */
export function shareStatePathFor(sessionFile: string): string {
  return sessionFile + ".share.json";
}

/**
 * 导入来源 sidecar（T3.7）：`<session>.jsonl.import.json`。
 *
 * 只有「由 `/import` 落地的会话」才有这个文件，所以它的**存在本身就是「原生 vs 导入」的
 * 权威判别依据**（内容是 {@link SessionImportMeta}：来源 token / 导出时间 / 源会话 id /
 * 包文件名 / 导入时间 + 落地文件与排除记账）。仅本地，不随 T3.1 同步到 S3。
 */
export function importMetaPathFor(sessionFile: string): string {
  return sessionFile + ".import.json";
}

/**
 * ObserveStore 的 DataFrame parquet 目录（相对 cwd），T3.6 打包时用它给「已排除的
 * 大数据文件」记账（parquet 不入包，但 bundle.json 必须写明缺了什么）。
 *
 * 注意：`server/parquet-api.ts` 目前仍持有同值的本地常量 `PARQUET_DIR`（读写预览用），
 * 本任务按范围纪律未改动它；两处收敛记在 T3.6 design.md 遗留问题。
 */
export const DATAFRAME_PARQUET_DIR = ".govio/observe/dataframes";

/** parquet 目录绝对路径（随 cwd 变化，与 parquet-api.ts 的 resolve 方式一致）。 */
export function dataframeParquetDir(): string {
  return resolvePath(process.cwd(), DATAFRAME_PARQUET_DIR);
}

/**
 * DataFrame 名 → parquet 绝对路径；名字不是安全标识符时返回 `null`。
 *
 * dfName 来自画布节点里的 Manifest（外部内容），直接拼路径就等于把目录穿越交给
 * 会话数据；这里与 `parquet-api.ts` 的 `SAFE_DF_NAME_RE` 同款白名单先挡一道
 * （该正则的收敛同样记在 design.md 遗留问题）。
 */
export function dataframeParquetPathFor(dfName: string): string | null {
  if (typeof dfName !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(dfName)) return null;
  return resolvePath(dataframeParquetDir(), `${dfName}.parquet`);
}
