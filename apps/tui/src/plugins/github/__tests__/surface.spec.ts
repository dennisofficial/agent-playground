import { EChecksState, EPullRequestState, type PullRequestBadge } from '../pure'
import { describe, expect, it } from 'bun:test'

import { EFooterItemReach } from '../../../ui/footer-item'
import { theme } from '../../../ui/theme'
import { pullRequestItem } from '../surface'
import type { FooterPullRequest } from '../use-pull-request'

const NEVER = (): void => undefined

const badge = (over: Partial<PullRequestBadge> = {}): PullRequestBadge => ({
  label: '#123',
  url: 'https://github.com/o/r/pull/123',
  state: EPullRequestState.Open,
  checks: EChecksState.Passing,
  ...over,
})

const footer = (over: Partial<FooterPullRequest> = {}): FooterPullRequest => ({
  badge: badge(),
  label: '#123',
  url: 'https://github.com/o/r/pull/123',
  overflow: 0,
  ...over,
})

describe('pullRequestItem', () => {
  it('says nothing when the session has no pull request', () => {
    expect(pullRequestItem({ footer: null, onOpen: NEVER })).toBeNull()
  })

  it('names the pull request and fills its chip with the check reading', () => {
    const item = pullRequestItem({ footer: footer(), onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe('#123')
    expect(item?.ground).toBe(theme.ok)
    expect(item?.id).toBe('pr')
  })

  it('opens the pull request it names, which is the whole point of reaching it', () => {
    const opened: string[] = []
    const item = pullRequestItem({ footer: footer(), onOpen: (url) => opened.push(url) })

    expect(item?.reach).toBe(EFooterItemReach.Keyboard)
    item?.onActivate?.()
    expect(opened).toEqual(['https://github.com/o/r/pull/123'])
  })

  it('reads a merged pull request in the court purple', () => {
    const item = pullRequestItem({
      footer: footer({ badge: badge({ state: EPullRequestState.Merged, checks: EChecksState.None }) }),
      onOpen: NEVER,
    })
    expect(item?.spans.map((span) => span.text).join('')).toBe('#123')
    expect(item?.ground).toBe(theme.court.external)
  })

  it('counts the pull requests the pill is summarizing', () => {
    const item = pullRequestItem({ footer: footer({ overflow: 2 }), onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe('#123 +2')
  })

  it('mutes a linked pull request whose state has not been read yet', () => {
    const item = pullRequestItem({ footer: footer({ badge: null }), onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe('#123')
    expect(item?.ground).toBe(theme.selectedBg)
  })
})
