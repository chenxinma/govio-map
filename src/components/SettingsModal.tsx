import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Settings, Plus, Trash2 } from "lucide-react";
import type { ModelsConfig, ProviderConfig, ProviderModel } from "../types/models-config";

interface SettingsModalProps {
  initialConfig: ModelsConfig | null;
  onSave: (config: ModelsConfig) => void;
  onClose: () => void;
}

const EMPTY_PROVIDER: ProviderConfig = {
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  models: [{ id: "" }],
};

export default function SettingsModal({ initialConfig, onSave, onClose }: SettingsModalProps) {
  const [config, setConfig] = useState<ModelsConfig>(() => {
    if (initialConfig) return structuredClone(initialConfig);
    return { providers: { deepseek: { ...EMPTY_PROVIDER, baseUrl: "https://api.deepseek.com" } } };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!initialConfig) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
        onClick={onClose}
      >
        <div
          className="bg-bg-card border border-border-default rounded-lg px-6 py-8 flex flex-col items-center gap-3 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <Settings size={20} className="text-brand animate-spin" />
          <span className="text-sm text-text-secondary">正在加载配置... </span>
        </div>
      </div>,
      document.body
    );
  }

  const providerEntries = Object.entries(config.providers);

  const updateProvider = (name: string, patch: Partial<ProviderConfig>) => {
    setConfig((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [name]: { ...prev.providers[name], ...patch },
      },
    }));
  };

  const updateProviderName = (oldName: string, newName: string) => {
    if (oldName === newName || !newName.trim()) return;
    setConfig((prev) => {
      const next: Record<string, ProviderConfig> = {};
      for (const [key, value] of Object.entries(prev.providers)) {
        next[key === oldName ? newName : key] = value;
      }
      return { ...prev, providers: next };
    });
  };

  const addProvider = () => {
    setConfig((prev) => {
      let idx = 1;
      while (prev.providers[`provider${idx}`]) idx++;
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [`provider${idx}`]: { ...EMPTY_PROVIDER },
        },
      };
    });
  };

  const removeProvider = (name: string) => {
    setConfig((prev) => {
      const next = { ...prev.providers };
      delete next[name];
      return { ...prev, providers: next };
    });
  };

  const updateModel = (providerName: string, index: number, patch: Partial<ProviderModel>) => {
    setConfig((prev) => {
      const models = [...prev.providers[providerName].models];
      models[index] = { ...models[index], ...patch };
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [providerName]: { ...prev.providers[providerName], models },
        },
      };
    });
  };

  const addModel = (providerName: string) => {
    setConfig((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [providerName]: {
          ...prev.providers[providerName],
          models: [...prev.providers[providerName].models, { id: "" }],
        },
      },
    }));
  };

  const removeModel = (providerName: string, index: number) => {
    setConfig((prev) => {
      const models = prev.providers[providerName].models.filter((_, i) => i !== index);
      return {
        ...prev,
        providers: {
          ...prev.providers,
          [providerName]: { ...prev.providers[providerName], models },
        },
      };
    });
  };

  const handleSave = () => {
    // Filter out empty model ids and trim provider names.
    const cleaned: Record<string, ProviderConfig> = {};
    for (const [name, provider] of Object.entries(config.providers)) {
      const trimmedName = name.trim();
      if (!trimmedName) continue;
      cleaned[trimmedName] = {
        ...provider,
        models: provider.models
          .map((m) => ({ ...m, id: m.id.trim() }))
          .filter((m) => m.id),
      };
      if (cleaned[trimmedName].models.length === 0) {
        cleaned[trimmedName].models = [{ id: "" }];
      }
    }
    onSave({ providers: cleaned });
  };

  const canSave = providerEntries.length > 0 && providerEntries.every(([name, p]) =>
    name.trim() && p.baseUrl.trim() && p.api.trim() && p.models.some((m) => m.id.trim())
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border-default rounded-lg w-[640px] max-w-[92vw] max-h-[90vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-brand" />
            <span className="text-sm font-medium text-text-primary">LLM 设置</span>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors p-1 rounded hover:bg-bg-surface"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {providerEntries.map(([name, provider]) => (
            <div key={name} className="border border-border-subtle rounded-lg p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <input
                  value={name}
                  onChange={(e) => updateProviderName(name, e.target.value)}
                  placeholder="provider name"
                  className="flex-1 h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                />
                <button
                  type="button"
                  onClick={() => removeProvider(name)}
                  className="p-1.5 text-text-muted hover:text-error transition-colors"
                  title="删除 provider"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-muted">Base URL</label>
                  <input
                    value={provider.baseUrl}
                    onChange={(e) => updateProvider(name, { baseUrl: e.target.value })}
                    placeholder="https://api.example.com"
                    className="h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-muted">API 类型</label>
                  <input
                    value={provider.api}
                    onChange={(e) => updateProvider(name, { api: e.target.value })}
                    placeholder="openai-completions"
                    className="h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-text-muted">API Key</label>
                <input
                  type="password"
                  value={provider.apiKey}
                  onChange={(e) => updateProvider(name, { apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="h-9 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">模型列表</span>
                  <button
                    type="button"
                    onClick={() => addModel(name)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-bg-surface text-text-secondary hover:text-text-primary hover:border-brand/40 border border-border-default transition-colors"
                  >
                    <Plus size={12} /> 添加模型
                  </button>
                </div>
                <div className="space-y-2">
                  {provider.models.map((model, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        value={model.id}
                        onChange={(e) => updateModel(name, idx, { id: e.target.value })}
                        placeholder="模型 ID"
                        className="flex-1 h-8 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                      />
                      <input
                        value={model.name ?? ""}
                        onChange={(e) => updateModel(name, idx, { name: e.target.value })}
                        placeholder="显示名称（可选）"
                        className="flex-1 h-8 bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50"
                      />
                      <button
                        type="button"
                        onClick={() => removeModel(name, idx)}
                        className="p-1.5 text-text-muted hover:text-error transition-colors"
                        title="删除模型"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addProvider}
            className="w-full py-2 rounded-lg border border-dashed border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40 hover:bg-bg-surface transition-colors text-sm inline-flex items-center justify-center gap-1.5"
          >
            <Plus size={14} /> 添加 Provider
          </button>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="px-3 py-1.5 rounded text-sm bg-brand/15 border border-brand/40 text-brand hover:bg-brand/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
