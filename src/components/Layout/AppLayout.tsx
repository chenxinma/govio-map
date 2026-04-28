import { useState, useCallback } from 'react';
import Header from './Header';
import Canvas from '../Canvas/Canvas';
import ChatPanel from '../Chat/ChatPanel';
import ResizeDivider from './ResizeDivider';

export default function AppLayout() {
  const [chatWidth, setChatWidth] = useState(25);

  const handleResize = useCallback((deltaX: number) => {
    setChatWidth((prev) => {
      const deltaPercent = (deltaX / window.innerWidth) * 100;
      return Math.min(50, Math.max(15, prev - deltaPercent));
    });
  }, []);

  return (
    <div className="w-full h-screen flex flex-col bg-bg-canvas">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 min-w-0">
          <Canvas />
        </div>
        <ResizeDivider onResize={handleResize} />
        <div style={{ width: `${chatWidth}%` }} className="min-w-0 flex flex-col">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
