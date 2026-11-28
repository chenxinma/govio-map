import { useEffect, useState } from "react";
import { Hexagon, Settings, Database, Compass } from "lucide-react";
import SettingsModal from "../SettingsModal";
import DataSourcesModal from "../DataSourcesModal";
import { useChatContext } from "../../hooks/useChatContext";

interface HeaderProps {
  /** 打开 X34 初始向导（首启检测与顶栏「初始向导」共用同一入口） */
  onOpenWizard: () => void;
}

export default function Header({ onOpenWizard }: HeaderProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [showDataSources, setShowDataSources] = useState(false);
  const { getModelsConfig, saveModelsConfig, modelsConfig } = useChatContext();

  // X34 secret_redirect 卡片「打开数据源表单」：聊天内按钮 → 数据源管理器
  useEffect(() => {
    const onOpen = () => setShowDataSources(true);
    window.addEventListener("govio:open-datasources", onOpen);
    return () => window.removeEventListener("govio:open-datasources", onOpen);
  }, []);

  const openSettings = () => {
    getModelsConfig();
    setShowSettings(true);
  };

  const handleSave = (config: Parameters<typeof saveModelsConfig>[0]) => {
    void saveModelsConfig(config).catch((err) => console.error("[settings] save models config failed:", err));
    setShowSettings(false);
  };

  return (
    <header className="h-14 bg-bg-primary border-b border-border-default flex items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <Hexagon size={20} className="text-brand" fill="currentColor" />
        <span className="text-base font-medium text-text-primary tracking-tight">
          Govio Map
        </span>
        <span className="text-xs text-text-dim font-mono">/</span>
        <span className="text-sm text-text-muted">数据治理画布</span>
        <span className="text-xs text-text-dim font-mono">v{__APP_VERSION__}</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenWizard}
          className="w-7 h-7 rounded-full bg-bg-surface border border-border-default flex items-center justify-center text-text-muted hover:text-text-primary hover:border-brand/40 transition-colors"
          title="初始向导"
        >
          <Compass size={14} />
        </button>
        <button
          onClick={() => setShowDataSources(true)}
          className="w-7 h-7 rounded-full bg-bg-surface border border-border-default flex items-center justify-center text-text-muted hover:text-text-primary hover:border-brand/40 transition-colors"
          title="数据源"
        >
          <Database size={14} />
        </button>
        <button
          onClick={openSettings}
          className="w-7 h-7 rounded-full bg-bg-surface border border-border-default flex items-center justify-center text-text-muted hover:text-text-primary hover:border-brand/40 transition-colors"
          title="设置"
        >
          <Settings size={14} />
        </button>
        <div className="w-7 h-7 rounded-full bg-brand/20 border border-brand-border flex items-center justify-center">
          <span className="text-xs text-brand font-medium">U</span>
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          key={modelsConfig ? "loaded" : "loading"}
          initialConfig={modelsConfig}
          onSave={handleSave}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showDataSources && <DataSourcesModal onClose={() => setShowDataSources(false)} />}    </header>
  );
}
