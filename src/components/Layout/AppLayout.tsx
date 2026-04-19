import Header from './Header';
import Sidebar from '../Sidebar/Sidebar';
import Canvas from '../Canvas/Canvas';
import ChatPanel from '../Chat/ChatPanel';

export default function AppLayout() {
  return (
    <div className="w-full h-screen flex flex-col bg-bg-canvas">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          <div className="flex-1 min-h-0">
            <Canvas />
          </div>
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
