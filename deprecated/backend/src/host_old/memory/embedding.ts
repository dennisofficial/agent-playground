import { OpenAIEmbeddings } from '@langchain/openai';

export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string, orgId?: string): Promise<number[]>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBED_MODEL;
  private readonly clients = new Map<string, OpenAIEmbeddings>();

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
