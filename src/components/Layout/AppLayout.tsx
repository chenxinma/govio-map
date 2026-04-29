import { useState, useCallback } from "react";
import Header from "./Header";
import Canvas from "../Canvas/Canvas";
import ResizeDivider from "./ResizeDivider";
import ChatPanel from "../Chat/ChatPanel";
import { useChat } from "../../hooks/useChat";
import { ChatContext } from "../../hooks/useChatContext";

const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

export default function AppLayout() {
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const chat = useChat();

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((prev) => Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, prev + deltaX)));
  }, []);

  return (
    <ChatContext.Provider value={chat}>
      <div className="w-full h-screen flex flex-col bg-bg-canvas">
        <Header />
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 min-w-[400px] overflow-hidden">
            <Canvas />
          </div>
          <ResizeDivider onResize={handleResize} />
          <ChatPanel width={chatWidth} />
        </div>
      </div>
    </ChatContext.Provider>
  );
}
