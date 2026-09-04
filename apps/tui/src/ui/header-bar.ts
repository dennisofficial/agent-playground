import { cellsOf } from './hint-layout'
import { collapseHome, compactPath } from './paths'
import { glyph, theme } from './theme'
import type { Span } from './components/spans'

export const HEADER_GUTTER = 2

export type DiffStat = { added: number; removed: number }

export type HeaderLocation = { inPlace: boolean; label: string }

const CHANGED = /\d+ files? changed/
const INSERTIONS = /(\d+) insertion/
const DELETIONS = /(\d+) deletion/

export function parseShortStat(output: string): DiffStat | null {
  if (!CHANGED.test(output)) return null

  const insertions = INSERTIONS.exec(output)
  const deletions = DELETIONS.exec(output)
  return {
    added: Number.parseInt(insertions?.[1] ?? '0', 10),
    removed: Number.parseInt(deletions?.[1] ?? '0', 10),
  }
}

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

export function headerLocation(args: {
  projectDirectory: string
  repoRoot: string
  home: string
}): HeaderLocation {
  const { projectDirectory, repoRoot } = args
  if (projectDirectory === repoRoot) return { inPlace: true, label: baseName(repoRoot) }
  if (projectDirectory.startsWith(`${repoRoot}/`)) {
    return { inPlace: false, label: projectDirectory.slice(repoRoot.length + 1) }
  }
  return { inPlace: false, label: collapseHome({ cwd: projectDirectory, home: args.home }) }
}

export function diffVisible(stat: DiffStat | null): stat is DiffStat {
  return stat !== null && (stat.added > 0 || stat.removed > 0)
}

export function headerBarModel(args: {
  location: HeaderLocation
  diff: DiffStat | null
  cells: number
}): { left: Span[]; right: Span[] } {
  const diff = args.diff
  const right: Span[] = diffVisible(diff)
    ? [
        { text: `+${diff.added}`, fg: theme.okBright },
        { text: '  ' },
        { text: `-${diff.removed}`, fg: theme.error },
      ]
    : []

  const rightCells = right.reduce((total, span) => total + cellsOf(span.text), 0)
  const place = args.location.inPlace ? glyph.home : glyph.worktree
  const prefixCells = cellsOf(place) + 1
  const budget = Math.max(0, args.cells - prefixCells - (rightCells === 0 ? 0 : rightCells + 1))
  const label = compactPath({ path: args.location.label, cells: budget })

  return {
    left: [
      { text: place, fg: theme.dim },
      { text: ' ' },
      { text: label, fg: theme.hover },
    ],
    right,
  }
}
