import { useState, useEffect, useCallback, useRef } from "react";
import type { ReferencedNode } from "../types";

export interface ToolCall {
  toolName: string;
  success?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools?: ToolCall[];
  isStreaming?: boolean;
  referencedNodes?: ReferencedNode[];
}

interface WSEvent {
  type: string;
  content?: string;
  toolName?: string;
  success?: boolean;
  dataframes?: unknown[];
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const currentAssistantId = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (disposedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = parseInt(window.location.port) + 1;
    const ws = new WebSocket(`${protocol}//${window.location.hostname}:${wsPort}/ws`);

    const finalizeCurrent = () => {
      const id = currentAssistantId.current;
      if (!id) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, isStreaming: false } : m
        )
      );
      currentAssistantId.current = null;
    };

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
            break;

          case "agent_start":
            isStreamingRef.current = true;
            setIsStreaming(true);
            finalizeCurrent();
            break;

          case "message_start": {
            finalizeCurrent();
            const assistantId = nextMsgId();
            currentAssistantId.current = assistantId;
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
              const toolName = data.toolName || "unknown";
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === toolStartId
                    ? { ...m, tools: [...(m.tools || []), { toolName, success: undefined }] }
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
                  const lastTool = tools.length - 1;
                  if (lastTool >= 0) {
                    tools[lastTool] = { ...tools[lastTool], success };
                  }
                  return { ...m, tools };
                })
              );
            }
            break;
          }

          case "message_end":
            finalizeCurrent();
            break;

          case "agent_end":
            isStreamingRef.current = false;
            setIsStreaming(false);
            finalizeCurrent();
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

          case "error":
            console.error("[chat] Server error:", data.content);
            if (isObservingRef.current) {
              isObservingRef.current = false;
              setIsObserving(false);
              observeListResolveRef.current = null;
            }
            break;
        }
      } catch (err) {
        console.error("[chat] Parse error:", err);
      }
    };

    wsRef.current = ws;
  }, []);

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

  const finalizeCurrent = useCallback(() => {
    const id = currentAssistantId.current;
    if (!id) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, isStreaming: false } : m
      )
    );
    currentAssistantId.current = null;
  }, []);

  const send = useCallback((content: string, referencedNodes?: ReferencedNode[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: "user",
      content,
      referencedNodes: referencedNodes && referencedNodes.length > 0 ? referencedNodes : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

    const payload: Record<string, unknown> = { content };
    if (referencedNodes && referencedNodes.length > 0) {
      payload.referencedNodes = referencedNodes;
    }

    if (isStreamingRef.current) {
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
    finalizeCurrent();
  }, [finalizeCurrent]);

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

  return { messages, isConnected, isStreaming, send, abort, observeList, isObserving };
}
