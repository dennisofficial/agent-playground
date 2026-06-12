import { Logger } from '@nestjs/common';
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
  /** USD per 1 million cache-write tokens. */
  cacheWrite: number;
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
    cacheWrite: 3.75,
  },
  'claude-haiku-4-5-20251001': {
    input: 1.0,
    output: 5.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
};

const pricingLogger = new Logger('usage-format');

/**
 * Compute the USD cost for one billed step, given the model and its exact token counts.
 * `cacheRead`/`cacheWrite` tokens are billed at their own direct rates; the remainder of `input`
 * (after backing out cache tokens) is billed at the full input rate.
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
  const cacheWrite = usage.cacheWrite ?? 0;
  const fresh = Math.max(0, usage.input - cacheRead - cacheWrite);
  return (
    (fresh * pricing.input +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite +
      usage.output * pricing.output) /
    1_000_000
  );
}

/**
 * One-line usage footer for display, e.g.:
 * `in 1,234 · out 96 · cache read 640 · $0.0087`
 *
 * Cache fields are omitted when zero. Integers are comma-formatted. Cost is 4 decimal places.
 */
export function formatUsageLine(usage: AccumulatedUsage): string {
  const parts: string[] = [
    `in ${usage.input.toLocaleString('en-US')}`,
    `out ${usage.output.toLocaleString('en-US')}`,
  ];
  if (usage.cacheRead > 0)
    parts.push(`cache read ${usage.cacheRead.toLocaleString('en-US')}`);
  if (usage.cacheWrite > 0)
    parts.push(`cache write ${usage.cacheWrite.toLocaleString('en-US')}`);
  parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}
