import { EChecksState, EPullRequestState, type PullRequestBadge } from '../pure'
import { describe, expect, it } from 'bun:test'

import { pullRequestPill } from '../pull-request-pill'
import { glyph, theme } from '../../../ui/theme'

const badge = (args: { state: EPullRequestState; checks: EChecksState }): PullRequestBadge => ({
  label: 'PR #123',
  url: 'https://github.com/o/r/pull/123',
  state: args.state,
  checks: args.checks,
})

const textOf = (badgeArgs: { state: EPullRequestState; checks: EChecksState }): string =>
  pullRequestPill(badge(badgeArgs))
    .map((span) => span.text)
    .join('')

describe('pullRequestPill', () => {
  it('shows the label alone when there are no checks', () => {
    const spans = pullRequestPill(
      badge({ state: EPullRequestState.Open, checks: EChecksState.None }),
    )

    expect(spans).toEqual([{ text: 'PR #123', fg: theme.meta }])
  })

  it('marks passing, failing and running checks with a static glyph', () => {
    expect(textOf({ state: EPullRequestState.Open, checks: EChecksState.Passing })).toBe(
      `PR #123 ${glyph.passed}`,
    )
    expect(textOf({ state: EPullRequestState.Open, checks: EChecksState.Failing })).toBe(
      `PR #123 ${glyph.failed}`,
    )
    expect(textOf({ state: EPullRequestState.Open, checks: EChecksState.Running })).toBe(
      `PR #123 ${glyph.available}`,
    )
  })

  it('tones a failing check as an error and a passing one as ordinary', () => {
    const failing = pullRequestPill(
      badge({ state: EPullRequestState.Open, checks: EChecksState.Failing }),
    )
    const passing = pullRequestPill(
      badge({ state: EPullRequestState.Open, checks: EChecksState.Passing }),
    )

    expect(failing.at(-1)?.fg).toBe(theme.error)
    expect(passing.at(-1)?.fg).toBe(theme.meta)
  })

  it('tones each pull request state apart', () => {
    const toneOf = (state: EPullRequestState): string | undefined =>
      pullRequestPill(badge({ state, checks: EChecksState.None })).at(0)?.fg

    expect(toneOf(EPullRequestState.Open)).toBe(theme.meta)
    expect(toneOf(EPullRequestState.Draft)).toBe(theme.rule)
    expect(toneOf(EPullRequestState.Merged)).toBe(theme.court.external)
    expect(toneOf(EPullRequestState.Closed)).toBe(theme.rule)
  })
})
