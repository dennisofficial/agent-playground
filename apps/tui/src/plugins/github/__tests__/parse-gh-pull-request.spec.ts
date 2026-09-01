import { describe, expect, it } from 'bun:test'

import { EChecksState, EPullRequestState } from '../pure'

import { parseGhPullRequest } from '../parse-gh-pull-request'

const OPEN_WITH_ROLLUP = {
  isDraft: false,
  number: 14313,
  state: 'OPEN',
  title: 'a change',
  url: 'https://github.com/cli/cli/pull/14313',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      completedAt: '2026-09-01T14:59:05Z',
      conclusion: 'SKIPPED',
      detailsUrl: 'https://github.com/cli/cli/actions/runs/33522901117/job/99906408924',
      name: 'label-external',
      startedAt: '2026-09-01T14:59:11Z',
      status: 'COMPLETED',
      workflowName: 'PR Triaging',
    },
    {
      __typename: 'CheckRun',
      completedAt: '2026-09-01T14:55:38Z',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/cli/cli/actions/runs/33522317856/job/99904382897',
      name: 'lint',
      startedAt: '2026-09-01T14:53:41Z',
      status: 'COMPLETED',
      workflowName: 'Lint',
    },
  ],
}

describe('parseGhPullRequest', () => {
  it('reads a real gh payload', () => {
    const pullRequest = parseGhPullRequest(OPEN_WITH_ROLLUP)

    expect(pullRequest?.number).toBe(14313)
    expect(pullRequest?.state).toBe(EPullRequestState.Open)
    expect(pullRequest?.url).toBe('https://github.com/cli/cli/pull/14313')
    expect(pullRequest?.checks).toBe(EChecksState.Passing)
    expect(pullRequest?.tally).toEqual({ running: 0, passed: 1, failed: 0 })
  })

  it('takes a null rollup as no checks rather than as no pull request', () => {
    const pullRequest = parseGhPullRequest({ ...OPEN_WITH_ROLLUP, statusCheckRollup: null })

    expect(pullRequest?.checks).toBe(EChecksState.None)
  })

  it('takes an empty rollup as no checks', () => {
    expect(parseGhPullRequest({ ...OPEN_WITH_ROLLUP, statusCheckRollup: [] })?.checks).toBe(
      EChecksState.None,
    )
  })

  it('reads a check that has not completed, whose conclusion is the empty string', () => {
    const pullRequest = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
      ],
    })

    expect(pullRequest?.checks).toBe(EChecksState.Running)
    expect(pullRequest?.tally).toEqual({ running: 1, passed: 0, failed: 0 })
  })

  it('reads a StatusContext, whose state carries the verdict', () => {
    const pending = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'vercel', state: 'PENDING', startedAt: 'x' },
      ],
    })
    const errored = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [{ __typename: 'StatusContext', context: 'vercel', state: 'ERROR' }],
    })

    expect(pending?.checks).toBe(EChecksState.Running)
    expect(errored?.checks).toBe(EChecksState.Failing)
  })

  it('counts a cancelled run as failed, the way the merge box does', () => {
    const pullRequest = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    })

    expect(pullRequest?.checks).toBe(EChecksState.Failing)
    expect(pullRequest?.tally).toEqual({ running: 0, passed: 1, failed: 1 })
  })

  it('ignores an entry it cannot recognise, keeping the pull request', () => {
    const pullRequest = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [{ __typename: 'SomethingNew', verdict: 'who knows' }],
    })

    expect(pullRequest?.number).toBe(14313)
    expect(pullRequest?.checks).toBe(EChecksState.None)
  })

  /**
   * The degrade is per entry rather than per rollup: a red check that is already true must not be
   * thrown away because the entry beside it grew a shape gh did not used to write.
   */
  it('keeps a failing check when a sibling entry has a shape it cannot read', () => {
    const pullRequest = parseGhPullRequest({
      ...OPEN_WITH_ROLLUP,
      statusCheckRollup: [
        { __typename: 'SomethingNew', verdict: 'who knows' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    })

    expect(pullRequest?.checks).toBe(EChecksState.Failing)
    expect(pullRequest?.tally).toEqual({ running: 0, passed: 1, failed: 1 })
  })

  it('still degrades to no checks when the rollup is not a list at all', () => {
    expect(
      parseGhPullRequest({ ...OPEN_WITH_ROLLUP, statusCheckRollup: { total: 3 } })?.checks,
    ).toBe(EChecksState.None)
  })

  it('takes an unknown check conclusion as ignored', () => {
    expect(
      parseGhPullRequest({
        ...OPEN_WITH_ROLLUP,
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'INVENTED_LAST_WEEK' },
        ],
      })?.checks,
    ).toBe(EChecksState.None)
  })

  it('reads draft, merged and closed', () => {
    expect(parseGhPullRequest({ ...OPEN_WITH_ROLLUP, isDraft: true })?.state).toBe(
      EPullRequestState.Draft,
    )
    expect(parseGhPullRequest({ ...OPEN_WITH_ROLLUP, state: 'MERGED' })?.state).toBe(
      EPullRequestState.Merged,
    )
    expect(parseGhPullRequest({ ...OPEN_WITH_ROLLUP, state: 'CLOSED' })?.state).toBe(
      EPullRequestState.Closed,
    )
  })

  it('is null on an unknown state, on a missing field and on garbage', () => {
    expect(parseGhPullRequest({ ...OPEN_WITH_ROLLUP, state: 'LOCKED' })).toBeNull()
    expect(parseGhPullRequest({ number: 1 })).toBeNull()
    expect(parseGhPullRequest(null)).toBeNull()
    expect(parseGhPullRequest('not json at all')).toBeNull()
  })
})
