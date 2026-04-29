import { createContext, useContext } from "react";
import type { useChat } from "./useChat";

type ChatContextValue = ReturnType<typeof useChat>;

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used within ChatContext.Provider");
  return ctx;
}
