import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelsConfig } from "../src/types/models-config.js";

export const MODELS_CONFIG_DIR = join(homedir(), ".pi", "agent");
export const MODELS_CONFIG_PATH = join(MODELS_CONFIG_DIR, "models.json");

export async function modelsConfigExists(): Promise<boolean> {
  try {
    await access(MODELS_CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function ensureModelsConfig(): Promise<boolean> {
  return modelsConfigExists();
}

/**
 * X34：首次配置落盘改为接收**向导提交的完整 provider 配置**（去 DeepSeek 硬编码，
 * 无默认供应商）；掩码占位由 unmaskFromDisk 还原（与 writeModelsConfig 同语义）。
 */
export async function createDefaultModelsConfig(config: ModelsConfig): Promise<void> {
  await writeModelsConfig(config);
}

export async function readModelsConfig(): Promise<ModelsConfig> {
  const raw = await readFile(MODELS_CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as ModelsConfig;
}

const MASK_TOKEN = "****";

/** Mask an API key for transport/display: keep a short prefix/suffix only. */
export function maskApiKey(key: string): string {
  if (!key) return key;
  if (key.length <= 8) return MASK_TOKEN;
  return `${key.slice(0, 4)}${MASK_TOKEN}${key.slice(-4)}`;
}

function isMaskedApiKey(value: string | undefined): boolean {
  return typeof value === "string" && value.includes(MASK_TOKEN);
}

/** Deep-copy a config with every provider apiKey masked (safe to send to the frontend). */
export function maskModelsConfig(config: ModelsConfig): ModelsConfig {
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([name, provider]) => [
        name,
        { ...provider, apiKey: maskApiKey(provider.apiKey ?? "") },
      ]),
    ),
  };
}

/**
 * Replace masked apiKey placeholders in an incoming config with the real keys
 * stored on disk, so saving settings from the UI never clobbers a key with its
 * own mask.
 */
async function unmaskFromDisk(config: ModelsConfig): Promise<ModelsConfig> {
  let existing: ModelsConfig | null = null;
  try {
    existing = await readModelsConfig();
  } catch {
    existing = null;
  }
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers ?? {}).map(([name, provider]) => {
        if (isMaskedApiKey(provider.apiKey)) {
          const original = existing?.providers?.[name]?.apiKey ?? "";
          return [name, { ...provider, apiKey: original }];
        }
        return [name, provider];
      }),
    ),
  };
}

export async function writeModelsConfig(config: ModelsConfig): Promise<void> {
  const resolved = await unmaskFromDisk(config);
  await mkdir(MODELS_CONFIG_DIR, { recursive: true });
  const tempPath = `${MODELS_CONFIG_PATH}.tmp`;
  await writeFile(tempPath, JSON.stringify(resolved, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tempPath, MODELS_CONFIG_PATH);
}

export interface AvailableModel {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: string[];
}

/**
 * Available models (valid API keys) via ModelRuntime.getAvailable — source for
 * the chat model selector. The settings dialog keeps reading/writing
 * MODELS_CONFIG_PATH directly.
 */
export async function listAvailableModels(
  modelRuntime: Pick<ModelRuntime, "getAvailable">,
): Promise<AvailableModel[]> {
  const models = await modelRuntime.getAvailable();
  return models.map((m) => ({
    provider: String(m.provider),
    modelId: m.id,
    name: m.name,
    thinkingLevels: getSupportedThinkingLevels(m),
  }));
}
