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
    thinking: { type: 'adaptive', display: 'summarized' },
    maxTokens,
    temperature,
  });
}

/**
 * Debug aid: USD cost of one chat reply, the employee-facing counterpart to `gateCostUsd`. Sonnet 4.6
 * pricing (the model `buildModel` uses): $3.00 / 1M input, $15.00 / 1M output (verified against the
 * Anthropic model catalog, 2026-06). Unlike the gate, the chat path caches its prompt prefix, so the
 * billed cost splits by token kind: langchain folds cache reads + writes INTO `input`, so back them out
 * to bill the fresh remainder at full rate, cache reads at ~0.1×, and cache writes at ~2× (1-hour TTL —
 * the chat cache breakpoints set ttl:'1h'). Kept beside the model id so the price moves with the model if
 * we ever swap it.
 */
export const CHAT_PRICE_PER_MTOK = { input: 3.0, output: 15.0 } as const;
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 2.0; // 1-hour TTL writes cost 2× base (a 5-min-TTL write would be 1.25×)
export const chatCostUsd = (u: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number => {
  const cacheRead = u.cacheRead ?? 0;
  const cacheWrite = u.cacheWrite ?? 0;
  const fresh = Math.max(0, u.input - cacheRead - cacheWrite);
  return (
    (fresh * CHAT_PRICE_PER_MTOK.input +
      cacheRead * CHAT_PRICE_PER_MTOK.input * CACHE_READ_MULT +
      cacheWrite * CHAT_PRICE_PER_MTOK.input * CACHE_WRITE_MULT +
      u.output * CHAT_PRICE_PER_MTOK.output) /
    1_000_000
  );
};

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
 * Debug aid: USD cost of one gate call, from the EXACT token counts the API returns (no estimation —
 * a tokenizer library would only approximate, and the response already carries `usage_metadata`). Haiku
 * 4.5 pricing: $1.00 / 1M input, $5.00 / 1M output (verified against the Anthropic model catalog,
 * 2026-06). Kept beside the model id so the price moves with the model if we ever swap it.
 */
export const GATE_PRICE_PER_MTOK = { input: 1.0, output: 5.0 } as const;
export const gateCostUsd = (inputTokens: number, outputTokens: number): number =>
  (inputTokens * GATE_PRICE_PER_MTOK.input + outputTokens * GATE_PRICE_PER_MTOK.output) / 1_000_000;

/**
 * Cheap model for the post-turn REFLECT pass (facts + tasks) — runs in the background after a turn, so it
 * stays on Haiku. Roomier than the response gate because it returns a small structured tool call: a
 * one-line reasoning plus a facts[] and a tasks[] array.
 */
export function buildExtractModel() {
  return new ChatAnthropic({ model: 'claude-haiku-4-5-20251001', maxTokens: 512, temperature: 0 });
}
