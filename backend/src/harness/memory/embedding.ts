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

/** OpenAI adapter. Lazy: the constructor throws without OPENAI_API_KEY, so importing must not build it. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  private embedder?: OpenAIEmbeddings;

  private get client(): OpenAIEmbeddings {
    return (this.embedder ??= new OpenAIEmbeddings({ model: EMBED_MODEL }));
  }

  embed(text: string): Promise<number[]> {
    return this.client.embedQuery(text);
  }
}

/** Serialize a JS vector to the pgvector text form (`[0.1,0.2,…]`). */
export const toPgVector = (v: number[]): string => `[${v.join(',')}]`;
