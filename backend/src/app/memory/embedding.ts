import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Embedding provider port — Atlas's only non-Anthropic dependency for memory. Injected so it can be
 * faked in tests (the pgvector store never embeds in unit tests). Clean-room rewrite of v1's
 * `embedding.ts`; same model + dimension (1536) so it shares the `vector` extension already in the DB.
 */
export interface EmbeddingProvider {
  /** Model id (stored on the fact as `embed_model` for re-embed detection). */
  readonly model: string;
  /** Embed `text`; `orgId` selects the tenant's OpenAI key (omit → env fallback). */
  embed(text: string, orgId?: string): Promise<number[]>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

/**
 * OpenAI adapter. Lazy by construction — no client is built until the first embed, and a missing key
 * throws actionably then (so the module boots key-less). Clients cached per key string.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  private readonly clients = new Map<string, OpenAIEmbeddings>();

  /** @param apiKey resolves the active OpenAI key for a tenant (e.g. CredentialResolver.openaiKey). */
  constructor(private readonly apiKey: (orgId?: string) => Promise<string | undefined>) {}

  private async client(orgId?: string): Promise<OpenAIEmbeddings> {
    const key = await this.apiKey(orgId);
    if (!key) {
      throw new Error('No OpenAI key (OPENAI_API_KEY) — Atlas memory embeddings unavailable.');
    }
    let c = this.clients.get(key);
    if (!c) {
      c = new OpenAIEmbeddings({ model: EMBED_MODEL, apiKey: key });
      this.clients.set(key, c);
    }
    return c;
  }

  async embed(text: string, orgId?: string): Promise<number[]> {
    const client = await this.client(orgId);
    return client.embedQuery(text);
  }
}
