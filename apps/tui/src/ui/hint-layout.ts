import { theme } from './theme'
import type { Span } from './components/spans'

export type Hint = { key: string; label: string }

export const HINT_SEPARATOR = ' · '

export const cellsOf = (text: string): number => [...text].length

export function hintWidth(hints: readonly Hint[]): number {
  if (hints.length === 0) return 0
  const spelled = hints.reduce(
    (total, hint) => total + cellsOf(hint.key) + 1 + cellsOf(hint.label),
    0,
  )
  return spelled + (hints.length - 1) * HINT_SEPARATOR.length
}

/**
 * Hints are ordered most-wanted first, so a narrow terminal loses the tail rather than wrapping the
 * row and stealing a line from the transcript.
 */
export function fitHints(args: { hints: readonly Hint[]; cells: number }): readonly Hint[] {
  let kept = args.hints
  while (kept.length > 1 && hintWidth(kept) > args.cells) kept = kept.slice(0, -1)
  return kept
}

export function hintSpans(args: { hints: readonly Hint[]; keyColour: string }): Span[] {
  return args.hints.flatMap((hint, index) => [
    ...(index === 0 ? [] : [{ text: HINT_SEPARATOR, fg: theme.rule }]),
    { text: hint.key, fg: args.keyColour },
    { text: ` ${hint.label}`, fg: theme.hint },
  ])
}
