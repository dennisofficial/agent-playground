import { EChecksState, EPullRequestState, type PullRequestBadge } from '../pure'
import { describe, expect, it } from 'bun:test'

import { pullRequestChip, pullRequestStatusColor } from '../pull-request-pill'
import { theme } from '../../../ui/theme'

const badge = (args: { state: EPullRequestState; checks: EChecksState }): PullRequestBadge => ({
  label: '#123',
  url: 'https://github.com/o/r/pull/123',
  state: args.state,
  checks: args.checks,
})

const groundOf = (badgeArgs: { state: EPullRequestState; checks: EChecksState }): string =>
  pullRequestChip(badge(badgeArgs)).ground

describe('pullRequestChip', () => {
  it('spells the number and nothing else — the fill is the whole reading', () => {
    const chip = pullRequestChip(badge({ state: EPullRequestState.Open, checks: EChecksState.None }))

    expect(chip.spans).toEqual([{ text: '#123', fg: theme.appBg }])
  })

  it('fills the chip with the check reading, which outranks the state', () => {
    expect(groundOf({ state: EPullRequestState.Open, checks: EChecksState.Failing })).toBe(
      theme.error,
    )
    expect(groundOf({ state: EPullRequestState.Open, checks: EChecksState.Running })).toBe(
      theme.warn,
    )
    expect(groundOf({ state: EPullRequestState.Open, checks: EChecksState.Passing })).toBe(
      theme.ok,
    )
    expect(groundOf({ state: EPullRequestState.Draft, checks: EChecksState.Failing })).toBe(
      theme.error,
    )
  })

  it('fills each checkless state apart, none of them green', () => {
    expect(groundOf({ state: EPullRequestState.Open, checks: EChecksState.None })).toBe(theme.link)
    expect(groundOf({ state: EPullRequestState.Merged, checks: EChecksState.None })).toBe(
      theme.court.external,
    )
    expect(groundOf({ state: EPullRequestState.Draft, checks: EChecksState.None })).toBe(
      theme.selectedBg,
    )
    expect(groundOf({ state: EPullRequestState.Closed, checks: EChecksState.None })).toBe(
      theme.selectedBg,
    )
  })

  it('reads the muted chip in body ink so the label survives the dark fill', () => {
    const chip = pullRequestChip(
      badge({ state: EPullRequestState.Closed, checks: EChecksState.None }),
    )

    expect(chip.spans.at(0)?.fg).toBe(theme.body)
  })
})

describe('pullRequestStatusColor', () => {
  const toneOf = (badgeArgs: { state: EPullRequestState; checks: EChecksState }): string =>
    pullRequestStatusColor(badge(badgeArgs))

  it('answers the check reading first, which outranks the state', () => {
    expect(toneOf({ state: EPullRequestState.Open, checks: EChecksState.Failing })).toBe(
      theme.error,
    )
    expect(toneOf({ state: EPullRequestState.Open, checks: EChecksState.Running })).toBe(
      theme.warn,
    )
    expect(toneOf({ state: EPullRequestState.Open, checks: EChecksState.Passing })).toBe(theme.ok)
  })

  it('answers the state when no checks reported', () => {
    expect(toneOf({ state: EPullRequestState.Open, checks: EChecksState.None })).toBe(theme.link)
    expect(toneOf({ state: EPullRequestState.Merged, checks: EChecksState.None })).toBe(
      theme.court.external,
    )
    expect(toneOf({ state: EPullRequestState.Draft, checks: EChecksState.None })).toBe(theme.body)
    expect(toneOf({ state: EPullRequestState.Closed, checks: EChecksState.None })).toBe(theme.body)
  })

  it('is the fill the chip paints, the muted fill aside', () => {
    for (const state of [
      EPullRequestState.Open,
      EPullRequestState.Draft,
      EPullRequestState.Merged,
      EPullRequestState.Closed,
    ]) {
      for (const checks of [
        EChecksState.None,
        EChecksState.Running,
        EChecksState.Passing,
        EChecksState.Failing,
      ]) {
        const tone = toneOf({ state, checks })

        expect(groundOf({ state, checks })).toBe(tone === theme.body ? theme.selectedBg : tone)
      }
    }
  })
})
