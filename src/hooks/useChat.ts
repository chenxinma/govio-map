import { useState, useEffect, useCallback, useRef } from "react";
import type { Node, Edge } from "@xyflow/react";
import type { ReferencedNode } from "../types";
import type { ModelsConfig } from "../types/models-config";
import { useCanvasStore } from "../store/canvas-store";

export interface ToolCall {
  toolName: string;
  toolCallId?: string;
  success?: boolean;
}

export interface ModelOption {
  key: string;
  provider: string;
  modelId: string;
  label: string;
}

export interface DataFrameSummary {
  name: string;
  rows: number;
  columns: number;
  column_info?: Array<{ name: string; dtype: string }>;
}

export interface ObserveInfo {
  datasources?: string[];
  dataframes?: {
    dataframes?: DataFrameSummary[];
  };
}

const MODEL_STORAGE_KEY = "govio.selectedModel";

export function flattenModels(config: ModelsConfig): ModelOption[] {
  const out: ModelOption[] = [];
  for (const [provider, p] of Object.entries(config.providers)) {
    for (const m of p.models) {
      if (!m.id) continue;
      out.push({ key: `${provider}/${m.id}`, provider, modelId: m.id, label: `${provider} / ${m.name || m.id}` });
    }
  }
  return out;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  isStreaming?: boolean;
  referencedNodes?: ReferencedNode[];
  /** User message inserted while the agent was running (steering input). */
  isSteering?: boolean;
  /** Steering message still queued (not yet delivered to the model). */
  isQueued?: boolean;
}

export interface PendingPermission {
  requestId: string;
  command: string;
}

export interface SessionListItem {
  id: string;
  path: string;
  name: string | null;
  preview: string;
  messageCount: number;
  modified: string;
}

export type PermissionDecision = "allow" | "deny" | "edit";

