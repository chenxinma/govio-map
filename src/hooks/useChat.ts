import { useState, useEffect, useCallback, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { ReferencedNode } from "../types";
import type { ModelsConfig } from "../types/models-config";
import { createPendingAck } from "../utils/pending-ack";
import type {
  WSClientMessage,
  WSServerMessage,
  WSDataFrameSummary,
  WSObserveInfo,
  WSSessionListItem,
  WSPermissionDecision,
  WSOnboardingActionPayload,
} from "../types/ws-protocol";
import { useCanvasStore } from "../store/canvas-store";
import { foldTurnProcess, foldHistoryMessages } from "../utils/chat-fold";

export interface ToolCall {
  toolName: string;
  toolCallId?: string;
  success?: boolean;
  /** 工具入参（tool_start 转发的 args），供 ToolRow 展开查看具体命令 */
  args?: Record<string, unknown> | string;
}

export interface ModelOption {
  key: string;
  provider: string;
  modelId: string;
  label: string;
  /** 该模型支持的思考深度（含 off）；仅 ["off"] 表示不支持思考 */
  thinkingLevels: string[];
}

// 线上载荷形状的单一来源是 types/ws-protocol.ts（X2 契约）；
// 以下别名保持既有 UI 导入路径不变（DataSourcesModal / PermissionCard 等）。
export type DataFrameSummary = WSDataFrameSummary;
export type ObserveInfo = WSObserveInfo;
export type SessionListItem = WSSessionListItem;
export type PermissionDecision = WSPermissionDecision;

const MODEL_STORAGE_KEY = "govio.selectedModel";

export function toModelOption(m: { provider: string; modelId: string; name?: string; thinkingLevels?: string[] }): ModelOption {
  return {
    key: `${m.provider}/${m.modelId}`,
    provider: m.provider,
    modelId: m.modelId,
    label: `${m.provider} / ${m.name || m.modelId}`,
    thinkingLevels: m.thinkingLevels ?? [],
  };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  /**
   * 过程消息（一轮内所有 thinking/tool 的合并结果）：agent_end 后折入「已处理」组。
   * 历史加载时按同一规则标记，恢复后与运行态一致。
   */
  folded?: boolean;
  isStreaming?: boolean;
  referencedNodes?: ReferencedNode[];
  /** User message inserted while the agent was running (steering input). */
  isSteering?: boolean;
  /** Steering message still queued (not yet delivered to the model). */
  isQueued?: boolean;
  /** X34 秘密拦截回执卡片（含脱敏摘要 + 「打开数据源表单」引导） */
  secretRedirect?: SecretRedirectInfo;
}

export interface PendingPermission {
  requestId: string;
  command: string;
}

/** X34 secret_redirect 载荷（脱敏摘要 + 可读引导；被拦原文不进聊天态） */
export interface SecretRedirectInfo {
  message: string;
  categories: string[];
  redactedSnippets: string[];
}

/** X34 onboarding_action 回执（onboarding_result 的 {ok, data | error…} 载荷） */
export interface OnboardingOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  errorKind?: string;
  hint?: string;
}

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg-${++msgIdCounter}`;
}

/** /ws 出站消息统一出口：编译期对齐 WSClientMessage 契约（X2） */
/** T3.2 fork 续写：/?fork=<forkId> 是分享视图的接力参数，读取即消费（replaceState 防重复应用）。 */
function readPendingForkFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const forkId = params.get("fork");
    if (!forkId) return null;
    params.delete("fork");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    return /^[a-f0-9]{32}$/.test(forkId) ? forkId : null;
  } catch {
    return null;
  }
}

function sendClientMessage(ws: WebSocket, msg: WSClientMessage): void {
  ws.send(JSON.stringify(msg));
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  const [isObserving, setIsObserving] = useState(false);
  const isObservingRef = useRef(false);
  const observeListResolveRef = useRef<((dataframes: unknown[]) => void) | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  /** 当前展示中的确认请求（与 state 同步的镜像，供回调/清理路径读取，避免闭包旧值） */
  const pendingPermissionRef = useRef<PendingPermission | null>(null);
  /** 待确认请求队列（FIFO）：并发多个确认请求时逐个弹出，不互相覆盖/丢弃（BUGFIX-permission-gate P2） */
  const pendingPermissionQueueRef = useRef<PendingPermission[]>([]);

  /** 弹出队列中的下一个待确认请求（无则清空当前卡片） */
  const showNextPendingPermission = useCallback(() => {
    const next = pendingPermissionQueueRef.current.shift() ?? null;
    pendingPermissionRef.current = next;
    setPendingPermission(next);
  }, []);

  /** 清空本地待确认队列（后端 clearAll/denyPending 已拒绝并留痕，这里不重复发 deny） */
  const clearPendingPermissions = useCallback(() => {
    pendingPermissionQueueRef.current = [];
    pendingPermissionRef.current = null;
    setPendingPermission(null);
  }, []);
  const [needsConfig, setNeedsConfig] = useState(false);
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig | null>(null);
  const modelsConfigRef = useRef<ModelsConfig | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const selectedModelRef = useRef<ModelOption | null>(null);
  /** 可用模型列表（ModelRuntime.getAvailable，仅含有效凭证的模型）*/
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  /** 当前思考深度（服务端 clamp 后的生效值；null = 未知，等 session_ready/model_set 回执） */
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const oldestEntryIdRef = useRef<string | null>(null);
  // Model key already sent to the backend (avoids duplicate set_model sends).
  const appliedModelKeyRef = useRef<string | null>(null);
  // 会话当前模型（session_ready 的 currentModel）：无本地记忆时尊重它，不覆盖会话历史选择。
  const sessionModelKeyRef = useRef<string | null>(null);
  // set_model / set_thinking_level 回执闸门（防选完立刻发送的竞态）。
  const acksRef = useRef(createPendingAck());
  const observeInfoResolveRef = useRef<{ resolve: (info: ObserveInfo) => void; reject: (err: Error) => void } | null>(null);
  // X34：最近一次发出的用户气泡 id（secret_redirect 到达时把被拦原文替换为脱敏摘要）
  const lastSentUserMsgIdRef = useRef<string | null>(null);
  // X34：onboarding_action 请求-回执关联（requestId → resolver + 进度回调）
  const pendingOnboardingRef = useRef(
    new Map<string, { resolve: (o: OnboardingOutcome) => void; onProgress?: (m: string) => void }>()
  );
  const onboardSeqRef = useRef(0);
  // X34：get_models_config 请求-回执关联（向导合并保存前取既有配置）
  const modelsConfigFetchRef = useRef<{ resolve: (c: ModelsConfig) => void; reject: (err: Error) => void } | null>(null);
  // X34：save_models_config 完成闸门（config_saved + 会话重启 session_ready 双信号）
  const configSaveRef = useRef<{ resolve: () => void; reject: (err: Error) => void; gotSaved: boolean; gotReady: boolean } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const currentAssistantId = useRef<string | null>(null);
  // 本轮（agent_start 起）第一个 assistant 气泡 id：agent_end 时据此圈定本轮消息范围
  const turnFirstIdRef = useRef<string | null>(null);
  // Whether the current bubble has received body text (text_delta) or tool
  // calls. Thinking-only bubbles (no body text or tools yet) are reusable so
  // consecutive thinking segments merge into one bubble instead of stacking up.
  const currentHasContent = useRef(false);
  const reusableThinkingId = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const pendingForkRef = useRef<string | null>(readPendingForkFromUrl());

  const sendSetModel = useCallback((opt: ModelOption) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "set_model", provider: opt.provider, modelId: opt.modelId });
    void acksRef.current.track("model");
  }, []);

  const selectThinkingLevel = useCallback((level: string) => {
    const ws = wsRef.current;
    setThinkingLevel(level); // 乐观更新；thinking_level_set 回执会以 clamp 后的生效值校正
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "set_thinking_level", level });
    void acksRef.current.track("thinking");
  }, []);

  const sendCanvasSnapshot = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { nodes, edges } = useCanvasStore.getState();
    sendClientMessage(ws, { type: "canvas_save", nodes, edges });
  }, []);

  // Persist canvas snapshots alongside the session (debounced on any node/edge change).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useCanvasStore.subscribe((state, prev) => {
      if (state.nodes === prev.nodes && state.edges === prev.edges) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sendCanvasSnapshot, 1000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [sendCanvasSnapshot]);

  // Remembered model wins; if it no longer exists in the available list, fall back to the first.
  const applyModelSelection = useCallback((options: ModelOption[]) => {
    if (options.length === 0) {
      selectedModelRef.current = null;
      setSelectedModel(null);
      return;
    }
    const remembered = localStorage.getItem(MODEL_STORAGE_KEY);
    // 优先本地记忆；无记忆时尊重会话当前模型（不覆盖会话历史选择），最后才列表第一个
    const desired =
      options.find((o) => o.key === remembered) ||
      (sessionModelKeyRef.current ? options.find((o) => o.key === sessionModelKeyRef.current) : undefined) ||
      options[0];
    selectedModelRef.current = desired;
    setSelectedModel(desired);
    if (appliedModelKeyRef.current !== desired.key) {
      appliedModelKeyRef.current = desired.key;
      sendSetModel(desired);
    }
  }, [sendSetModel]);

  const finalizeCurrent = useCallback(() => {
    const id = currentAssistantId.current;
    if (id) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, isStreaming: false } : m
        )
      );
      currentAssistantId.current = null;
    }
    // Ending a turn (agent_start/agent_end) must not carry thinking over to a
    // new turn, so drop the reusable bubble and reset the content flag.
    currentHasContent.current = false;
    reusableThinkingId.current = null;
  }, []);
  const finalizeRef = useRef(finalizeCurrent);
  useEffect(() => {
    finalizeRef.current = finalizeCurrent;
  }, [finalizeCurrent]);

  const connect = useCallback(() => {
    if (disposedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = parseInt(window.location.port) + 1;
    const ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      console.log("[chat] Connected to /ws");
      setIsConnected(true);
      reconnectAttempts.current = 0;
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      console.log("[chat] Disconnected from /ws");
      setIsConnected(false);
      wsRef.current = null;
      if (disposedRef.current) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 10000);
      reconnectAttempts.current += 1;
      reconnectTimer.current = setTimeout(connectRef.current, delay);
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      console.warn("[chat] WebSocket error");
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
      try {
        const data: WSServerMessage = JSON.parse(event.data);

        switch (data.type) {
          case "session_ready": {
            setIsConnected(true);
            setNeedsConfig(false);
            {
              // X34：保存配置后的会话重启完成（新 ModelRuntime 就绪），放行 saveModelsConfig 等待方
              const save = configSaveRef.current;
              if (save) {
                save.gotReady = true;
                if (save.gotSaved) {
                  configSaveRef.current = null;
                  save.resolve();
                }
              }
            }
            if (data.thinkingLevel) setThinkingLevel(data.thinkingLevel);
            // 服务端事实基准：会话当前模型（SDK 从会话记录恢复）。
            // 与之相同就不发多余的 set_model（避免覆盖会话历史选择 / 重置思考档）。
            const serverModelKey = data.currentModel ? `${data.currentModel.provider}/${data.currentModel.modelId}` : null;
            sessionModelKeyRef.current = serverModelKey;
            if (serverModelKey) appliedModelKeyRef.current = serverModelKey;
            // Reset pagination; the server pushes the first transcript page
            // (session_messages_result replace=true) right after this event.
            oldestEntryIdRef.current = null;
            setHasMoreHistory(false);
            setHistoryLoading(false);
            // Bind the current canvas to the (possibly new) session once the
            // server's canvas_restore for this session has been applied.
            setTimeout(sendCanvasSnapshot, 1500);
            // Fresh session (connect / clear / config save): re-apply the current
            // model choice and refresh the model list in case the config changed.
            if (selectedModelRef.current && selectedModelRef.current.key !== serverModelKey) {
              appliedModelKeyRef.current = selectedModelRef.current.key;
              sendSetModel(selectedModelRef.current);
            }
            if (ws.readyState === WebSocket.OPEN) {
              sendClientMessage(ws, { type: "get_available_models" });
            }
            // T3.2 fork 续写：首帧会话就绪即应用分享 fork 暂存副本（服务端随后
            // canvas_restore 水合可写画布，血缘 forkFrom 已在服务端 sidecar 落定）。
            if (pendingForkRef.current && ws.readyState === WebSocket.OPEN) {
              const forkId = pendingForkRef.current;
              pendingForkRef.current = null;
              sendClientMessage(ws, { type: "canvas_fork_apply", forkId });
            }
            break;
          }

          case "session_messages_result": {
            // 历史消息按轮收拢 thinking/tool 折入「已处理」组，恢复后与运行态一致
            const incoming = foldHistoryMessages((data.messages ?? []) as unknown as ChatMessage[]);
            if (data.replace) {
              currentAssistantId.current = null;
              currentHasContent.current = false;
              reusableThinkingId.current = null;
              turnFirstIdRef.current = null;
              setMessages(incoming);
            } else {
              setHistoryLoading(false);
              setMessages((prev) => [...incoming, ...prev]);
            }
            oldestEntryIdRef.current = data.oldestEntryId ?? null;
            setHasMoreHistory(!!data.hasMore);
            break;
          }

          case "canvas_restore":
            useCanvasStore.getState().hydrateSession(
              (data.nodes ?? []) as Node[],
              (data.edges ?? []) as Edge[],
            );
            break;

          case "session_list_result":
            setSessions(data.sessions ?? []);
            break;

          case "session_deleted":
            if (data.path) {
              setSessions((prev) => prev.filter((s) => s.path !== data.path));
            }
            break;

          case "agent_start":
            isStreamingRef.current = true;
            setIsStreaming(true);
            finalizeRef.current();
            turnFirstIdRef.current = null;
            break;

          case "message_start": {
            const reusable = reusableThinkingId.current;
            if (reusable) {
              // The previous message was thinking-only (no body text): keep
              // accumulating in the same bubble rather than opening a new one.
              currentAssistantId.current = reusable;
              currentHasContent.current = false;
              reusableThinkingId.current = null;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === reusable ? { ...m, isStreaming: true } : m
                )
              );
            } else {
              finalizeRef.current();
              const assistantId = nextMsgId();
              currentAssistantId.current = assistantId;
              currentHasContent.current = false;
              if (turnFirstIdRef.current === null) turnFirstIdRef.current = assistantId;
              setMessages((prev) => [
                ...prev,
                {
                  id: assistantId,
                  role: "assistant",
                  content: "",
                  tools: [],
                  isStreaming: true,
                },
              ]);
            }
            break;
          }

          case "thinking_delta": {
            const thinkId = currentAssistantId.current;
            const chunk = data.content;
            if (chunk && thinkId) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === thinkId
                    ? { ...m, thinking: (m.thinking || "") + chunk }
                    : m
                )
              );
            }
            break;
          }

          case "text_delta": {
            const textId = currentAssistantId.current;
            const chunk = data.content;
            if (chunk && textId) {
              currentHasContent.current = true;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === textId
                    ? { ...m, content: m.content + chunk }
                    : m
                )
              );
            }
            break;
          }

          case "tool_start": {
            const toolStartId = currentAssistantId.current;
            if (toolStartId) {
              currentHasContent.current = true;
              // Tool events arrive after message_end; the bubble is no longer thinking-only.
              reusableThinkingId.current = null;
              const toolName = data.toolName || "unknown";
              const tool: ToolCall = { toolName, toolCallId: data.toolCallId, success: undefined };
              if (data.args !== undefined) tool.args = data.args as ToolCall["args"];
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === toolStartId
                    ? { ...m, isStreaming: true, tools: [...(m.tools || []), tool] }
                    : m
                )
              );
            }
            break;
          }

          case "tool_end": {
            const toolEndId = currentAssistantId.current;
            if (toolEndId) {
              const success = data.success ?? false;
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== toolEndId) return m;
                  const tools = [...(m.tools || [])];
                  // Match by toolCallId: parallel tool calls end out of order,
                  // so "last pill" is wrong whenever more than one runs at once.
                  const idx = tools.findIndex(
                    (t) => t.toolCallId === data.toolCallId && t.success === undefined
                  );
                  if (idx >= 0) {
                    tools[idx] = { ...tools[idx], success };
                  }
                  return { ...m, tools };
                })
              );
            }
            break;
          }

          case "message_end": {
            const id = currentAssistantId.current;
            if (id) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === id ? { ...m, isStreaming: false } : m
                )
              );
              // A thinking-only bubble (no body text or tool calls) stays reusable
              // so the next message_start merges into it. Once body text or tools were
              // emitted the bubble is complete and the next message opens a fresh one.
              // NOTE: keep currentAssistantId set — tool_execution_start/end arrive
              // AFTER message_end and must still attach to this bubble.
              reusableThinkingId.current = currentHasContent.current ? null : id;
              currentHasContent.current = false;
            }
            break;
          }

          case "agent_end": {
            isStreamingRef.current = false;
            setIsStreaming(false);
            finalizeRef.current();
            // 一轮完成：
            // 1) 本轮所有 assistant 消息的 thinking/tool（含带正文消息附着的）合并为
            //    一条折叠过程消息折入「已处理」组，正文消息只保留正文；
            // 2) 未送达的排队 steering 显性化（run 先结束了），便于用户重发。
            const turnFirst = turnFirstIdRef.current;
            turnFirstIdRef.current = null;
            setMessages((prev) => {
              const cleaned = prev.map((m) => (m.isQueued ? { ...m, isQueued: undefined } : m));
              const startIdx = turnFirst ? cleaned.findIndex((m) => m.id === turnFirst) : -1;
              if (startIdx < 0) return cleaned;
              return [...cleaned.slice(0, startIdx), ...foldTurnProcess(cleaned.slice(startIdx))];
            });
            break;
          }

          case "steer_queued":
          case "followUp_queued": {
            // The queue accepted the message: it will reach the model on the
            // next turn boundary. Drop the local "queued" marker.
            const { clientMsgId } = data;
            if (clientMsgId) {
              setMessages((prev) =>
                prev.map((m) => (m.id === clientMsgId ? { ...m, isQueued: undefined } : m))
              );
            }
            break;
          }

          case "queue_cleared":
            // Abort cleared the pending steering/follow-up queue.
            setMessages((prev) =>
              prev.map((m) => (m.isQueued ? { ...m, isQueued: undefined } : m))
            );
            break;

          case "observe_list_result":
            isObservingRef.current = false;
            setIsObserving(false);
            if (observeListResolveRef.current) {
              const raw = data.dataframes as unknown[] | { dataframes: unknown[] } | undefined;
              const list = Array.isArray(raw)
                ? raw
                : Array.isArray(raw?.dataframes)
                  ? raw.dataframes
                  : [];
              observeListResolveRef.current(list);
              observeListResolveRef.current = null;
            }
            break;

          case "tool_permission_request":
            if (data.requestId && data.command) {
              const req: PendingPermission = { requestId: data.requestId, command: data.command };
              if (pendingPermissionRef.current) {
                // 已有卡片在等决策：入队，当前卡片处理完后自动弹出下一个
                pendingPermissionQueueRef.current.push(req);
              } else {
                pendingPermissionRef.current = req;
                setPendingPermission(req);
              }
            }
            break;

          case "config_required":
            setNeedsConfig(true);
            break;

          case "models_config":
            if (data.config) {
              modelsConfigRef.current = data.config;
              setModelsConfig(data.config);
              if (modelsConfigFetchRef.current) {
                const { resolve } = modelsConfigFetchRef.current;
                modelsConfigFetchRef.current = null;
                resolve(data.config);
              }
            }
            break;

          case "available_models": {
            const options = (data.models ?? []).map(toModelOption);
            setModelOptions(options);
            applyModelSelection(options);
            break;
          }

          case "model_set":
            if (data.provider && data.modelId) {
              appliedModelKeyRef.current = `${data.provider}/${data.modelId}`;
            }
            if (data.thinkingLevel) setThinkingLevel(data.thinkingLevel);
            acksRef.current.resolve("model");
            break;

          case "thinking_level_set":
            if (data.level) setThinkingLevel(data.level);
            acksRef.current.resolve("thinking");
            break;

          case "observe_info_result":
            if (observeInfoResolveRef.current) {
              const { resolve } = observeInfoResolveRef.current;
              observeInfoResolveRef.current = null;
              resolve(data.info ?? {});
            }
            break;

          case "config_saved": {
            setNeedsConfig(false);
            // X34：落盘成功；待会话重启（session_ready）后一并放行，避免向导
            // 立刻发 test_model 时撞上旧 handler（无 ModelRuntime）的竞态
            const save = configSaveRef.current;
            if (save) {
              save.gotSaved = true;
              if (save.gotReady) {
                configSaveRef.current = null;
                save.resolve();
              }
            }
            break;
          }

          case "secret_redirect": {
            // X34 秘密结构性路由收尾：被拦原文不得留在聊天态（只留脱敏摘要）。
            // redactedSnippets 仅含 [REDACTED] 片段，可安全展示；顺带清掉 steer/followUp
            // 气泡的待投递标记（被拦消息不会再有 steer_queued 回执）。
            const info: SecretRedirectInfo = {
              message: data.message,
              categories: data.categories ?? [],
              redactedSnippets: data.redactedSnippets ?? [],
            };
            setMessages((prev) => {
              const next = [...prev];
              const targetId = lastSentUserMsgIdRef.current;
              const idx = targetId ? next.findIndex((m) => m.id === targetId) : -1;
              if (idx >= 0) {
                const snippetText = info.redactedSnippets.join("\n");
                next[idx] = {
                  ...next[idx],
                  content: snippetText
                    ? `（此消息包含凭据，已被拦截，未发送给大模型）\n${snippetText}`
                    : "（此消息包含凭据，已被拦截，未发送给大模型）",
                  isSteering: undefined,
                  isQueued: undefined,
                };
              }
              next.push({ id: nextMsgId(), role: "assistant", content: info.message, secretRedirect: info });
              return next;
            });
            break;
          }

          case "onboarding_progress": {
            const pending = data.requestId ? pendingOnboardingRef.current.get(data.requestId) : undefined;
            pending?.onProgress?.(data.message);
            break;
          }

          case "onboarding_result": {
            const requestId = data.requestId;
            const pending = requestId ? pendingOnboardingRef.current.get(requestId) : undefined;
            if (requestId && pending) {
              pendingOnboardingRef.current.delete(requestId);
              pending.resolve({
                ok: data.ok,
                data: data.data,
                error: data.error,
                errorKind: data.errorKind,
                hint: data.hint,
              });
            }
            break;
          }

          case "error":
            console.error("[chat] Server error:", data.message);
            if (configSaveRef.current) {
              const { reject } = configSaveRef.current;
              configSaveRef.current = null;
              reject(new Error(data.message || "save models config failed"));
            }
            if (modelsConfigFetchRef.current) {
              const { reject } = modelsConfigFetchRef.current;
              modelsConfigFetchRef.current = null;
              reject(new Error(data.message || "get models config failed"));
            }
            if (isObservingRef.current) {
              isObservingRef.current = false;
              setIsObserving(false);
              observeListResolveRef.current = null;
            }
            if (observeInfoResolveRef.current) {
              const { reject } = observeInfoResolveRef.current;
              observeInfoResolveRef.current = null;
              reject(new Error(data.message || "observe info failed"));
            }
            break;
        }
      } catch (err) {
        console.error("[chat] Parse error:", err);
      }
    };

    wsRef.current = ws;
  }, [sendSetModel, sendCanvasSnapshot, applyModelSelection]);

  useEffect(() => {
    connectRef.current = connect;
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((content: string, referencedNodes?: ReferencedNode[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const msgId = nextMsgId();
    lastSentUserMsgIdRef.current = msgId;
    const isSteering = isStreamingRef.current;
    const userMsg: ChatMessage = {
      id: msgId,
      role: "user",
      content,
      referencedNodes: referencedNodes && referencedNodes.length > 0 ? referencedNodes : undefined,
      isSteering: isSteering || undefined,
      isQueued: isSteering || undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

    const refs = referencedNodes && referencedNodes.length > 0 ? referencedNodes : undefined;

    if (isSteering) {
      // Steering: inject the message into the running agent. Mark the local
      // bubble as queued; it flips to delivered when the backend confirms the
      // queue accepted it (steer_queued) or an assistant turn resumes.
      sendClientMessage(ws, { type: "steer", content, clientMsgId: msgId, referencedNodes: refs });
    } else {
      // 等 set_model / set_thinking_level 回执落地再发 prompt，防止用上旧模型/旧档位；
      // 回执缺失时 pending-ack 兜底放行（3s），不卡输入。
      void acksRef.current.pending().then(() => {
        if (ws.readyState === WebSocket.OPEN) {
          sendClientMessage(ws, { type: "prompt", content, clientMsgId: msgId, referencedNodes: refs });
        }
      });
    }
  }, []);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "abort" });
    isStreamingRef.current = false;
    setIsStreaming(false);
    // 后端 abort → denyPending() 已拒绝所有挂起请求并留痕，这里只清本地队列（不重复发 deny）
    clearPendingPermissions();
    finalizeCurrent();
  }, [clearPendingPermissions, finalizeCurrent]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    msgIdCounter = 0;
    currentAssistantId.current = null;
    currentHasContent.current = false;
    reusableThinkingId.current = null;
  }, []);

  const clearSession = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (isStreamingRef.current) {
        sendClientMessage(ws, { type: "abort" });
        isStreamingRef.current = false;
        setIsStreaming(false);
        finalizeCurrent();
      }
      sendClientMessage(ws, { type: "clear" });
    }
    // 后端 clear → clearAll() 已拒绝所有挂起请求并留痕，这里只清本地队列（不再发 deny）
    clearPendingPermissions();
    clearMessages();
  }, [clearMessages, clearPendingPermissions, finalizeCurrent]);

  const loadMoreHistory = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !oldestEntryIdRef.current) return;
    setHistoryLoading(true);
    sendClientMessage(ws, { type: "session_messages", beforeEntryId: oldestEntryIdRef.current });
  }, []);

  const fetchSessions = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "session_list" });
  }, []);

  const openSession = useCallback((path: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (isStreamingRef.current) {
      sendClientMessage(ws, { type: "abort" });
      isStreamingRef.current = false;
      setIsStreaming(false);
      finalizeCurrent();
    }
    // 后端 session_open → clearAll() 已拒绝所有挂起请求并留痕，这里只清本地队列
    clearPendingPermissions();
    clearMessages();
    sendClientMessage(ws, { type: "session_open", path });
  }, [clearMessages, clearPendingPermissions, finalizeCurrent]);

  const deleteSession = useCallback((path: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "session_delete", path });
  }, []);

  const respondPermission = useCallback((decision: PermissionDecision, editedCommand?: string) => {
    const ws = wsRef.current;
    const pending = pendingPermissionRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    sendClientMessage(ws, decision === "edit" && editedCommand
      ? { type: "tool_permission_response", requestId: pending.requestId, decision, editedCommand }
      : { type: "tool_permission_response", requestId: pending.requestId, decision });
    showNextPendingPermission();
  }, [showNextPendingPermission]);

  const acceptAllPermission = useCallback(() => {
    const ws = wsRef.current;
    const pending = pendingPermissionRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    sendClientMessage(ws, {
      type: "tool_permission_response",
      requestId: pending.requestId,
      decision: "allow",
    });
    sendClientMessage(ws, { type: "permission_accept_all" });
    // Accept All 关闭了后续逐条确认（含已入队的）：放行当前后清空队列，
    // 剩余挂起请求由后端 requestPermission 在放行模式下自动允许，不需逐个弹卡。
    pendingPermissionQueueRef.current = [];
    showNextPendingPermission();
  }, [showNextPendingPermission]);

  const observeList = useCallback((): Promise<unknown[]> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      isObservingRef.current = true;
      setIsObserving(true);
      observeListResolveRef.current = resolve;
      sendClientMessage(ws, { type: "observe_list" });

      setTimeout(() => {
        if (isObservingRef.current) {
          isObservingRef.current = false;
          setIsObserving(false);
          observeListResolveRef.current = null;
          reject(new Error("observe_list timeout"));
        }
      }, 15000);
    });
  }, []);

  const observeInfo = useCallback((): Promise<ObserveInfo> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      observeInfoResolveRef.current = { resolve, reject };
      sendClientMessage(ws, { type: "observe_info" });
      setTimeout(() => {
        if (observeInfoResolveRef.current) {
          const { reject: timeoutReject } = observeInfoResolveRef.current;
          observeInfoResolveRef.current = null;
          timeoutReject(new Error("observe info timeout"));
        }
      }, 15000);
    });
  }, []);

  const selectModel = useCallback((opt: ModelOption) => {
    selectedModelRef.current = opt;
    setSelectedModel(opt);
    localStorage.setItem(MODEL_STORAGE_KEY, opt.key);
    appliedModelKeyRef.current = opt.key;
    sendSetModel(opt);
  }, [sendSetModel]);

  const getModelsConfig = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendClientMessage(ws, { type: "get_models_config" });
  }, []);

  /** X34：拉取模型配置（脱敏）并以 Promise 回传——向导合并保存前取既有 provider 用 */
  const fetchModelsConfig = useCallback((): Promise<ModelsConfig> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      modelsConfigFetchRef.current = { resolve, reject };
      sendClientMessage(ws, { type: "get_models_config" });
      setTimeout(() => {
        if (modelsConfigFetchRef.current) {
          const { reject: timeoutReject } = modelsConfigFetchRef.current;
          modelsConfigFetchRef.current = null;
          timeoutReject(new Error("get_models_config timeout"));
        }
      }, 15000);
    });
  }, []);

  /**
   * X34：保存模型配置并在「落盘 + 会话重启完成」后 resolve（向导保存并测试依赖此闸门，
   * 防止 test_model 抢在新 ModelRuntime 就绪前到达旧 handler）。失败 reject；
   * 60s 兜底放行（重启异常时不卡住向导 UI，后续 test_model 自有可读错误）。
   */
  const saveModelsConfig = useCallback((config: ModelsConfig): Promise<void> => {
    return new Promise((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      configSaveRef.current = { resolve, reject, gotSaved: false, gotReady: false };
      sendClientMessage(ws, { type: "save_models_config", config });
      setTimeout(() => {
        const pending = configSaveRef.current;
        if (pending) {
          configSaveRef.current = null;
          pending.resolve();
        }
      }, 60000);
    });
  }, []);

  /** X34 onboarding：发起 onboarding_action 并等待 onboarding_result（长耗时动作带进度回调） */
  const onboardingAction = useCallback(
    (payload: WSOnboardingActionPayload, onProgress?: (message: string) => void): Promise<OnboardingOutcome> => {
      return new Promise((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: "WebSocket 未连接", errorKind: "disconnected", hint: "请检查后端是否已启动，然后重试" });
          return;
        }
        onboardSeqRef.current += 1;
        const requestId = `ob-${onboardSeqRef.current}`;
        pendingOnboardingRef.current.set(requestId, { resolve, onProgress });
        sendClientMessage(ws, { type: "onboarding_action", requestId, payload });
      });
    },
    []
  );

  return { messages, isConnected, isStreaming, send, abort, observeList, isObserving, clearMessages, clearSession, pendingPermission, respondPermission, acceptAllPermission, needsConfig, modelsConfig, getModelsConfig, fetchModelsConfig, saveModelsConfig, onboardingAction, modelOptions, selectedModel, selectModel, thinkingLevel, selectThinkingLevel, observeInfo, hasMoreHistory, historyLoading, loadMoreHistory, sessions, fetchSessions, openSession, deleteSession };
}
