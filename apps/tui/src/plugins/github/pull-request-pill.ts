import type { Span } from '../../ui/components/spans'
import { theme } from '../../ui/theme'
import { EChecksState, EPullRequestState, type PullRequestBadge } from './pure'

export type PullRequestChip = {
  spans: readonly Span[]
  ground: string
}

const MUTED = { ground: theme.selectedBg, ink: theme.body } as const

/**
 * The one tone every surface shares: the footer paints it as the chip's fill, the sidebar as the
 * number's ink. A red or amber tone is the reason the pill earns its cells, so the check reading
 * outranks the state reading. An open pull request with no checks configured gets the link blue —
 * green would claim a signal nobody sent.
 */
export function pullRequestStatusColor(badge: PullRequestBadge): string {
  if (badge.checks === EChecksState.Failing) return theme.error
  if (badge.checks === EChecksState.Running) return theme.warn
  if (badge.checks === EChecksState.Passing) return theme.ok
  if (badge.state === EPullRequestState.Merged) return theme.court.external
  if (badge.state === EPullRequestState.Open) return theme.link
  return MUTED.ink
}

function chipTone(badge: PullRequestBadge): { ground: string; ink: string } {
  const tone = pullRequestStatusColor(badge)
  return tone === MUTED.ink ? MUTED : { ground: tone, ink: theme.appBg }
}

export function pullRequestChip(badge: PullRequestBadge): PullRequestChip {
  const { ground, ink } = chipTone(badge)
  return { spans: [{ text: badge.label, fg: ink }], ground }
}

/**
 * A linked pull request whose state has not been read yet gets the muted ground: any state color
 * would claim a reading nobody took.
 */
export function pullRequestFallbackChip(args: { label: string }): PullRequestChip {
  return { spans: [{ text: args.label, fg: MUTED.ink }], ground: MUTED.ground }
}
