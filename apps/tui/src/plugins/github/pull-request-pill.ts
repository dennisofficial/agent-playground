import type { Span } from '../../ui/components/spans'
import { glyph, theme } from '../../ui/theme'
import { EChecksState, EPullRequestState, type PullRequestBadge } from './pure'

const STATE_TONE: Record<EPullRequestState, string> = {
  [EPullRequestState.Open]: theme.meta,
  [EPullRequestState.Draft]: theme.rule,
  [EPullRequestState.Merged]: theme.court.external,
  [EPullRequestState.Closed]: theme.rule,
}

/**
 * A static glyph, never a spinner frame: animating this would give the whole footer row a ticking
 * dependency and repaint it at 12.5 fps for a check nobody is watching.
 */
const CHECKS_MARK: Record<EChecksState, Span | null> = {
  [EChecksState.None]: null,
  [EChecksState.Passing]: { text: glyph.passed, fg: theme.meta },
  [EChecksState.Failing]: { text: glyph.failed, fg: theme.error },
  [EChecksState.Running]: { text: glyph.available, fg: theme.rule },
}

export function pullRequestPill(badge: PullRequestBadge): readonly Span[] {
  const label: Span = { text: badge.label, fg: STATE_TONE[badge.state] }
  const mark = CHECKS_MARK[badge.checks]
  if (mark === null) return [label]

  return [label, { text: ' ' }, mark]
}
