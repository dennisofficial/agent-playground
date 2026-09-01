import { describe, expect, it } from 'bun:test'

import { EChecksState, EPullRequestState, type PullRequest } from '../pure'
import { pullRequestRow } from '../pull-request-row'

const WIDE = 200

const NOW = 0

const withChecks = (tally: {
  running: number
  passed: number
  failed: number
}): PullRequest => ({
  number: 12,
  state: EPullRequestState.Open,
  url: 'https://github.com/o/r/pull/12',
  title: 'a change',
  checks: tally.failed > 0 ? EChecksState.Failing : EChecksState.None,
  tally,
})

const textAt = (args: {
  pullRequest: PullRequest
  cells: number
}): string =>
  pullRequestRow({ pullRequest: args.pullRequest, now: NOW })(args.cells)
    .map((span) => span.text)
    .join('')

describe('the pull request row gives up richness before it gives up the failure count', () => {
  const pullRequest = withChecks({ running: 2, passed: 3, failed: 1 })

  it('shows everything when the column is wide', () => {
    const text = textAt({ pullRequest, cells: WIDE })

    expect(text).toContain('#12')
    expect(text).toContain('open')
    expect(text).toContain('2 running')
    expect(text).toContain('3 ✓')
    expect(text).toContain('1 ✗')
  })

  it('drops the state before anything else', () => {
    const text = textAt({ pullRequest, cells: 26 })

    expect(text).not.toContain('open')
    expect(text).toContain('1 ✗')
  })

  it('keeps the number and the failure count at the narrowest width that fits them', () => {
    const text = textAt({ pullRequest, cells: 10 })

    expect(text).toBe('#12  1 ✗')
  })

  it('never clips the failure count away while the number still fits', () => {
    for (let cells = 8; cells <= 40; cells += 1) {
      const text = textAt({ pullRequest, cells })
      if (text.includes('#12') && text.length > '#12'.length) {
        expect(text).toContain('1 ✗')
      }
    }
  })

  it('falls back to the number alone rather than emitting nothing', () => {
    expect(textAt({ pullRequest, cells: 1 })).toBe('#12')
  })

  it('says nothing about checks that do not exist', () => {
    const clean = withChecks({ running: 0, passed: 0, failed: 0 })

    expect(textAt({ pullRequest: clean, cells: WIDE })).toBe('#12 open')
  })
})
