import type { Event } from '@dltech/atlas-core'
import type { TurnSpend } from '@dltech/atlas-harness'

/**
 * The event log's decode cache (packages/harness/src/store/decode-events.ts) hands a re-read the
 * same objects it decoded before, so a refresh that changed nothing arrives as the same references
 * in a fresh array — identity is content equality here.
 */
export const sameEvents = (args: { left: readonly Event[]; right: readonly Event[] }): boolean =>
  args.left.length === args.right.length &&
  args.left.every((event, at) => event === args.right[at])

const SPEND_FIELDS: Record<keyof TurnSpend, true> = {
  runId: true,
  threadId: true,
  status: true,
  providerId: true,
  modelId: true,
  steps: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
}

const spendFields = Object.keys(SPEND_FIELDS) as (keyof TurnSpend)[]

const sameSpend = (args: { left: TurnSpend; right: TurnSpend }): boolean =>
  spendFields.every((field) => args.left[field] === args.right[field])

/**
 * The ledger has no decode cache behind it — every read is a fresh row of primitives — so spend is
 * compared field by field rather than by reference. SPEND_FIELDS is exhaustive over TurnSpend, so a
 * new field fails to compile here rather than quietly going uncounted.
 */
export const sameTurns = (args: {
  left: readonly TurnSpend[]
  right: readonly TurnSpend[]
}): boolean =>
  args.left.length === args.right.length &&
  args.left.every((turn, at) => {
    const other = args.right[at]
    return other !== undefined && sameSpend({ left: turn, right: other })
  })
