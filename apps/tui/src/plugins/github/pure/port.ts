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

export abstract class PullRequestPort {
  abstract read(request: { checkout: RepositoryCheckout }): Promise<PullRequestReading>

  /** A push-fed implementation answers from the last frame it was handed, so it arms no timer. */
  abstract readonly pushes: boolean
}
