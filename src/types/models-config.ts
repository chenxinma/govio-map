export interface ProviderModel {
  id: string;
  name?: string;
}

export interface ProviderConfig {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: ProviderModel[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}
