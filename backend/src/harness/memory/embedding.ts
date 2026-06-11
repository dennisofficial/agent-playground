import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Embedding provider port — the SemanticMemory's only non-Anthropic dependency. Injected so it can be
 * swapped/faked (the pgvector adapter never embeds in tests). Anthropic has no embeddings API, so facts
 * are embedded with OpenAI's small model; the dimension (1536) is fixed once data exists.
 */
export interface EmbeddingProvider {
  /** Model id (stored on the fact as `embed_model` for re-embed detection). */
  readonly model: string;
  embed(text: string): Promise<number[]>;
}

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

/**
 * OpenAI adapter. Single-process multi-tenant: the API key comes from a per-turn getter (the active
 * workspace's key, via CredentialContext) rather than process.env, so one provider instance serves
 * every workspace. Clients are cached per key string (rebuilt only on key change/rotation). Lazy by
 * construction — no client is built until the first embed, and a missing key throws actionably then.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  private readonly clients = new Map<string, OpenAIEmbeddings>();

  /** @param apiKey resolves the active turn's OpenAI key (CredentialContext.openaiKey). */
  constructor(private readonly apiKey: () => string | undefined) {}

  private client(): OpenAIEmbeddings {
    const key = this.apiKey();
    if (!key) {
      throw new Error(
        'No OpenAI key for the active workspace (store + OPENAI_API_KEY env both empty) — embeddings unavailable.',
      );
    }
    let c = this.clients.get(key);
    if (!c) {
      c = new OpenAIEmbeddings({ model: EMBED_MODEL, apiKey: key });
      this.clients.set(key, c);
    }
    return c;
  }

  embed(text: string): Promise<number[]> {
    return this.client().embedQuery(text);
  }
}

/** Serialize a JS vector to the pgvector text form (`[0.1,0.2,…]`). */
export const toPgVector = (v: number[]): string => `[${v.join(',')}]`;
