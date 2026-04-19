import { Hexagon } from 'lucide-react';

export default function Header() {
  return (
    <header className="h-14 bg-bg-primary border-b border-border-default flex items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <Hexagon size={20} className="text-brand" fill="currentColor" />
        <span className="text-base font-medium text-text-primary tracking-tight">
          Govio Map
        </span>
        <span className="text-xs text-text-dim font-mono">/</span>
        <span className="text-sm text-text-muted">数据治理画布</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-brand/20 border border-brand-border flex items-center justify-center">
          <span className="text-xs text-brand font-medium">U</span>
        </div>
      </div>
    </header>
  );
}
