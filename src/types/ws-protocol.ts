import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * `/ws` 通道协议契约（X2）——双端类型单一来源。
 *
 * 一处定义、两端消费：
 *  - `server/ws-handler.ts`：入站消息 `parseWSClientMessage` 运行时校验（未知/非法拒绝），
 *    出站消息经 `WSServerMessage` 派生类型编译期对齐（sendMsg 包装）；
 *  - `src/hooks/useChat.ts`：出站 `WSClientMessage` 编译期对齐，入站按
 *    `WSServerMessage` 判别联合收窄（容忍未知消息，见下）。
 *
 * ## 版本化
 *
 * 契约以 `PROTOCOL_VERSION` 版本化；每条消息 schema 携带 `$id: "govio-ws/v1/<type>"`
 * 与 `version` 字段（schema 元数据层）。**version 不上线**：X2 约束消息字段逐字节
 * 等价，而当前线上协议没有版本字段；v1 的版本语义由「部署对」隐式携带
 * （前后端同仓同构建）。未来若需跨版本协商（如独立发版的客户端），演进路径是
 * 新增 hello/握手消息携带 version，而非给存量消息逐条加字段——见 design.md 遗留问题。
 *
 * ## 兼容策略（旧客户端 / 新消息的容忍规则）
 *
 * 1. **服务端 → 客户端（客户端容忍）**：客户端对未知 `type` 的服务端消息**忽略不崩**
 *    （useChat 的 switch 无 default 分支）；新增服务端消息类型对旧客户端零破坏。
 * 2. **客户端 → 服务端（服务端把关）**：未知 `type` 与形状非法（字段类型/字面量不符）
 *    的入站消息被**拒绝**并回 `error`（此前未知消息被静默忽略、形状漂移被隐式强转，
 *    是 acceptance 要求的唯一行为收紧）；连接不因此断开。
 * 3. **附加字段容忍**：两端 schema 均允许额外属性（JSON Schema 默认），新版本在既有
 *    消息上加字段不被旧端拒绝；`type` 是唯一判别字段。
 * 4. **字段必需性**与改造前内联 interface 保持一致（业务级必填仍由 handler guard
 *    拦截并保留原错误文案，如 `session_open requires path`）；schema 负责形状合法。
 */

/** 协议版本（契约元数据层，不上线，见文件头注释） */
export const PROTOCOL_VERSION = 1;

/** schema `$id` 前缀；`<type>` 为消息 type 字面量 */
export const PROTOCOL_ID_PREFIX = `govio-ws/v${PROTOCOL_VERSION}`;

// ── 载荷构件 ────────────────────────────────────────────────────────────────

/** prompt/steer 的引用节点（客户端 src/types ReferencedNode 的线上形态；data 可为 null） */
export const WSReferencedNodeSchema = Type.Object(
  {
    nodeId: Type.String(),
    label: Type.String(),
    type: Type.String(),
    data: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { version: PROTOCOL_VERSION },
);
export type WSReferencedNode = Static<typeof WSReferencedNodeSchema>;

/** 权限决策（与 server/permission-manager.ts 的 PermissionDecision 同型，编译期双向对齐） */
export const WSPermissionDecisionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("edit"),
]);
export type WSPermissionDecision = Static<typeof WSPermissionDecisionSchema>;

/** 工具调用（tool_start 入参 / 展示记录 tools 元素；args 是 SDK 透传的开放载荷） */
export const WSDisplayToolCallSchema = Type.Object(
  {
    toolName: Type.String(),
    toolCallId: Type.Optional(Type.String()),
    success: Type.Optional(Type.Boolean()),
    args: Type.Optional(Type.Unknown()),
  },
  { version: PROTOCOL_VERSION },
);
export type WSDisplayToolCall = Static<typeof WSDisplayToolCallSchema>;

/** 会话展示记录条目（session_messages_result.messages 元素） */
export const WSTranscriptMessageSchema = Type.Object(
  {
    id: Type.String(),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    thinking: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(WSDisplayToolCallSchema)),
    referencedNodes: Type.Optional(Type.Array(WSReferencedNodeSchema)),
  },
  { version: PROTOCOL_VERSION },
);
export type WSTranscriptMessage = Static<typeof WSTranscriptMessageSchema>;

