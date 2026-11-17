import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import ShareView from './components/Share/ShareView';

// T3.5 只读分享「活视图」：/share/<token> 渲染只读视图（静态页，不建 /ws 连接，
// 从根上杜绝分享打开态误连本地 agent；写回源画布在 API 层亦无路径）。
// token 由源会话指纹派生（32 位小写 hex，形状与 T3.2 快照时代一致，正则无需改）；
// 内容是源画布的**当前**状态（页内 3s 轮询），不是分享时点的快照。
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
