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

export type CheckAttempt = {
  name: string | null
  startedAt: string | null
  outcome: ECheckOutcome
}

/**
 * GitHub's merge box groups the rollup by check name and shows only the newest attempt: pushing
 * again cancels the in-flight run, and that cancelled entry stays in statusCheckRollup next to its
 * successful re-run. Keeping the latest attempt per name matches the box. An attempt without a
 * name or a timestamp cannot be ordered, and attempts tied on startedAt cannot be ranked, so those
 * all survive rather than being ordered by guesswork — the doubt resolves towards alarming.
 */
export function latestAttemptOutcomes(attempts: readonly CheckAttempt[]): ECheckOutcome[] {
  const byName = new Map<string, CheckAttempt[]>()
  const kept: CheckAttempt[] = []

  for (const attempt of attempts) {
    if (attempt.name === null || attempt.startedAt === null) {
      kept.push(attempt)
      continue
    }
    byName.set(attempt.name, [...(byName.get(attempt.name) ?? []), attempt])
  }

  for (const group of byName.values()) {
    const newest = group.reduce((max, attempt) =>
      (attempt.startedAt ?? '') > (max.startedAt ?? '') ? attempt : max,
    )
    kept.push(...group.filter((attempt) => attempt.startedAt === newest.startedAt))
  }

  return kept.map((attempt) => attempt.outcome)
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
