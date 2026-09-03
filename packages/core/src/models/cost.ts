import type { ModelCost } from "./card";

const PER_MILLION = 1_000_000;

/**
 * A card carries one input rate, but a cached token is not billed at it. Anthropic bills a cache
 * read at 0.1× the input rate and a five-minute cache write at 1.25×; OpenAI bills a cached input
 * token at 0.1× and charges nothing to write one. The read multiplier is therefore exact for both
 * and the write multiplier over-states OpenAI, which is the direction an estimate should err in.
 * https://docs.claude.com/en/docs/build-with-claude/prompt-caching#pricing
 * https://platform.openai.com/docs/guides/prompt-caching
 */
const CACHE_READ_RATE = 0.1;

const CACHE_WRITE_RATE = 1.25;

export type TokenSpend = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Cache reads and writes are counted inside `inputTokens` rather than on top of it, so the tokens
 * billed at the plain input rate are what is left once both are taken out.
 */
export function estimateCostUsd(args: {
  spend: TokenSpend;
  cost: ModelCost;
}): number {
  const { spend, cost } = args;

  const uncached = Math.max(
    0,
    spend.inputTokens - spend.cacheReadTokens - spend.cacheWriteTokens,
  );
  const billedInput =
    uncached +
    spend.cacheReadTokens * CACHE_READ_RATE +
    spend.cacheWriteTokens * CACHE_WRITE_RATE;

  const dollars =
    billedInput * cost.inputPerMillion +
    spend.outputTokens * cost.outputPerMillion;

  return dollars / PER_MILLION;
}
