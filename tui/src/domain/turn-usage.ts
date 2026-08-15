import type { TurnUsage } from './message.js';

/**
 * Adding up what a turn cost, across however many `result` frames it produced.
 *
 * A turn used to have exactly one `result`, so "the usage" and "the last usage reported" were the
 * same number and last-write-wins was indistinguishable from a sum. Holding a turn open past `result`
 * (see `engine/background-hold.ts`) made multi-result turns the ordinary case: the model stops, a
 * backgrounded delegate settles, the model wakes and works again, and each of those wake-ups reports
 * its own `result`.
 *
 * Each one is scoped to its REQUEST CYCLE, not to the query and not to the session — proven on tape,
 * where two results on one engine session read `num_turns=18, out=4191, cost=$3.71` and then
 * `num_turns=9, out=2959, cost=$1.83`. The counters reset; nothing is cumulative. So a later result
 * is additive, and taking the last one books a held turn at whatever its final cycle happened to
 * cost — which for a turn that spent an hour waiting on a subagent is close to nothing.
 *
 * Pure, and deliberately NOT in `domain/usage.ts`: that module is the rate-limit meter (`UsageWindow`,
 * `meterBand`), which is about a rolling window against a quota. This is about one turn's bill.
 */
export function addTurnUsage(args: {
  total: TurnUsage | undefined;
  next: TurnUsage | undefined;
}): TurnUsage | undefined {
  const { total, next } = args;
  // Absent is not zero. A turn that died before the engine could report has no token counts at all,
  // and inventing a row of zeroes for it would be a claim rather than a gap.
  if (!total) return next;
  if (!next) return total;

  const cost = addCost(total.costUsd, next.costUsd);
  // Which model to name in the ledger's one model column, when a turn fell back mid-flight.
  //
  // The comparison is the incoming cycle against the RUNNING TOTAL, not against the other cycle,
  // which makes this a first-past-the-post rule rather than a true heaviest-model one: opus 4,000
  // then sonnet 3,000 then sonnet 3,000 books opus, though sonnet generated more. Naming the real
  // winner needs a per-model tally, and `modelUsage` is already collapsed to one name before it gets
  // here (`normalise/claude-normaliser.service.ts`) — so it would take a shape change for a
  // tie-break on a column nothing computes against. Not worth it; recorded so nobody reads more
  // precision into this than it has.
  //
  // Falling back to the other side's name does matter: a cycle can report usage with no `modelUsage`
  // at all, and a named model is worth more to a ledger row than a correctly-weighted blank.
  const [ahead, behind] =
    next.outputTokens > total.outputTokens ? [next, total] : [total, next];
  const model = ahead.model ?? behind.model;

  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * Omitted on both sides stays omitted. A subscription turn reports no cost, and storing `$0.00` as
 * though it had been priced is exactly the confusion the optional field exists to prevent — so the
 * sum of "not billed" and "not billed" is "not billed", not zero.
 */
function addCost(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}
