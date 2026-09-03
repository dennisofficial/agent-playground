import { describe, expect, it } from 'bun:test'

import {
  EChecksState,
  EPullRequestState,
  NO_CHECKS,
  pullRequestBadge,
  type PullRequest,
} from '../pull-request'

const pullRequest = (args: { state: EPullRequestState; checks: EChecksState }): PullRequest => ({
  number: 123,
  title: 'a change',
  url: 'https://github.com/o/r/pull/123',
  state: args.state,
  checks: args.checks,
  tally: NO_CHECKS,
})

describe('pullRequestBadge', () => {
  it('labels the pull request by number', () => {
    const badge = pullRequestBadge(
      pullRequest({ state: EPullRequestState.Open, checks: EChecksState.Passing }),
    )

    expect(badge.label).toBe('#123')
    expect(badge.url).toBe('https://github.com/o/r/pull/123')
    expect(badge.checks).toBe(EChecksState.Passing)
  })

  it('hides settled checks on a merged pull request', () => {
    expect(
      pullRequestBadge(
        pullRequest({ state: EPullRequestState.Merged, checks: EChecksState.Passing }),
      ).checks,
    ).toBe(EChecksState.None)
  })

  it('hides settled checks on a closed pull request', () => {
    expect(
      pullRequestBadge(
        pullRequest({ state: EPullRequestState.Closed, checks: EChecksState.Failing }),
      ).checks,
    ).toBe(EChecksState.None)
  })

  it('keeps checks on a draft, which is still being worked on', () => {
    expect(
      pullRequestBadge(
        pullRequest({ state: EPullRequestState.Draft, checks: EChecksState.Running }),
      ).checks,
    ).toBe(EChecksState.Running)
  })
})
