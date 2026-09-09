import { EDiffLine, type DiffHunk, type DiffLine } from './hunk'

/**
 * OpenTUI's native TextBuffer pool caps at 2^14 handles and every rendered diff line spends one,
 * so a whole-file rewrite (a regenerated bundle, a reformatted snapshot) mounts enough rows to
 * exhaust the pool and take the tile down with it. Capping keeps the head of the diff and books
 * the rest as one overflow elision; the header counts and the clipboard patch still describe the
 * full change.
 */
export function capHunks(args: {
  hunks: readonly DiffHunk[]
  cap: number
}): readonly DiffHunk[] {
  const cap = Math.max(1, Math.trunc(args.cap))
  const total = args.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  if (total <= cap) return args.hunks

  const kept: DiffHunk[] = []
  let budget = cap
  for (const hunk of args.hunks) {
    if (budget <= 0) break
    if (hunk.lines.length <= budget) {
      kept.push(hunk)
      budget -= hunk.lines.length
      continue
    }
    const overflow: DiffLine = {
      kind: EDiffLine.Elision,
      oldNumber: null,
      newNumber: null,
      text: '',
      elided: total - cap + 1,
      overflow: true,
    }
    kept.push({ ...hunk, lines: [...hunk.lines.slice(0, budget - 1), overflow] })
    budget = 0
  }
  return kept
}
