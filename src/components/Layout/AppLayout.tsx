import { useState, useCallback, useEffect } from "react";
import Header from "./Header";
import Canvas from "../Canvas/Canvas";
import ResizeDivider from "./ResizeDivider";
import ChatPanel from "../Chat/ChatPanel";
import OnboardingWizard from "../OnboardingWizard";
import { useChat } from "../../hooks/useChat";
import { ChatContext } from "../../hooks/useChatContext";

const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

export default function AppLayout() {
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  // X34：首启向导（首启检测 config_required 自动打开；顶栏「初始向导」可重复进入，幂等可续做）
  const [wizardOpen, setWizardOpen] = useState(false);
  const chat = useChat();

  useEffect(() => {
    if (chat.needsConfig) {
      // 微任务延后置位（react-hooks/set-state-in-effect：effect 内不做同步 setState）
      void Promise.resolve().then(() => setWizardOpen(true));
    }
  }, [chat.needsConfig]);

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((prev) => Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, prev + deltaX)));
  }, []);

  return (
    <ChatContext.Provider value={chat}>
      <div className="w-full h-screen flex flex-col bg-bg-canvas">
        <Header onOpenWizard={() => setWizardOpen(true)} />
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 min-w-[400px] overflow-hidden">
            <Canvas />
          </div>
          <ResizeDivider onResize={handleResize} />
          <ChatPanel width={chatWidth} />
        </div>
      </div>
      {wizardOpen && <OnboardingWizard onClose={() => setWizardOpen(false)} />}
    </ChatContext.Provider>
  );
}
