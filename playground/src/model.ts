import { ChatAnthropic } from '@langchain/anthropic';

// Read injected vars. Treat ''/undefined as unset, but PRESERVE a valid 0 (e.g. CHAT_TEMPERATURE=0).
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

/**
 * Reusable Anthropic model builder, shared by the chat agents and the worker.
 * One model for v0; per-role / multi-LLM config comes later.
 *
 * Note: ChatAnthropic's constructor throws if ANTHROPIC_API_KEY is missing, so callers
 * build lazily (on first use), not at module top-level — otherwise import would crash
 * before Ink can render an error row.
 */
export function buildModel() {
  const temperature = num(process.env.CHAT_TEMPERATURE, 1);
  const maxTokens = Math.max(1, num(process.env.CHAT_MAX_TOKENS, 2048));
  return new ChatAnthropic({
    model: 'claude-sonnet-4-6', // ANTHROPIC_API_KEY auto-read from injected process.env
    maxTokens,
    temperature,
  });
}

/**
 * Cheap, fast model for the response gate. The gate fires on EVERY message for EVERY bot, so it sets
 * the token floor — Haiku keeps the respond/ignore decision near-free. The decision is a single word,
 * hence the tiny maxTokens.
 */
export function buildGateModel() {
  return new ChatAnthropic({ model: 'claude-haiku-4-5-20251001', maxTokens: 16, temperature: 0 });
}
