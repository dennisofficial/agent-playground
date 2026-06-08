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
 * Cheap, fast model for the response gate. The gate fires on EVERY message for EVERY bot, so it sets the
 * token floor — Haiku keeps the respond/ignore decision near-free. It now returns a small structured
 * tool call (a one-line reasoning + the action + an optional emoji), so it needs more than a single
 * word's worth of room — still tiny.
 */
export function buildGateModel() {
  return new ChatAnthropic({ model: 'claude-haiku-4-5-20251001', maxTokens: 256, temperature: 0 });
}

/**
 * Cheap model for the post-turn REFLECT pass (facts + tasks) — runs in the background after a turn, so it
 * stays on Haiku. Roomier than the response gate because it returns a small structured tool call: a
 * one-line reasoning plus a facts[] and a tasks[] array.
 */
export function buildExtractModel() {
  return new ChatAnthropic({ model: 'claude-haiku-4-5-20251001', maxTokens: 512, temperature: 0 });
}
