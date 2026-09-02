import { ESegmentJoin, type TokenSegment } from './segments'

const assignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=/

const WORD_SPLITS_OR_GLOBS = /[ \t\n*?[]/

const MAY_NEVER_RUN: ReadonlySet<ESegmentJoin> = new Set([ESegmentJoin.Or, ESegmentJoin.Pipe])

const RUNS_IN_A_SUBSHELL: ReadonlySet<ESegmentJoin> = new Set([
  ESegmentJoin.Pipe,
  ESegmentJoin.Background,
])

export const isAssignment = ({ text }: { text: string }): boolean => assignmentPattern.test(text)

const outlivesItsClause = ({
  joinBefore,
  joinAfter,
}: {
  joinBefore: ESegmentJoin | undefined
  joinAfter: ESegmentJoin | undefined
}): boolean => {
  if (joinBefore !== undefined && MAY_NEVER_RUN.has(joinBefore)) return false
  if (joinAfter !== undefined && RUNS_IN_A_SUBSHELL.has(joinAfter)) return false
  return true
}

const worthTracking = ({ value }: { value: string }): boolean =>
  value.length > 0 && !WORD_SPLITS_OR_GLOBS.test(value)

function harvestInto({
  assignments,
  segment,
}: {
  assignments: Map<string, string>
  segment: TokenSegment
}): void {
  for (const word of segment.words) {
    if (word.isHeredocBody) return
    if (!isAssignment({ text: word.text })) return
    if (word.expansions.length > 0) continue

    const equals = word.text.indexOf('=')
    const value = word.text.slice(equals + 1)
    if (!worthTracking({ value })) continue

    assignments.set(word.text.slice(0, equals), value)
  }
}

export function assignmentsVisibleAcross({
  segments,
}: {
  segments: readonly TokenSegment[]
}): Map<string, string> {
  const assignments = new Map<string, string>()
  let joinBefore: ESegmentJoin | undefined

  for (const segment of segments) {
    if (outlivesItsClause({ joinBefore, joinAfter: segment.joinToNext })) {
      harvestInto({ assignments, segment })
    }
    joinBefore = segment.joinToNext
  }

  return assignments
}
