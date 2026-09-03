import type { Span } from '../../ui/components/spans'
import { theme } from '../../ui/theme'
import { EChecksState, EPullRequestState, type PullRequestBadge } from './pure'

export type PullRequestChip = {
  spans: readonly Span[]
  ground: string
}

const MUTED = { ground: theme.selectedBg, ink: theme.body } as const

/**
 * The fill is the whole reading: a red or amber chip is the reason the pill earns its cells, so
 * the check reading outranks the state reading and no glyph repeats it. An open pull request with
 * no checks configured gets the link blue — green would claim a signal nobody sent.
 */
function chipTone(badge: PullRequestBadge): { ground: string; ink: string } {
  if (badge.checks === EChecksState.Failing) return { ground: theme.error, ink: theme.appBg }
  if (badge.checks === EChecksState.Running) return { ground: theme.warn, ink: theme.appBg }
  if (badge.checks === EChecksState.Passing) return { ground: theme.ok, ink: theme.appBg }
  if (badge.state === EPullRequestState.Merged)
    return { ground: theme.court.external, ink: theme.appBg }
  if (badge.state === EPullRequestState.Open) return { ground: theme.link, ink: theme.appBg }
  return MUTED
}

export function pullRequestChip(badge: PullRequestBadge): PullRequestChip {
  const { ground, ink } = chipTone(badge)
  return { spans: [{ text: badge.label, fg: ink }], ground }
}
