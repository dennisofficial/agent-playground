import type { TranscriptEntry } from './transcript-model'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function sameShape(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!isRecord(left) || !isRecord(right)) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false

  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false

  return keys.every((key) => key in right && sameShape(left[key], right[key]))
}

/** Carries unchanged entries onto their previous identity, so `React.memo` on a row can hold. */
export function stabilisedEntries(args: {
  previous: readonly TranscriptEntry[]
  next: readonly TranscriptEntry[]
}): readonly TranscriptEntry[] {
  const { previous, next } = args
  const held = new Map(previous.map((entry) => [entry.key, entry]))

  const settled = next.map((entry) => {
    const before = held.get(entry.key)
    return before !== undefined && sameShape(before, entry) ? before : entry
  })

  const unchanged =
    settled.length === previous.length && settled.every((entry, index) => entry === previous[index])

  return unchanged ? previous : settled
}
