/**
 * Analysis Manifest —— 分析留痕数据模型（ROADMAP Phase 1 / KR1）。
 *
 * 每一次「产生分析结果」的动作（observe load、SQL 编辑器执行、助手消息里的 SQL）
 * 都固化一份 Manifest，挂在 dataFrame / sqlQuery 节点的 `data.manifest` 上，
 * 随 canvas sidecar（`<session-file>.canvas.json`）持久化。
 *
 * 下游消费者：
 * - T1.2 一键复跑：按 `sql` + `datasource` 重跑，用 `checksum` 判断漂移
 * - T1.3 权限审计：用 `permissionDecisionId` 回查 `.govio/sessions/` 下的确认记录
 * - T1.4 交付导出：Manifest 附录
 *
 * 本文件只放类型（前后端共享，服务端以 `../src/types/manifest.js` 导入）；
 * 构建与哈希逻辑在 `server/analysis-manifest.ts`。
 */

/** 结果校验和算法标识。算法一旦变更必须换名，否则新旧校验和不可比。 */
export type ManifestChecksumAlgorithm = 'schema-v1';

/**
 * 结果校验和（轻量方案）。
 *
 * 取舍：不对数据内容做哈希。原因是（1）项目纪律「非必要不读取数据内容」，
 * 全量哈希需要读 parquet 全表；（2）大表代价高、复跑会变慢。
 * 因此这里固化「规模 + 结构 + SQL」三类信号：行数/列数变化、列名或 dtype
 * 变化、SQL 被改写都能被检出；纯值级漂移（同结构同规模但数值不同）留给
 * T1.2 复跑时的 govio-cli compare 覆盖。
 */
export interface ManifestChecksum {
  /** 校验和算法标识，当前固定 `schema-v1` */
  algorithm: ManifestChecksumAlgorithm;
  /** 参与哈希的行数（同时是复跑对比的一级信号） */
  rowCount: number;
  /** 参与哈希的列数 */
  columnCount: number;
  /** sha256(JSON.stringify([rowCount, columnCount, [[name, dtype], …]])) 的前 16 位十六进制（列顺序参与哈希） */
  schemaHash: string;
  /** sha256(SQL 全文) 的前 16 位十六进制；SQL 缺失时为空串的哈希（仍可识别 SQL 被补写） */
  sqlHash: string;
}

/** 生成本次分析结果的模型标识。人工执行（SQL 编辑器）时无此字段。 */
export interface ManifestModel {
  /** 模型提供方，如 `anthropic` / `openai` */
  provider?: string;
  /** 请求使用的模型 ID，如 `claude-sonnet-4-5` */
  id?: string;
  /** 模型展示名（可选，仅用于 UI 显示） */
  name?: string;
  /** 实际响应的模型 ID；虚拟模型路由后可能与 `id` 不同 */
  responseModel?: string;
}

/**
 * Manifest 产生路径。用于判断字段可信度：
 * 只有 `observe-load` / `sql-editor` 具备完整可复跑上下文。
 */
export type ManifestOrigin =
  /** agent 执行 `govio-cli observe load` 的 bash 结果流（主路径） */
  | 'observe-load'
  /** `govio_show_dataframe` 工具补出已加载 DataFrame 的节点（无 SQL 上下文） */
  | 'show-dataframe'
  /** SQL 编辑器 `POST /api/execute-sql`（人工执行，无模型信息） */
  | 'sql-editor'
  /** 助手消息中的 ```sql 代码块（sqlQuery 节点，未执行） */
  | 'assistant-sql';

/**
 * 单个分析结果的可复现留痕。
 *
 * 必填字段是「谁、什么时候、用什么 SQL、在哪个数据源上」；
 * 结果指标（行数/列数/校验和）在 SQL 尚未执行时（sqlQuery 节点）缺省。
 */
export interface AnalysisManifest {
  /**
   * Manifest 结构版本号，当前为 1（常量见 `server/analysis-manifest.ts`）。
   * 字段增删时递增，供导出与复跑做兼容判断。
   */
  schemaVersion: number;
  /** 产生路径，见 {@link ManifestOrigin} */
  origin: ManifestOrigin;
  /**
   * SQL 全文（原样保留，含换行与注释）。
   * 无法取得时为空串——例如 `govio_show_dataframe` 展示历史 DataFrame，
   * 其加载命令不在本次会话事件流里。空串意味着该节点不可一键复跑。
   */
  sql: string;
  /**
   * 数据源标识：`observe load --datasource` 的值；`--memory` 派生为 `memory`；
   * 未知时为空串。
   */
  datasource: string;
  /** 结果 DataFrame 名（ObserveStore 中的 `--name`）；sqlQuery 节点无此字段 */
  dfName?: string;
  /** 执行/产生时间（ISO 8601，服务端时钟）。sqlQuery 节点记录消息落地时间 */
  executedAt: string;
  /**
   * 首次固化时间（ISO 8601，不可变）。复跑一致时 `executedAt` 会刷新为复跑时间，
   * 而本字段永远指向结果第一次被交付的时刻；可选字段，旧留痕缺失时可从
   * 最早一条复跑记录的 `before.executedAt` 回溯。新增字段不递增 schemaVersion。
   */
  firstExecutedAt?: string;
  /** 结果行数；未执行或未知时缺省 */
  rowCount?: number;
  /** 结果列数；未执行或未知时缺省 */
  columnCount?: number;
  /** 结果校验和，见 {@link ManifestChecksum}；未执行或拿不到列信息时缺省 */
  checksum?: ManifestChecksum;
  /** 生成模型；人工执行（`sql-editor`）时缺省 */
  model?: ManifestModel;
  /** pi 会话 ID，用于回链 `.govio/sessions/` 下的 transcript */
  sessionId: string;
  /**
   * 关联的权限决策 ID（T1.3 权限审计）。
   * 值是确认门为这次取数生成的 `decisionId`，可在会话的审计 sidecar
   * （`<session-file>.audit.jsonl`）里按该 ID 查到命令原文、决策、决策人与时间。
   * `null` = 本次结果没有经过确认门（无 `-o` 的加载、SQL 编辑器人工执行等）；
   * `undefined` = 旧节点尚未由服务端写入该字段。
   */
  permissionDecisionId?: string | null;
  /**
   * `--memory` 派生时的上游 DataFrame 名列表（已按 SQL 文本过滤，
   * 与节点血缘边一致）。
   */
  sourceDataFrames?: string[];
}
