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

/** Key METADATA — the only shape that ever leaves the store besides `resolve()`. */
export interface ProviderKeyMeta {
  provider: LlmProvider;
  createdAt: string;
  updatedAt: string;
}
