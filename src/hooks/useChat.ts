import { useState, useEffect, useCallback, useRef } from "react";

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
}

interface WSEvent {
  type: string;
  content?: string;
  toolName?: string;
  success?: boolean;
}

let msgIdCounter = 0;
function nextMsgId(): string {
  return `msg-${++msgIdCounter}`;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const currentAssistantId = useRef<string | null>(null);
  const disposedRef = useRef(false);

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
      reconnectTimer.current = setTimeout(connect, delay);
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

          case "message_start":
            setIsStreaming(true);
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current ? { ...m, isStreaming: false } : m
                )
              );
            }
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

          case "thinking_delta":
            if (data.content && currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, thinking: (m.thinking || "") + data.content }
                    : m
                )
              );
            }
            break;

          case "text_delta":
            if (data.content && currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, content: m.content + data.content }
                    : m
                )
              );
            }
            break;

          case "tool_start":
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, tools: [...(m.tools || []), { toolName: data.toolName || "unknown", success: undefined }] }
                    : m
                )
              );
            }
            break;

          case "tool_end":
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== currentAssistantId.current) return m;
                  const tools = [...(m.tools || [])];
                  const lastTool = tools.length - 1;
                  if (lastTool >= 0) {
                    tools[lastTool] = { ...tools[lastTool], success: data.success ?? false };
                  }
                  return { ...m, tools };
                })
              );
            }
            break;

          case "message_end":
            setIsStreaming(false);
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, isStreaming: false }
                    : m
                )
              );
              currentAssistantId.current = null;
            }
            break;

          case "agent_end":
            setIsStreaming(false);
            if (currentAssistantId.current) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentAssistantId.current
                    ? { ...m, isStreaming: false }
                    : m
                )
              );
              currentAssistantId.current = null;
            }
            break;

          case "error":
            console.error("[chat] Server error:", data.content);
            break;
        }
      } catch (err) {
        console.error("[chat] Parse error:", err);
      }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((content: string, referencedNodes?: Array<{ nodeId: string; label: string; type: string }>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: nextMsgId(),
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMsg]);

    const payload: Record<string, unknown> = { content };
    if (referencedNodes && referencedNodes.length > 0) {
      payload.referencedNodes = referencedNodes;
    }

    if (isStreaming) {
      ws.send(JSON.stringify({ type: "steer", ...payload }));
    } else {
      ws.send(JSON.stringify({ type: "prompt", ...payload }));
    }
  }, [isStreaming]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "abort" }));
    setIsStreaming(false);
    if (currentAssistantId.current) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === currentAssistantId.current
            ? { ...m, isStreaming: false }
            : m
        )
      );
      currentAssistantId.current = null;
    }
  }, []);

  return { messages, isConnected, isStreaming, send, abort };
}
