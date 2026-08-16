import { useState } from "react";
import { Hexagon, Settings } from "lucide-react";
import SettingsModal from "../SettingsModal";
import { useChatContext } from "../../hooks/useChatContext";

export default function Header() {
  const [showSettings, setShowSettings] = useState(false);
  const { getModelsConfig, saveModelsConfig, modelsConfig } = useChatContext();

  const openSettings = () => {
    getModelsConfig();
    setShowSettings(true);
  };

  const handleSave = (config: Parameters<typeof saveModelsConfig>[0]) => {
    saveModelsConfig(config);
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
      </div>
      <div className="flex items-center gap-3">
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
    </header>
  );
}
