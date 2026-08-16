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

export async function writeModelsConfig(config: ModelsConfig): Promise<void> {
  await mkdir(MODELS_CONFIG_DIR, { recursive: true });
  const tempPath = `${MODELS_CONFIG_PATH}.tmp`;
  await writeFile(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await rename(tempPath, MODELS_CONFIG_PATH);
}

export { DEFAULT_PROVIDER_NAME };
