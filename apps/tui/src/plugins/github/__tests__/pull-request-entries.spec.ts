import { describe, expect, it } from 'bun:test'

import type { LinkedPullRequest } from '@dltech/atlas-core'

import { pullRequestEntries } from '../pull-request-entries'
import {
  EChecksState,
  EForge,
  EPullRequestLookup,
  EPullRequestState,
  NO_CHECKS,
  type PullRequestReading,
  type RepositoryCheckout,
} from '../pure'

const REPO = 'github.com/dltech/atlas'

const link = (args: { number: number; branch: string }): LinkedPullRequest => ({
  number: args.number,
  url: `https://github.com/dltech/atlas/pull/${args.number}`,
  repo: REPO,
  branch: args.branch,
})

const checkoutOn = (branch: string): RepositoryCheckout => ({
  directory: '/repo',
  branch,
  forge: EForge.GitHub,
  remote: { host: 'github.com', owner: 'dltech', repo: 'atlas' },
})

const found = (number: number): PullRequestReading => ({
  lookup: EPullRequestLookup.Found,
  pullRequest: {
    number,
    title: 'a pull request',
    url: `https://github.com/dltech/atlas/pull/${number}`,
    state: EPullRequestState.Open,
    checks: EChecksState.Passing,
    tally: NO_CHECKS,
  },
})

const ABSENT: PullRequestReading = { lookup: EPullRequestLookup.Absent }

const readingsOf = (byKey: Record<string, PullRequestReading>) => {
  const missing: PullRequestReading = { lookup: EPullRequestLookup.Unavailable, retryable: true }
  return (key: string): PullRequestReading => byKey[key] ?? missing
}

describe('the display list of pull requests', () => {
  it('is empty with no links and no current checkout', () => {
    expect(pullRequestEntries({ linked: [], read: readingsOf({}), current: null })).toEqual([])
  })

  it('lists the links oldest first with their own readings', () => {
    const entries = pullRequestEntries({
      linked: [link({ number: 401, branch: 'dennis/first' }), link({ number: 412, branch: 'dennis/second' })],
      read: readingsOf({ [`${REPO}#401`]: found(401) }),
      current: null,
    })

    expect(entries.map((entry) => entry.number)).toEqual([401, 412])
    expect(entries[0]?.reading?.lookup).toBe(EPullRequestLookup.Found)
    expect(entries[1]?.reading).toEqual({ lookup: EPullRequestLookup.Unavailable, retryable: true })
  })

  it('sits a found but not yet linked pull request at the bottom as the latest', () => {
    const entries = pullRequestEntries({
      linked: [link({ number: 401, branch: 'dennis/first' })],
      read: readingsOf({}),
      current: { checkout: checkoutOn('dennis/second'), reading: found(412) },
    })

    expect(entries.map((entry) => entry.number)).toEqual([401, 412])
    expect(entries[1]?.current).toBe(true)
    expect(entries[1]?.branch).toBe('dennis/second')
  })

  it('prefers the tracked reading for the link the checkout stands on', () => {
    const entries = pullRequestEntries({
      linked: [link({ number: 401, branch: 'dennis/first' })],
      read: readingsOf({}),
      current: { checkout: checkoutOn('dennis/first'), reading: found(401) },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.current).toBe(true)
    expect(entries[0]?.reading?.lookup).toBe(EPullRequestLookup.Found)
  })

  it('adds nothing for a tracked checkout whose branch has no pull request', () => {
    const entries = pullRequestEntries({
      linked: [link({ number: 401, branch: 'dennis/first' })],
      read: readingsOf({}),
      current: { checkout: checkoutOn('dennis/quiet'), reading: ABSENT },
    })

    expect(entries.map((entry) => entry.number)).toEqual([401])
  })
})
