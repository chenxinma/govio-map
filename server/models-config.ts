import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import type { ModelsConfig, ProviderConfig } from "../src/types/models-config.js";

export const MODELS_CONFIG_DIR = join(homedir(), ".pi", "agent");
export const MODELS_CONFIG_PATH = join(MODELS_CONFIG_DIR, "models.json");

const DEFAULT_PROVIDER_NAME = "deepseek";

function createDefaultConfig(apiKey: string): ModelsConfig {
  const provider: ProviderConfig = {
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    apiKey,
    models: [{ id: "deepseek-v4-flash" }],
  };
  return {
    providers: {
      [DEFAULT_PROVIDER_NAME]: provider,
    },
  };
}

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

export async function createDefaultModelsConfig(apiKey: string): Promise<void> {
  const config = createDefaultConfig(apiKey);
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

export { DEFAULT_PROVIDER_NAME };