interface WSEvent {
  type: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  success?: boolean;
  dataframes?: unknown[];
  requestId?: string;
  command?: string;
  config?: ModelsConfig;
  message?: string;
  provider?: string;
  modelId?: string;
  info?: ObserveInfo;
  sessions?: SessionListItem[];
  messages?: unknown[];
  hasMore?: boolean;
  oldestEntryId?: string | null;
  replace?: boolean;
  nodes?: unknown[];
  edges?: unknown[];
  path?: string;
  clientMsgId?: string;
  disposition?: string;
  pendingSteering?: number;
  pendingFollowUp?: number;
  clearedSteering?: number;
  clearedFollowUp?: number;
}

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg-${++msgIdCounter}`;
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
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const oldestEntryIdRef = useRef<string | null>(null);
  // Model key already sent to the backend (avoids duplicate set_model sends).
  const appliedModelKeyRef = useRef<string | null>(null);
  const observeInfoResolveRef = useRef<{ resolve: (info: ObserveInfo) => void; reject: (err: Error) => void } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const currentAssistantId = useRef<string | null>(null);
  // Whether the current bubble has received body text (text_delta) or tool
  // calls. Thinking-only bubbles (no body text or tools yet) are reusable so
  // consecutive thinking segments merge into one bubble instead of stacking up.
  const currentHasContent = useRef(false);
  const reusableThinkingId = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});

  const sendSetModel = useCallback((opt: ModelOption) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "set_model", provider: opt.provider, modelId: opt.modelId }));
  }, []);

  const sendCanvasSnapshot = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { nodes, edges } = useCanvasStore.getState();
    ws.send(JSON.stringify({ type: "canvas_save", nodes, edges }));
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

  // Remembered model wins; if it no longer exists in the config list, fall back to the first.
  const applyModelSelection = useCallback((config: ModelsConfig) => {
    const options = flattenModels(config);
    if (options.length === 0) {
      selectedModelRef.current = null;
      setSelectedModel(null);
      return;
    }
    const remembered = localStorage.getItem(MODEL_STORAGE_KEY);
    const desired = options.find((o) => o.key === remembered) || options[0];
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
        const data: WSEvent = JSON.parse(event.data);

        switch (data.type) {
          case "session_ready":
            setIsConnected(true);
            setNeedsConfig(false);
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
            if (selectedModelRef.current) {
              appliedModelKeyRef.current = selectedModelRef.current.key;
              sendSetModel(selectedModelRef.current);
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "get_models_config" }));
            }
            break;

          case "session_messages_result": {
            const incoming = (data.messages ?? []) as unknown as ChatMessage[];
            if (data.replace) {
              currentAssistantId.current = null;
              currentHasContent.current = false;
              reusableThinkingId.current = null;
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
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === toolStartId
                    ? { ...m, isStreaming: true, tools: [...(m.tools || []), { toolName, toolCallId: data.toolCallId, success: undefined }] }
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

          case "agent_end":
            isStreamingRef.current = false;
            setIsStreaming(false);
            finalizeRef.current();
            // Any steering message still shown as queued never got delivered
            // (the run ended first); surface it plainly so the user can resend.
            setMessages((prev) =>
              prev.map((m) => (m.isQueued ? { ...m, isQueued: undefined } : m))
            );
            break;

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
              applyModelSelection(data.config);
            }
            break;

          case "model_set":
            if (data.provider && data.modelId) {
              appliedModelKeyRef.current = `${data.provider}/${data.modelId}`;
            }
            break;

          case "observe_info_result":
            if (observeInfoResolveRef.current) {
              const { resolve } = observeInfoResolveRef.current;
              observeInfoResolveRef.current = null;
              resolve(data.info ?? {});
            }
            break;

          case "config_saved":
            setNeedsConfig(false);
            break;

          case "error":
            console.error("[chat] Server error:", data.message);
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

    const payload: Record<string, unknown> = { content, clientMsgId: msgId };
    if (referencedNodes && referencedNodes.length > 0) {
      payload.referencedNodes = referencedNodes;
    }

    if (isSteering) {
      // Steering: inject the message into the running agent. Mark the local
      // bubble as queued; it flips to delivered when the backend confirms the
      // queue accepted it (steer_queued) or an assistant turn resumes.
      ws.send(JSON.stringify({ type: "steer", ...payload }));
    } else {
      ws.send(JSON.stringify({ type: "prompt", ...payload }));
    }
  }, []);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "abort" }));
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
        ws.send(JSON.stringify({ type: "abort" }));
        isStreamingRef.current = false;
        setIsStreaming(false);
        finalizeCurrent();
      }
      ws.send(JSON.stringify({ type: "clear" }));
    }
    // 后端 clear → clearAll() 已拒绝所有挂起请求并留痕，这里只清本地队列（不再发 deny）
    clearPendingPermissions();
    clearMessages();
  }, [clearMessages, clearPendingPermissions, finalizeCurrent]);

  const loadMoreHistory = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !oldestEntryIdRef.current) return;
    setHistoryLoading(true);
    ws.send(JSON.stringify({ type: "session_messages", beforeEntryId: oldestEntryIdRef.current }));
  }, []);

  const fetchSessions = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "session_list" }));
  }, []);

  const openSession = useCallback((path: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (isStreamingRef.current) {
      ws.send(JSON.stringify({ type: "abort" }));
      isStreamingRef.current = false;
      setIsStreaming(false);
      finalizeCurrent();
    }
    // 后端 session_open → clearAll() 已拒绝所有挂起请求并留痕，这里只清本地队列
    clearPendingPermissions();
    clearMessages();
    ws.send(JSON.stringify({ type: "session_open", path }));
  }, [clearMessages, clearPendingPermissions, finalizeCurrent]);

  const deleteSession = useCallback((path: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "session_delete", path }));
  }, []);

  const respondPermission = useCallback((decision: PermissionDecision, editedCommand?: string) => {
    const ws = wsRef.current;
    const pending = pendingPermissionRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    const payload: Record<string, unknown> = {
      type: "tool_permission_response",
      requestId: pending.requestId,
      decision,
    };
    if (decision === "edit" && editedCommand) {
      payload.editedCommand = editedCommand;
    }
    ws.send(JSON.stringify(payload));
    showNextPendingPermission();
  }, [showNextPendingPermission]);

  const acceptAllPermission = useCallback(() => {
    const ws = wsRef.current;
    const pending = pendingPermissionRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pending) return;
    ws.send(JSON.stringify({
      type: "tool_permission_response",
      requestId: pending.requestId,
      decision: "allow",
    }));
    ws.send(JSON.stringify({ type: "permission_accept_all" }));
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
      ws.send(JSON.stringify({ type: "observe_list" }));

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
      ws.send(JSON.stringify({ type: "observe_info" }));
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
    ws.send(JSON.stringify({ type: "get_models_config" }));
  }, []);

  const saveModelsConfig = useCallback((config: ModelsConfig) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "save_models_config", config }));
  }, []);

  const saveApiKey = useCallback((apiKey: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "save_models_config", apiKey }));
  }, []);

  const modelOptions = modelsConfig ? flattenModels(modelsConfig) : [];

  return { messages, isConnected, isStreaming, send, abort, observeList, isObserving, clearMessages, clearSession, pendingPermission, respondPermission, acceptAllPermission, needsConfig, modelsConfig, getModelsConfig, saveModelsConfig, saveApiKey, modelOptions, selectedModel, selectModel, observeInfo, hasMoreHistory, historyLoading, loadMoreHistory, sessions, fetchSessions, openSession, deleteSession };
}