/** 历史会话列表条目（session_list_result.sessions 元素） */
export const WSSessionListItemSchema = Type.Object(
  {
    id: Type.String(),
    path: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    preview: Type.String(),
    messageCount: Type.Number(),
    modified: Type.String(),
  },
  { version: PROTOCOL_VERSION },
);
export type WSSessionListItem = Static<typeof WSSessionListItemSchema>;

/** DataFrame 摘要（observe_info_result 的叶子；消费方 DataSourcesModal） */
export const WSDataFrameSummarySchema = Type.Object(
  {
    name: Type.String(),
    rows: Type.Number(),
    columns: Type.Number(),
    column_info: Type.Optional(
      Type.Array(Type.Object({ name: Type.String(), dtype: Type.String() }, { additionalProperties: true })),
    ),
  },
  { additionalProperties: true, version: PROTOCOL_VERSION },
);
export type WSDataFrameSummary = Static<typeof WSDataFrameSummarySchema>;

/** observe info 输出（govio-cli JSON 透传的开放形状，此处只锚定消费方实际读取的字段） */
export const WSObserveInfoSchema = Type.Object(
  {
    datasources: Type.Optional(Type.Array(Type.String())),
    dataframes: Type.Optional(
      Type.Object(
        { dataframes: Type.Optional(Type.Array(WSDataFrameSummarySchema)) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true, version: PROTOCOL_VERSION },
);
export type WSObserveInfo = Static<typeof WSObserveInfoSchema>;

/** 模型配置（与 src/types/models-config.ts 的 ModelsConfig 同型，编译期双向对齐） */
export const WSProviderModelSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
  },
  { additionalProperties: true, version: PROTOCOL_VERSION },
);
export const WSProviderConfigSchema = Type.Object(
  {
    baseUrl: Type.String(),
    api: Type.String(),
    apiKey: Type.String(),
    models: Type.Array(WSProviderModelSchema),
  },
  { additionalProperties: true, version: PROTOCOL_VERSION },
);
export const WSModelsConfigSchema = Type.Object(
  {
    providers: Type.Record(Type.String(), WSProviderConfigSchema),
  },
  { additionalProperties: true, version: PROTOCOL_VERSION },
);
export type WSModelsConfig = Static<typeof WSModelsConfigSchema>;

// ── X34 onboarding（P1b）载荷构件 ────────────────────────────────────────────

/** 图后端配置（init_graph 载荷；falkordb/networkx 只收参不建运维能力，见 X34 design.md §8） */
export const WSOnboardingGraphConfigSchema = Type.Object(
  {
    backend: Type.Union([
      Type.Literal("ladybug"),
      Type.Literal("falkordb"),
      Type.Literal("networkx"),
    ]),
    dbPath: Type.Optional(Type.String()),
    host: Type.Optional(Type.String()),
    port: Type.Optional(Type.String()),
    graphName: Type.Optional(Type.String()),
    gmlPath: Type.Optional(Type.String()),
  },
  { version: PROTOCOL_VERSION },
);
export type WSOnboardingGraphConfig = Static<typeof WSOnboardingGraphConfigSchema>;

/**
 * add_datasource 数据源载荷。password 只在「前端表单 ↔ 后端子进程 stdin」通道流转：
 * 不进 LLM 上下文、日志、进程参数、环境变量（X34 秘密结构性路由）。
 */
export const WSOnboardingAddDatasourceSchema = Type.Object(
  {
    name: Type.String(),
    url: Type.String(),
    password: Type.Optional(Type.String()),
    connectArgs: Type.Optional(Type.Record(Type.String(), Type.String())),
    overwrite: Type.Optional(Type.Boolean()),
  },
  { version: PROTOCOL_VERSION },
);
export type WSOnboardingAddDatasource = Static<typeof WSOnboardingAddDatasourceSchema>;

/** test_datasource 载荷（探测不落盘；凭据只在内存 + stdin 管道） */
export const WSOnboardingTestDatasourceSchema = Type.Object(
  {
    url: Type.String(),
    password: Type.Optional(Type.String()),
    connectArgs: Type.Optional(Type.Record(Type.String(), Type.String())),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { version: PROTOCOL_VERSION },
);
export type WSOnboardingTestDatasource = Static<typeof WSOnboardingTestDatasourceSchema>;

/** onboarding_action 判别联合载荷（8 种动作，`action` 为判别字段；必填字段由 schema 拒绝） */
export const WSOnboardingActionPayloadSchema = Type.Union([
  Type.Object({ action: Type.Literal("status") }, { version: PROTOCOL_VERSION }),
  Type.Object(
    { action: Type.Literal("init_graph"), config: WSOnboardingGraphConfigSchema },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object(
    { action: Type.Literal("add_datasource"), datasource: WSOnboardingAddDatasourceSchema },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object(
    { action: Type.Literal("remove_datasource"), name: Type.String() },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object(
    { action: Type.Literal("test_datasource"), datasource: WSOnboardingTestDatasourceSchema },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object(
    {
      action: Type.Literal("test_model"),
      provider: Type.String(),
      modelId: Type.String(),
    },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object(
    {
      action: Type.Literal("import_metadata"),
      datasource: Type.String(),
      schemas: Type.String(),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("update"),
          Type.Literal("rebuild"),
          Type.Literal("clear"),
        ]),
      ),
    },
    { version: PROTOCOL_VERSION },
  ),
  Type.Object({ action: Type.Literal("env_check") }, { version: PROTOCOL_VERSION }),
]);
export type WSOnboardingActionPayload = Static<typeof WSOnboardingActionPayloadSchema>;

// ── 客户端 → 服务端 ─────────────────────────────────────────────────────────

/** 构造带版本元数据的消息 schema（`$id: govio-ws/v1/<type>` + `version` 字段）。
 * `type` 泛型保留字面量类型（判别联合收窄依赖它）；`props` 取 TObject 的 properties
 * 精确透传（经由结构型 `{ properties: P }`，避免依赖 typebox 内部导出名）。 */
function messageSchema<T extends string, P extends Record<string, TSchema>>(
  type: T,
  props: { properties: P },
  description: string,
) {
  return Type.Object(
    { type: Type.Literal(type), ...props.properties },
    {
      $id: `${PROTOCOL_ID_PREFIX}/${type}`,
      version: PROTOCOL_VERSION,
      description,
      additionalProperties: true,
    },
  );
}

/**
 * 客户端入站消息（21 种）。字段必需性与改造前 `WSMessage` 内联 interface 一致
 * （全部 Optional），schema 拒绝的是形状漂移（类型/字面量不符），不是缺字段——
 * 业务级必填（如 session_open.path）仍由 handler guard 保留原文案拦截。
 */
export const WSClientMessageSchema = Type.Union([
  messageSchema("prompt", Type.Object({
    content: Type.Optional(Type.String()),
    referencedNodes: Type.Optional(Type.Array(WSReferencedNodeSchema)),
    clientMsgId: Type.Optional(Type.String()),
  }), "发起提问；referencedNodes 序列化为 REF:[...] 前缀拼入 prompt"),
  messageSchema("steer", Type.Object({
    content: Type.Optional(Type.String()),
    referencedNodes: Type.Optional(Type.Array(WSReferencedNodeSchema)),
    clientMsgId: Type.Optional(Type.String()),
  }), "流式输出中注入指令（session.steer）；clientMsgId 供前端标记已投递"),
  messageSchema("followUp", Type.Object({
    content: Type.Optional(Type.String()),
    clientMsgId: Type.Optional(Type.String()),
  }), "排队后续指令（session.followUp）"),
  messageSchema("abort", Type.Object({}), "中止当前执行；清空队列并 denyPending"),
  messageSchema("observe_list", Type.Object({}), "请求 DataFrame 列表"),
  messageSchema("observe_info", Type.Object({}), "请求 observe info（数据源/DataFrame 摘要）"),
  messageSchema("clear", Type.Object({}), "重置会话（新会话）"),
  messageSchema("tool_permission_response", Type.Object({
    requestId: Type.Optional(Type.String()),
    decision: Type.Optional(WSPermissionDecisionSchema),
    editedCommand: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  }), "权限确认响应（allow/deny/edit）"),
  messageSchema("permission_accept_all", Type.Object({}), "同意当前请求并放行后续全部"),
  messageSchema("get_models_config", Type.Object({}), "拉取模型配置（API key 已脱敏）"),
  messageSchema("save_models_config", Type.Object({
    config: Type.Optional(WSModelsConfigSchema),
    apiKey: Type.Optional(Type.String()),
  }), "保存模型配置，或首次设置 API key（二选一）"),
  messageSchema("set_model", Type.Object({
    provider: Type.Optional(Type.String()),
    modelId: Type.Optional(Type.String()),
  }), "切换当前会话模型"),
  messageSchema("get_available_models", Type.Object({}), "拉取可用模型列表（ModelRuntime.getAvailable，仅含有效凭证的模型）"),
  messageSchema("set_thinking_level", Type.Object({
    level: Type.Optional(Type.String()),
  }), "设置思考深度（服务端 clamp 后以 thinking_level_set 回执）"),
  messageSchema("session_list", Type.Object({}), "拉取历史会话列表"),
  messageSchema("session_open", Type.Object({
    path: Type.Optional(Type.String()),
  }), "切换到指定会话文件（业务必填 path，缺省回 error 由 handler 拦截）"),
  messageSchema("session_messages", Type.Object({
    beforeEntryId: Type.Optional(Type.String()),
  }), "分页拉取展示记录；缺省最近 10 轮"),
  messageSchema("session_delete", Type.Object({
    path: Type.Optional(Type.String()),
  }), "删除会话（不允许删活动会话）"),
  messageSchema("canvas_save", Type.Object({
    nodes: Type.Optional(Type.Array(Type.Unknown())),
    edges: Type.Optional(Type.Array(Type.Unknown())),
  }), "画布快照写入会话 sidecar（前端 debounce 1s）"),
  messageSchema("canvas_fork_apply", Type.Object({
    forkId: Type.Optional(Type.String()),
  }), "T3.2 fork 续写：把分享 fork 暂存副本应用到当前会话（业务必填 forkId 由 handler guard 拦截）"),
  messageSchema("onboarding_action", Type.Object({
    requestId: Type.Optional(Type.String()),
    payload: WSOnboardingActionPayloadSchema,
  }), "X34 onboarding（P1b）：payload 判别联合驱动 status/init_graph/add_datasource/remove_datasource/test_datasource/test_model/import_metadata/env_check；凭据只在表单↔子进程 stdin 通道流转，不进 LLM/日志/argv/env"),
]);

export type WSClientMessage = Static<typeof WSClientMessageSchema>;

/** 按 type 字面量提取具体消息成员（供非 switch 上下文的参数收窄，如 makePrompt） */
export type WSClientMessageOf<T extends WSClientMessage["type"]> = Extract<WSClientMessage, { type: T }>;

// ── 服务端 → 客户端 ─────────────────────────────────────────────────────────

/**
 * 服务端出站消息（31 种）。仅作编译期契约与测试基准；服务端不对自身消息做运行时
 * 校验。开放载荷（args / nodes / edges / dataframes / info）刻意松绑，形状由消费端
 * 自校验（与改造前 useChat 的松散处理等价）。
 */
export const WSServerMessageSchema = Type.Union([
  messageSchema("session_ready", Type.Object({
    sessionId: Type.String(),
    thinkingLevel: Type.Optional(Type.String()),
    currentModel: Type.Optional(Type.Object(
      { provider: Type.String(), modelId: Type.String() },
      { additionalProperties: true, version: PROTOCOL_VERSION },
    )),
  }), "会话就绪（连接建立/切换后首发；附当前模型与思考档供前端对齐）"),
  messageSchema("canvas_restore", Type.Object({
    nodes: Type.Array(Type.Unknown()),
    edges: Type.Array(Type.Unknown()),
  }), "恢复会话绑定的画布快照（sidecar 存在时）"),
  messageSchema("session_messages_result", Type.Object({
    messages: Type.Array(WSTranscriptMessageSchema),
    hasMore: Type.Boolean(),
    oldestEntryId: Type.Union([Type.String(), Type.Null()]),
    replace: Type.Boolean(),
  }), "展示记录分页：replace=true 整屏替换，false 前插加载更早"),
  messageSchema("session_list_result", Type.Object({
    sessions: Type.Array(WSSessionListItemSchema),
  }), "历史会话列表（modified 倒序）"),
  messageSchema("session_deleted", Type.Object({
    path: Type.String(),
  }), "会话删除回执"),
  messageSchema("agent_start", Type.Object({}), "agent 开始一轮执行"),
  messageSchema("agent_end", Type.Object({}), "agent 一轮执行结束"),
  messageSchema("message_start", Type.Object({}), "assistant 消息开始"),
  messageSchema("message_end", Type.Object({}), "assistant 消息结束；随后 flush 节点队列"),
  messageSchema("text_delta", Type.Object({
    content: Type.String(),
  }), "正文增量"),
  messageSchema("thinking_delta", Type.Object({
    content: Type.String(),
  }), "思考增量"),
  messageSchema("tool_start", Type.Object({
    toolName: Type.String(),
    toolCallId: Type.Optional(Type.String()),
    args: Type.Optional(Type.Unknown()),
  }), "工具开始执行；args 原样 JSON 透传（开放载荷）"),
  messageSchema("tool_end", Type.Object({
    toolName: Type.String(),
    toolCallId: Type.Optional(Type.String()),
    success: Type.Boolean(),
  }), "工具执行结束；随后 flush 节点队列"),
  messageSchema("queue_update", Type.Object({
    pendingSteering: Type.Number(),
    pendingFollowUp: Type.Number(),
  }), "steer/followUp 队列变化（前端展示排队气泡）"),
  messageSchema("steer_queued", Type.Object({
    clientMsgId: Type.Optional(Type.String()),
    disposition: Type.String(),
    pendingSteering: Type.Number(),
    pendingFollowUp: Type.Number(),
  }), "steer 被队列接收回执"),
  messageSchema("followUp_queued", Type.Object({
    clientMsgId: Type.Optional(Type.String()),
    disposition: Type.String(),
    pendingSteering: Type.Number(),
    pendingFollowUp: Type.Number(),
  }), "followUp 被队列接收回执"),
  messageSchema("queue_cleared", Type.Object({
    clearedSteering: Type.Number(),
    clearedFollowUp: Type.Number(),
  }), "abort 清队列回执"),
  messageSchema("tool_permission_request", Type.Object({
    requestId: Type.String(),
    command: Type.String(),
  }), "需要审批的 bash 命令（超时 5 分钟自动 deny）"),
  messageSchema("observe_list_result", Type.Object({
    dataframes: Type.Unknown(),
  }), "DataFrame 列表（govio-cli observe list JSON 透传）"),
  messageSchema("observe_info_result", Type.Object({
    info: Type.Union([WSObserveInfoSchema, Type.Null()]),
  }), "observe info 结果（govio-cli JSON 透传，null 时前端按空对象处理）"),
  messageSchema("models_config", Type.Object({
    config: WSModelsConfigSchema,
  }), "模型配置（API key 已脱敏）"),
  messageSchema("available_models", Type.Object({
    models: Type.Array(Type.Object(
      {
        provider: Type.String(),
        modelId: Type.String(),
        name: Type.Optional(Type.String()),
        thinkingLevels: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: true, version: PROTOCOL_VERSION },
    )),
  }), "可用模型列表（chat 模型选择器数据源，来自 ModelRuntime.getAvailable）"),
  messageSchema("config_saved", Type.Object({}), "配置保存成功回执"),
  messageSchema("config_required", Type.Object({}), "首次启动无配置，需前端引导设置"),
  messageSchema("model_set", Type.Object({
    provider: Type.String(),
    modelId: Type.String(),
    thinkingLevel: Type.Optional(Type.String()),
  }), "模型切换成功回执（thinkingLevel 为切模型 clamp 后的当前值）"),
  messageSchema("thinking_level_set", Type.Object({
    level: Type.String(),
  }), "思考深度设置成功回执（clamp 后的生效值）"),
  messageSchema("fork_applied", Type.Object({
    forkId: Type.String(),
    /** 派生血缘（server/share.ts CanvasForkFrom 的线上形态；开放载荷容忍字段演进） */
    forkFrom: Type.Unknown(),
  }), "T3.2 fork 应用成功回执（canvas_restore 随后到达；只读分享视图不建立本连接）"),
  messageSchema("secret_redirect", Type.Object({
    message: Type.String(),
    categories: Type.Array(Type.String()),
    redactedSnippets: Type.Array(Type.String()),
  }), "X34 秘密结构性路由：prompt/steer 命中凭据守卫被拦截（未发给大模型）；message 为可读引导（改走数据源管理表单），categories 为命中类别，redactedSnippets 仅含脱敏片段（[REDACTED]）"),
  messageSchema("onboarding_progress", Type.Object({
    requestId: Type.Optional(Type.String()),
    action: Type.String(),
    message: Type.String(),
  }), "X34 onboarding（P1b）：长耗时动作（init_graph/import_metadata/env_check）进行中的进度消息（已脱敏）"),
  messageSchema("onboarding_result", Type.Object({
    requestId: Type.Optional(Type.String()),
    action: Type.String(),
    ok: Type.Boolean(),
    data: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
    errorKind: Type.Optional(Type.String()),
    hint: Type.Optional(Type.String()),
  }), "X34 onboarding（P1b）：动作结果回执；ok=false 时 error 为可读原因（已脱敏）、errorKind 分类（dns/host/port/auth/timeout/other 等）、hint 为修复指引；data 为开放载荷（形状随 action 而异）"),
  messageSchema("error", Type.Object({
    message: Type.String(),
  }), "错误（协议拒绝/业务失败统一出口）"),
]);

export type WSServerMessage = Static<typeof WSServerMessageSchema>;

// ── 注册表（测试与文档生成用） ──────────────────────────────────────────────

function registryOf(union: TSchema): Record<string, TSchema> {
  const out: Record<string, TSchema> = {};
  for (const member of (union as unknown as { anyOf: TSchema[] }).anyOf) {
    const type = (member as { properties: { type: { const: string } } }).properties.type.const;
    out[type] = member;
  }
  return out;
}

/** 版本化契约清单：version 字段 + 双向消息注册表（$id 均为 govio-ws/v1/<type>） */
export const WS_PROTOCOL = {
  version: PROTOCOL_VERSION,
  client: registryOf(WSClientMessageSchema),
  server: registryOf(WSServerMessageSchema),
} as const;

// ── 入站解析（服务端运行时把关） ────────────────────────────────────────────

export type ParsedClientMessage =
  | { ok: true; message: WSClientMessage }
  | { ok: false; error: string };

/**
 * 解析并校验客户端入站消息。拒绝路径（`ok:false`，error 为回给客户端的 error.message）：
 *  - 非法 JSON：`String(err)`——与改造前 JSON.parse 直抛时的回包文案逐字节一致；
 *  - 非对象 / 缺 type / 未知 type：`unknown message type: <type>`；
 *  - 形状非法（字段类型或字面量不符契约）：`invalid message: <type> ...`。
 *
 * 附加字段容忍（兼容策略 3）：多余字段不拒。缺字段不拒（兼容策略 4），
 * 业务级必填由 handler guard 拦截。
 */
export function parseWSClientMessage(raw: string): ParsedClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "unknown message type: (message is not an object)" };
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string") {
    return { ok: false, error: `unknown message type: ${String(type)}` };
  }
  const schema = WS_PROTOCOL.client[type];
  if (!schema) {
    return { ok: false, error: `unknown message type: ${type}` };
  }
  if (!Value.Check(schema, parsed)) {
    return { ok: false, error: `invalid message: ${type} payload does not match contract` };
  }
  return { ok: true, message: parsed as WSClientMessage };
}
