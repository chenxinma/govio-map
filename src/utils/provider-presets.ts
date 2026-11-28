/**
 * 供应商预置模板（X34 R7：去供应商锁定）。
 *
 * 首启向导 Step1 与 LLM 设置（SettingsModal）共用同一组预置，且**无默认选中**——
 * 用户必须主动选一个模板（或自定义），任何入口都不锁定 DeepSeek。
 */
import { emptyProviderDraft, suggestProviderName, type ProviderDraft } from "./provider-drafts";

export interface ProviderPreset {
  id: "openai" | "anthropic" | "deepseek" | "gemini" | "custom";
  label: string;
  /** 落盘 provider 名（自定义为空，由用户填写） */
  providerName: string;
  baseUrl: string;
  /** pi-ai KnownApi（openai-completions / anthropic-messages / google-generative-ai …） */
  api: string;
  /** 模型 ID 输入框占位提示（不预填，避免过期默认值） */
  modelHint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    providerName: "openai",
    baseUrl: "https://api.openai.com",
    api: "openai-completions",
    modelHint: "gpt-4o",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    providerName: "anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    modelHint: "claude-sonnet-4-5",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    providerName: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    modelHint: "deepseek-chat",
  },
  {
    id: "gemini",
    label: "Gemini",
    providerName: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    api: "google-generative-ai",
    modelHint: "gemini-2.5-pro",
  },
  {
    id: "custom",
    label: "自定义",
    providerName: "",
    baseUrl: "",
    api: "openai-completions",
    modelHint: "",
  },
];

/**
 * 预置 → SettingsModal 草稿：provider 名冲突时退到 suggestProviderName 占位名，
 * 其余字段按模板预填（apiKey 与模型 ID 留空，由用户填写）。
 */
export function presetProviderDraft(preset: ProviderPreset, existing: ProviderDraft[]): ProviderDraft {
  const taken = existing.some((d) => d.name.trim() === preset.providerName);
  const name = preset.providerName && !taken ? preset.providerName : suggestProviderName(existing);
  const draft = emptyProviderDraft(name);
  return {
    ...draft,
    cfg: { ...draft.cfg, baseUrl: preset.baseUrl, api: preset.api, models: [{ id: "" }] },
  };
}
