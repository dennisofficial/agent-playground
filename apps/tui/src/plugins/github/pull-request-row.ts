import type { Span } from '../../ui/components/spans'
import { cellsOf } from '../../ui/hint-layout'
import { spinnerFrame, theme } from '../../ui/theme'
import { pullRequestStatusColor } from './pull-request-pill'
import { pullRequestBadge, type PullRequest } from './pure'

const PASSED = '✓'

const FAILED = '✗'

const GROUP_SEPARATOR = '  '

const joined = (groups: readonly Span[][]): readonly Span[] =>
  groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ text: GROUP_SEPARATOR }, ...group]))

const widthOf = (spans: readonly Span[]): number =>
  spans.reduce((total, span) => total + cellsOf(span.text), 0)

/**
 * Clipping cuts the tail and the failure count is the tail, so a narrow column must be given a
 * poorer composition rather than a truncated rich one — the failing checks are the reading nobody
 * can afford to miss. The ladder drops the state, then the spinner, then the passing count, and
 * never the number or the failures.
 */
export function pullRequestRow(args: {
  pullRequest: PullRequest
  now: number
}): (cells: number) => readonly Span[] {
  const { pullRequest, now } = args
  const { tally } = pullRequest

  const number: Span[] = [
    { text: `#${pullRequest.number}`, fg: pullRequestStatusColor(pullRequestBadge(pullRequest)) },
  ]
  const titled: Span[] = [...number, { text: ` ${pullRequest.state}`, fg: theme.meta }]
  const running: Span[] =
    tally.running === 0
      ? []
      : [{ text: `${spinnerFrame(now)} ${tally.running} running`, fg: theme.warn }]
  const passed: Span[] = tally.passed === 0 ? [] : [{ text: `${tally.passed} ${PASSED}`, fg: theme.ok }]
  const failed: Span[] =
    tally.failed === 0 ? [] : [{ text: `${tally.failed} ${FAILED}`, fg: theme.error }]

  const ladder: readonly (readonly Span[])[] = [
    joined([titled, running, passed, failed]),
    joined([number, running, passed, failed]),
    joined([number, passed, failed]),
    joined([number, failed]),
    joined([number]),
  ]

  return (cells: number): readonly Span[] =>
    ladder.find((rung) => widthOf(rung) <= cells) ?? ladder[ladder.length - 1] ?? number
}
