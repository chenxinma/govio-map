import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Settings, Plus, Trash2 } from "lucide-react";
import type { ModelsConfig, ProviderConfig, ProviderModel } from "../types/models-config";
import {
  canSaveDrafts,
  emptyProviderDraft,
  suggestProviderName,
  toConfig,
  toDrafts,
  validateDrafts,
  type ProviderDraft,
} from "../utils/provider-drafts";

interface SettingsModalProps {
  initialConfig: ModelsConfig | null;
  onSave: (config: ModelsConfig) => void;
  onClose: () => void;
}

const INPUT_CLASS =
  "bg-bg-primary border border-border-default rounded-md px-2.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:border-brand/50";

/**
 * LLM 设置对话框。
 *
 * X11 BUGFIX：provider 编辑态改为 uid 稳定的草稿数组（`utils/provider-drafts`），
 * 名称只是草稿上的普通字段。修复前名称同时被当作 React `key`，每输入一个字符就触发
 * 整卡片重挂载，导致输入框失焦、光标跳走，无法连续输入。
 */
export default function SettingsModal({ initialConfig, onSave, onClose }: SettingsModalProps) {
  const [drafts, setDrafts] = useState<ProviderDraft[]>(() => toDrafts(initialConfig));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 名称问题（空名 / 重名）：编辑期允许存在，保存前拦截并就地提示
  const issues = useMemo(() => validateDrafts(drafts), [drafts]);
  const issueByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) {
      if (!map.has(issue.uid)) map.set(issue.uid, issue.message);
    }
    return map;
  }, [issues]);
  const canSave = canSaveDrafts(drafts);

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

  const updateName = (uid: string, name: string) => {
    setDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, name } : d)));
  };

  const updateCfg = (uid: string, patch: Partial<ProviderConfig>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.uid === uid ? { ...d, cfg: { ...d.cfg, ...patch } } : d))
    );
  };

  const updateModel = (uid: string, index: number, patch: Partial<ProviderModel>) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.uid !== uid) return d;
        const models = [...d.cfg.models];
        models[index] = { ...models[index], ...patch };
        return { ...d, cfg: { ...d.cfg, models } };
      })
    );
  };

  const addModel = (uid: string) => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.uid === uid ? { ...d, cfg: { ...d.cfg, models: [...d.cfg.models, { id: "" }] } } : d
      )
    );
  };

  const removeModel = (uid: string, index: number) => {
    setDrafts((prev) =>
      prev.map((d) =>
        d.uid === uid
          ? { ...d, cfg: { ...d.cfg, models: d.cfg.models.filter((_, i) => i !== index) } }
          : d
      )
    );
  };

  const addProvider = () => {
    setDrafts((prev) => [...prev, emptyProviderDraft(suggestProviderName(prev))]);
  };

  const removeProvider = (uid: string) => {
    setDrafts((prev) => prev.filter((d) => d.uid !== uid));
  };

  const handleSave = () => {
    onSave(toConfig(drafts));
  };

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
          {drafts.map((draft) => {
            const issue = issueByUid.get(draft.uid);
            return (
              <div
                key={draft.uid}
                className="border border-border-subtle rounded-lg p-4 space-y-4"
              >
                <div className="flex items-start justify-between gap-2">
                  {/* 宽度交给本 wrapper 的 flex-1（行方向）；名称 input 用 w-full 而非 flex-1——
                      父级是 flex-col，flex-1 会把 flex-basis 作用到纵轴，把 h-9 高度压扁 */}
                  <div className="flex-1 flex flex-col gap-1">
                    <input
                      value={draft.name}
                      onChange={(e) => updateName(draft.uid, e.target.value)}
                      placeholder="provider name"
                      className={`w-full h-9 ${INPUT_CLASS} ${
                        issue ? "border-error/60" : ""
                      }`}
                    />
                    {issue && <span className="text-xs text-error">{issue}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeProvider(draft.uid)}
                    className="mt-1 p-1.5 text-text-muted hover:text-error transition-colors"
                    title="删除 provider"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">Base URL</label>
                    <input
                      value={draft.cfg.baseUrl}
                      onChange={(e) => updateCfg(draft.uid, { baseUrl: e.target.value })}
                      placeholder="https://api.example.com"
                      className={`h-9 ${INPUT_CLASS}`}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">API 类型</label>
                    <input
                      value={draft.cfg.api}
                      onChange={(e) => updateCfg(draft.uid, { api: e.target.value })}
                      placeholder="openai-completions"
                      className={`h-9 ${INPUT_CLASS}`}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-muted">API Key</label>
                  <input
                    type="password"
                    value={draft.cfg.apiKey}
                    onChange={(e) => updateCfg(draft.uid, { apiKey: e.target.value })}
                    placeholder="sk-..."
                    className={`h-9 ${INPUT_CLASS}`}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">模型列表</span>
                    <button
                      type="button"
                      onClick={() => addModel(draft.uid)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-bg-surface text-text-secondary hover:text-text-primary hover:border-brand/40 border border-border-default transition-colors"
                    >
                      <Plus size={12} /> 添加模型
                    </button>
                  </div>
                  <div className="space-y-2">
                    {draft.cfg.models.map((model, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          value={model.id}
                          onChange={(e) => updateModel(draft.uid, idx, { id: e.target.value })}
                          placeholder="模型 ID"
                          className={`flex-1 h-8 ${INPUT_CLASS}`}
                        />
                        <input
                          value={model.name ?? ""}
                          onChange={(e) => updateModel(draft.uid, idx, { name: e.target.value })}
                          placeholder="显示名称（可选）"
                          className={`flex-1 h-8 ${INPUT_CLASS}`}
                        />
                        <button
                          type="button"
                          onClick={() => removeModel(draft.uid, idx)}
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
            );
          })}

          <button
            type="button"
            onClick={addProvider}
            className="w-full py-2 rounded-lg border border-dashed border-border-default text-text-secondary hover:text-text-primary hover:border-brand/40 hover:bg-bg-surface transition-colors text-sm inline-flex items-center justify-center gap-1.5"
          >
            <Plus size={14} /> 添加 Provider
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border-subtle flex-shrink-0">
          <span className="text-xs text-error truncate">
            {issues.length > 0 ? issues[0].message : ""}
          </span>
          <div className="flex gap-2 flex-shrink-0">
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
      </div>
    </div>,
    document.body
  );
}
