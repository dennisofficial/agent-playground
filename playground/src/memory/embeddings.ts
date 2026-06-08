import { OpenAIEmbeddings } from '@langchain/openai';

// Anthropic has no embeddings API, so facts are embedded with OpenAI's small model. The dimension is
// effectively fixed once data exists (stored vectors must stay comparable), so changing models later
// means a re-embed.
export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

let embedder: OpenAIEmbeddings | undefined;

// Lazy + memoized: the constructor throws without OPENAI_API_KEY, so importing this module must not
// build it (same reason buildModel() is lazy — let the UI render an error row instead of crashing).
function getEmbedder(): OpenAIEmbeddings {
  return (embedder ??= new OpenAIEmbeddings({ model: EMBED_MODEL }));
}

export function embed(text: string): Promise<number[]> {
  return getEmbedder().embedQuery(text);
}

/** Cosine similarity of two equal-length vectors; 0 if either is the zero vector. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
