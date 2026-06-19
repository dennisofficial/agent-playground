/** The LLM providers a tenant must fund. BOTH are required today: Anthropic powers chat/engines,
 * OpenAI powers semantic-memory embeddings (text-embedding-3-small). */
export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const isLlmProvider = (v: string): v is LlmProvider =>
  (LLM_PROVIDERS as readonly string[]).includes(v);

/** The process.env key each provider's SDKs read (lazily, at first call/session spawn). */
export const PROVIDER_ENV_KEY: Record<
  LlmProvider,
  'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'
> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Which credential funds a provider's ENGINE (session) turns. 'api_key' = the metered key (default);
 * 'subscription' = a Claude OAuth token / Codex auth.json. Chat/gate/embeddings always use the API key. */
export type EngineAuthMode = 'api_key' | 'subscription';

export const isEngineAuthMode = (v: string): v is EngineAuthMode =>
  v === 'api_key' || v === 'subscription';

/** A provider's resolved credentials for one workspace — the decrypted shape `resolveCredential()`
 * returns. `apiKey` funds chat/gate/embeddings (and engine turns in 'api_key' mode);
 * `subscriptionSecret` funds engine turns in 'subscription' mode. */
export interface ProviderCredential {
  apiKey?: string;
  engineAuthMode: EngineAuthMode;
  subscriptionSecret?: string;
}

/** Key METADATA — the only shape that ever leaves the store besides `resolve()`/`resolveCredential()`.
 * `engineAuthMode` + `hasSubscription` are non-secret state the admin/UI can show. */
export interface ProviderKeyMeta {
  provider: LlmProvider;
  engineAuthMode: EngineAuthMode;
  hasApiKey: boolean;
  hasSubscription: boolean;
  createdAt: string;
  updatedAt: string;
}
