import type { RepositoryCheckout } from './checkout'
import type { PullRequest } from './pull-request'

export enum EPullRequestLookup {
  Found = 'found',
  Absent = 'absent',
  Unavailable = 'unavailable',
}

/**
 * Three arms, not `null`. `Absent` means we asked and there is definitively no pull request, so the
 * pill clears. `Unavailable` means we could not ask, so the last good reading stays on screen and
 * the schedule backs off; `retryable: false` is what a missing binary or an unauthenticated CLI
 * sets, and those do not become true on a timer.
 */
export type PullRequestReading =
  | { lookup: EPullRequestLookup.Found; pullRequest: PullRequest }
  | { lookup: EPullRequestLookup.Absent }
  | { lookup: EPullRequestLookup.Unavailable; retryable: boolean }

export const NO_PULL_REQUEST_READING: PullRequestReading = {
  lookup: EPullRequestLookup.Unavailable,
  retryable: true,
}

export const samePullRequestReading = (
  left: PullRequestReading,
  right: PullRequestReading,
): boolean => {
  if (left.lookup !== EPullRequestLookup.Found || right.lookup !== EPullRequestLookup.Found) {
    return left.lookup === right.lookup
  }

  return (
    left.pullRequest.number === right.pullRequest.number &&
    left.pullRequest.state === right.pullRequest.state &&
    left.pullRequest.checks === right.pullRequest.checks &&
    left.pullRequest.title === right.pullRequest.title &&
    left.pullRequest.url === right.pullRequest.url &&
    left.pullRequest.tally.running === right.pullRequest.tally.running &&
    left.pullRequest.tally.passed === right.pullRequest.tally.passed &&
    left.pullRequest.tally.failed === right.pullRequest.tally.failed
  )
}

export abstract class PullRequestPort {
  abstract read(request: { checkout: RepositoryCheckout }): Promise<PullRequestReading>

  /**
   * By number rather than by directory: a linked pull request's worktree may no longer exist, so
   * the implementation resolves it through `gh --repo`, which accepts HOST/OWNER/REPO.
   */
  abstract readLinked(args: { repo: string; number: number }): Promise<PullRequestReading>

  /** A push-fed implementation answers from the last frame it was handed, so it arms no timer. */
  abstract readonly pushes: boolean
}
