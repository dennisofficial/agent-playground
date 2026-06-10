import { EnvService } from '@core/config/env/env.service';
import { ChatAnthropic } from '@langchain/anthropic';
import { Injectable } from '@nestjs/common';

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Reusable Anthropic model builders, shared by the chat agents, the gate, and the reconcile passes.
 * (Ported from playground/src/model.ts, env reads moved onto EnvService.) Callers build lazily (on
 * first use), not at module top-level — ChatAnthropic's constructor throws if ANTHROPIC_API_KEY is
 * missing, and a top-level crash would beat the TUI's error rendering to the screen.
 */
@Injectable()
export class ChatModelFactory {
  constructor(private readonly env: EnvService) {}

  /** The main chat model (one model for v0; per-role / multi-LLM config comes later). */
  buildModel(): ChatAnthropic {
    const temperature = this.env.get('CHAT_TEMPERATURE') ?? 1;
    const maxTokens = Math.max(1, this.env.get('CHAT_MAX_TOKENS') ?? 2048);
    return new ChatAnthropic({
      model: this.env.get('CHAT_MODEL') ?? DEFAULT_CHAT_MODEL,
      betas: ['extended-cache-ttl-2025-04-11'], // honor `ttl: '1h'` cache_control; without it 1h silently falls back to 5m
      thinking: { type: 'adaptive', display: 'summarized' },
      maxTokens,
      temperature,
    });
  }

  /**
   * Cheap, fast model for the response gate. The gate fires on EVERY message for EVERY bot, so it
   * sets the token floor — Haiku keeps the respond/ignore decision near-free. Returns a small
   * structured tool call (one-line reasoning + action + optional emoji) — still tiny.
   */
  buildGateModel(): ChatAnthropic {
    return new ChatAnthropic({ model: this.env.get('GATE_MODEL') ?? DEFAULT_SMALL_MODEL, maxTokens: 256, temperature: 0 });
  }

  /**
   * Cheap model for the post-turn RECONCILE passes (facts + tasks) — runs in the background after a
   * turn. Roomier than the gate: returns a structured call with facts[] / tasks[] arrays.
   */
  buildExtractModel(): ChatAnthropic {
    return new ChatAnthropic({ model: this.env.get('EXTRACT_MODEL') ?? DEFAULT_SMALL_MODEL, maxTokens: 512, temperature: 0 });
  }
}

/**
 * Debug aid: USD cost of one chat reply. Sonnet 4.6 pricing: $3.00/1M input, $15.00/1M output
 * (verified against the Anthropic model catalog, 2026-06). The chat path caches its prompt prefix,
 * so the billed cost splits by token kind: langchain folds cache reads + writes INTO `input`, so
 * back them out — fresh remainder at full rate, cache reads ~0.1×, cache writes ~2× (1-hour TTL).
 */
export const CHAT_PRICE_PER_MTOK = { input: 3.0, output: 15.0 } as const;
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 2.0; // 1-hour TTL writes cost 2× base (a 5-min-TTL write would be 1.25×)
export const chatCostUsd = (u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number => {
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
 * Debug aid: USD cost of one gate call, from the EXACT token counts the API returns. Haiku 4.5
 * pricing: $1.00/1M input, $5.00/1M output (verified against the Anthropic model catalog, 2026-06).
 */
export const GATE_PRICE_PER_MTOK = { input: 1.0, output: 5.0 } as const;
export const gateCostUsd = (inputTokens: number, outputTokens: number): number =>
  (inputTokens * GATE_PRICE_PER_MTOK.input + outputTokens * GATE_PRICE_PER_MTOK.output) / 1_000_000;
