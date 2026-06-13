import { Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  AccumulatedUsage,
  MessageUsage,
} from '../domain/conductor-events';

// Source: https://www.anthropic.com/pricing, verified June 2025
interface ModelPricing {
  /** USD per 1 million input tokens (fresh, non-cached). */
  input: number;
  /** USD per 1 million output tokens. */
  output: number;
  /** USD per 1 million cache-read tokens. */
  cacheRead: number;
  /** USD per 1 million cache-write tokens at the 5-minute TTL rate. */
  cacheWrite5m: number;
  /** USD per 1 million cache-write tokens at the 1-hour TTL rate (extended-cache-ttl-2025-04-11 beta). */
  cacheWrite1h: number;
}

/** Default model IDs — mirror the defaults in ChatModelFactory so the SurfaceBridge can look up
 * the right pricing tier without having to thread the model name through every event. */
export const CHAT_MODEL = 'claude-sonnet-4-6';
export const GATE_MODEL = 'claude-haiku-4-5-20251001';

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    // 5-min TTL: 1.25× base ($3.00 × 1.25 = $3.75/MTok).
    cacheWrite5m: 3.75,
    // 1-hour TTL: 2× base ($3.00 × 2 = $6.00/MTok). The chat path uses `ttl: '1h'` via the
    // extended-cache-ttl-2025-04-11 beta (see bot-graph.factory.ts, langgraph.engine.ts).
    cacheWrite1h: 6.0,
  },
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    // 5-min TTL: 1.25× base ($1.00 × 1.25 = $1.25/MTok).
    cacheWrite5m: 1.25,
    // 1-hour TTL: 2× base ($1.00 × 2 = $2.00/MTok).
    cacheWrite1h: 2.0,
  },
};

const pricingLogger = new Logger('usage-format');

/**
 * Compute the USD cost for one billed step, given the model and its exact token counts.
 * `cacheRead`/`cacheWrite5m`/`cacheWrite1h` tokens are billed at their own direct rates; the
 * remainder of `input` (after backing out cache tokens) is billed at the full input rate.
 * Returns 0 for unknown models (logs a warning so pricing gaps are auditable).
 */
export function calculateCost(model: string, usage: MessageUsage): number {
  const pricing = PRICING[model];
  if (!pricing) {
    pricingLogger.warn(
      `calculateCost: unknown model "${model}" — returning $0. Add it to PRICING in usage-format.ts.`,
    );
    return 0;
  }
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite5m = usage.cacheWrite5m ?? 0;
  const cacheWrite1h = usage.cacheWrite1h ?? 0;
  const totalCacheWrite = cacheWrite5m + cacheWrite1h;
  const fresh = Math.max(0, usage.input - cacheRead - totalCacheWrite);
  return (
    (fresh * pricing.input +
      cacheRead * pricing.cacheRead +
      cacheWrite5m * pricing.cacheWrite5m +
      cacheWrite1h * pricing.cacheWrite1h +
      usage.output * pricing.output) /
    1_000_000
  );
}

/**
 * One-line usage footer for display, e.g.:
 * `in 1,234 · out 96 · cache read 640 · $0.0087`
 *
 * The model name is prefixed whenever `model` is provided, and a `N calls` segment is added
 * whenever `usage.callCount > 1` (the two are independent), so multi-step turns are visible at a
 * glance, e.g.:
 * `claude-sonnet-4-6 · 3 calls · in 1,234 · out 96 · $0.0087`
 *
 * Cache fields are omitted when zero. Integers are comma-formatted. Cost is 4 decimal places.
 */
export function formatUsageLine(
  usage: AccumulatedUsage,
  model?: string,
): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  if (usage.callCount > 1) parts.push(`${usage.callCount} calls`);

  parts.push(
    `in ${usage.input.toLocaleString('en-US')}`,
    `out ${usage.output.toLocaleString('en-US')}`,
  );
  if (usage.cacheRead > 0)
    parts.push(`cache read ${usage.cacheRead.toLocaleString('en-US')}`);
  if (usage.cacheWrite5m > 0)
    parts.push(`cache write 5m ${usage.cacheWrite5m.toLocaleString('en-US')}`);
  if (usage.cacheWrite1h > 0)
    parts.push(`cache write 1h ${usage.cacheWrite1h.toLocaleString('en-US')}`);
  parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}

/**
 * Extract `MessageUsage` from a LangChain message. Reads `usage_metadata` for input/output/
 * cacheRead and `response_metadata.usage.cache_creation` for the TTL-split cache-write counts.
 *
 * When the extended-cache-ttl-2025-04-11 beta is active, the Anthropic API returns
 * `cache_creation` as `{5m: N, 1h: N}` — both buckets are extracted. Falls back to treating the
 * legacy numeric total (or `input_token_details.cache_creation`) as `cacheWrite1h`, since the
 * chat path always uses `ttl: '1h'`.
 *
 * Returns `undefined` when `usage_metadata` is absent (no model call, e.g. a tool message).
 */
export function extractMessageUsage(msg: BaseMessage): MessageUsage | undefined {
  const um = (
    msg as {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        input_token_details?: { cache_read?: number; cache_creation?: number };
      };
    }
  ).usage_metadata;
  if (!um) return undefined;

  // Prefer the TTL-split data from the raw Anthropic response_metadata. When the
  // extended-cache-ttl beta is active, cache_creation is returned as {5m: N, 1h: N}.
  // Fall back to treating the legacy numeric total as 1h (chat path always uses ttl:'1h').
  const rmUsage = (
    msg as {
      response_metadata?: { usage?: Record<string, unknown> };
    }
  ).response_metadata?.usage;

  let cacheWrite5m: number | undefined;
  let cacheWrite1h: number | undefined;

  const rawCC =
    rmUsage?.cache_creation ?? rmUsage?.cache_creation_input_tokens;
  if (typeof rawCC === 'object' && rawCC !== null) {
    // Anthropic SDK key names (extended-cache-ttl-2025-04-11 beta):
    // { ephemeral_5m_input_tokens: N, ephemeral_1h_input_tokens: N }
    const cc = rawCC as Record<string, unknown>;
    const v5m = cc['ephemeral_5m_input_tokens'];
    const v1h = cc['ephemeral_1h_input_tokens'];
    cacheWrite5m =
      typeof v5m === 'number' && v5m > 0 ? v5m : undefined;
    cacheWrite1h =
      typeof v1h === 'number' && v1h > 0 ? v1h : undefined;
    // Defensive fallback: if neither bucket was extracted (e.g. future key rename),
    // treat the flat total from usage_metadata as 1h rather than silently losing writes.
    if (cacheWrite5m === undefined && cacheWrite1h === undefined) {
      const legacy = um.input_token_details?.cache_creation;
      if (legacy) cacheWrite1h = legacy;
    }
  } else {
    // Numeric total or absent — treat as 1h (fallback for non-TTL-beta or pre-split responses).
    const legacy = um.input_token_details?.cache_creation;
    if (legacy) cacheWrite1h = legacy;
  }

  return {
    input: um.input_tokens ?? 0,
    output: um.output_tokens ?? 0,
    cacheRead: um.input_token_details?.cache_read || undefined,
    cacheWrite5m,
    cacheWrite1h,
  };
}
