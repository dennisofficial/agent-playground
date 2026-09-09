export enum EDiffLine {
  Context = 'context',
  Added = 'added',
  Removed = 'removed',
  Elision = 'elision',
}

export type DiffLine = {
  kind: EDiffLine
  oldNumber: number | null
  newNumber: number | null
  text: string
  elided?: number
  /** An elision standing for lines dropped by the render cap, not for unchanged context. */
  overflow?: boolean
}

export type DiffHunk = {
  heading: string
  oldStart: number
  newStart: number
  lines: readonly DiffLine[]
}

export type DiffFile = {
  path: string
  previousPath: string | null
  added: number
  removed: number
  created: boolean
  deleted: boolean
  hunks: readonly DiffHunk[]
}

export type DiffRow = { left: DiffLine | null; right: DiffLine | null }
