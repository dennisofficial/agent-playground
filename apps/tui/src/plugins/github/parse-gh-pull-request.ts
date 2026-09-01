import { z } from 'zod'

import {
  checksRollup,
  checksTally,
  ECheckOutcome,
  EPullRequestState,
  type PullRequest,
} from './pure'

/**
 * Three facts about `gh`'s exporter rather than about this repo, all in
 * https://github.com/cli/cli/blob/trunk/api/export_pr.go:
 *
 * 1. `statusCheckRollup` is `null`, not `[]`, when the head commit carries no rollup node
 *    (export_pr.go:157-159). `[]` is also observed, on a merged pull request. Both forms occur.
 * 2. For a `StatusContext` entry, gh writes the GraphQL field `createdAt` under the key
 *    `startedAt` (export_pr.go:152), so the two typenames do not share a meaning for a key.
 * 3. `conclusion` is the empty string on a check that has not completed — Go's zero value passing
 *    through the map — not `null` and not absent.
 *
 * The strings stay `z.string()` rather than `z.enum` so a new GraphQL enum member falls through a
 * lookup instead of blanking the pill. The `.catch` sits on the entry rather than on the array so
 * one entry gh grows a new shape for is ignored while its siblings still count — discarding a real
 * `FAILURE` because the entry beside it changed would degrade towards the reassuring answer. The
 * array keeps its own `.catch(null)` for a rollup that is not a list at all.
 */
const CheckRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  status: z.string(),
  conclusion: z.string(),
})

const StatusContextSchema = z.object({ __typename: z.string(), state: z.string() })

const UNRECOGNISED_ENTRY = { __typename: 'unrecognised', state: '' }

const RollupEntrySchema = z.union([CheckRunSchema, StatusContextSchema]).catch(UNRECOGNISED_ENTRY)

export const GhPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  statusCheckRollup: z.array(RollupEntrySchema).nullable().catch(null),
})

const COMPLETED = 'COMPLETED'

const CHECK_RUN_CONCLUSIONS: Record<string, ECheckOutcome> = {
  SUCCESS: ECheckOutcome.Passed,
  NEUTRAL: ECheckOutcome.Ignored,
  SKIPPED: ECheckOutcome.Ignored,
  STALE: ECheckOutcome.Ignored,
  FAILURE: ECheckOutcome.Failed,
  TIMED_OUT: ECheckOutcome.Failed,
  STARTUP_FAILURE: ECheckOutcome.Failed,
  ACTION_REQUIRED: ECheckOutcome.Failed,
  CANCELLED: ECheckOutcome.Failed,
}

const STATUS_CONTEXT_STATES: Record<string, ECheckOutcome> = {
  SUCCESS: ECheckOutcome.Passed,
  PENDING: ECheckOutcome.Running,
  EXPECTED: ECheckOutcome.Running,
  FAILURE: ECheckOutcome.Failed,
  ERROR: ECheckOutcome.Failed,
}

const PULL_REQUEST_STATES: Record<string, EPullRequestState> = {
  MERGED: EPullRequestState.Merged,
  CLOSED: EPullRequestState.Closed,
}

type RollupEntry = z.infer<typeof RollupEntrySchema>

const outcomeOf = (entry: RollupEntry): ECheckOutcome => {
  if (!('status' in entry)) return STATUS_CONTEXT_STATES[entry.state] ?? ECheckOutcome.Ignored
  if (entry.status !== COMPLETED) return ECheckOutcome.Running

  return CHECK_RUN_CONCLUSIONS[entry.conclusion] ?? ECheckOutcome.Ignored
}

const stateOf = (args: { state: string; isDraft: boolean }): EPullRequestState | null => {
  const settled = PULL_REQUEST_STATES[args.state]
  if (settled !== undefined) return settled
  if (args.state === 'OPEN') return args.isDraft ? EPullRequestState.Draft : EPullRequestState.Open

  return null
}

export function parseGhPullRequest(value: unknown): PullRequest | null {
  const parsed = GhPullRequestSchema.safeParse(value)
  if (!parsed.success) return null

  const state = stateOf({ state: parsed.data.state, isDraft: parsed.data.isDraft })
  if (state === null) return null

  const outcomes = (parsed.data.statusCheckRollup ?? []).map(outcomeOf)

  return {
    number: parsed.data.number,
    title: parsed.data.title,
    url: parsed.data.url,
    state,
    checks: checksRollup(outcomes),
    tally: checksTally(outcomes),
  }
}
