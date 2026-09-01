export enum EPullRequestState {
  Open = 'open',
  Draft = 'draft',
  Merged = 'merged',
  Closed = 'closed',
}

export enum EChecksState {
  None = 'none',
  Running = 'running',
  Passing = 'passing',
  Failing = 'failing',
}

export type ChecksTally = { running: number; passed: number; failed: number }

export const NO_CHECKS: ChecksTally = { running: 0, passed: 0, failed: 0 }

export type PullRequest = {
  number: number
  title: string
  url: string
  state: EPullRequestState
  checks: EChecksState
  tally: ChecksTally
}

export type PullRequestBadge = {
  label: string
  url: string
  state: EPullRequestState
  checks: EChecksState
}

const SETTLED_STATES = new Set([EPullRequestState.Merged, EPullRequestState.Closed])

export function pullRequestBadge(pullRequest: PullRequest): PullRequestBadge {
  return {
    label: `PR #${pullRequest.number}`,
    url: pullRequest.url,
    state: pullRequest.state,
    checks: SETTLED_STATES.has(pullRequest.state) ? EChecksState.None : pullRequest.checks,
  }
}
