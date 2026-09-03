import { EChecksState, EPullRequestState, type PullRequestBadge } from '../pure'
import { describe, expect, it } from 'bun:test'

import { pullRequestChip } from '../pull-request-pill'
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
