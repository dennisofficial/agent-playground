import { EChecksState, NO_CHECKS, type ChecksTally } from './pull-request'

export enum ECheckOutcome {
  Passed = 'passed',
  Failed = 'failed',
  Running = 'running',
  Ignored = 'ignored',
}

/**
 * Failing outranks running deliberately: a red check is already true, and waiting will not turn it
 * green.
 */
export function checksRollup(outcomes: readonly ECheckOutcome[]): EChecksState {
  if (outcomes.includes(ECheckOutcome.Failed)) return EChecksState.Failing
  if (outcomes.includes(ECheckOutcome.Running)) return EChecksState.Running
  if (outcomes.includes(ECheckOutcome.Passed)) return EChecksState.Passing

  return EChecksState.None
}

export function checksTally(outcomes: readonly ECheckOutcome[]): ChecksTally {
  return outcomes.reduce<ChecksTally>(
    (tally, outcome) => ({
      running: tally.running + (outcome === ECheckOutcome.Running ? 1 : 0),
      passed: tally.passed + (outcome === ECheckOutcome.Passed ? 1 : 0),
      failed: tally.failed + (outcome === ECheckOutcome.Failed ? 1 : 0),
    }),
    NO_CHECKS,
  )
}
