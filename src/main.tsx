import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import ShareView from './components/Share/ShareView';

// T3.2 只读分享链接：/share/<token> 渲染只读视图（静态页，不建 /ws 连接，
// 从根上杜绝分享打开态误连本地 agent；写回源画布在 API 层亦无路径）。
const shareMatch = /^\/share\/([a-f0-9]{32})\/?$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  shareMatch ? (
    <ShareView token={shareMatch[1]} />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  )
);
