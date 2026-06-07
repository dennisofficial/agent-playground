import { ChatAnthropic } from '@langchain/anthropic';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';

// Read injected vars. Treat ''/undefined as unset, but PRESERVE a valid 0 (e.g. CHAT_TEMPERATURE=0).
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

const prompt = ChatPromptTemplate.fromMessages([
  ['system', 'You are a helpful assistant in a command-line chat.'],
  ['human', '{input}'],
]);

// Lazy + memoized: ChatAnthropic's constructor throws if ANTHROPIC_API_KEY is missing.
// Building the chain at module top-level would crash on import before Ink can render an
// error row — so construct it on first use, inside the App's submit try/catch.
let chain: ReturnType<typeof build> | undefined;

function build() {
  const model = process.env.CHAT_MODEL || 'claude-sonnet-4-6';
  const temperature = num(process.env.CHAT_TEMPERATURE, 1);
  const maxTokens = Math.max(1, num(process.env.CHAT_MAX_TOKENS, 2048));
  // Opus 4.7/4.8 reject sampling params (temperature/top_p/top_k) with a 400 — only pass when accepted.
  const rejectsSampling = /opus-4-(7|8)/.test(model);
  const llm = new ChatAnthropic({
    model, // ANTHROPIC_API_KEY auto-read from injected process.env — not passed explicitly
    maxTokens, // accepted on all models
    ...(rejectsSampling ? {} : { temperature }),
  });
  return prompt.pipe(llm).pipe(new StringOutputParser());
}

export const getChain = () => (chain ??= build());
