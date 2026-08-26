import { EDiffLine, type DiffFile, type DiffHunk, type DiffLine } from './hunk'

const GIT_PREAMBLE = 'diff --git '
const OLD_PATH_PREFIX = '--- '
const NEW_PATH_PREFIX = '+++ '
const NEW_FILE_MODE = 'new file mode '
const DELETED_FILE_MODE = 'deleted file mode '
const NO_NEWLINE_MARKER = '\\'
const DEV_NULL = '/dev/null'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
const RENAME_LINE = /^rename (to|from) (.*)$/

type HunkDraft = {
  heading: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
  oldNumber: number
  newNumber: number
  oldRemaining: number
  newRemaining: number
}

type FileDraft = {
  path: string
  previousPath: string | null
  added: number
  removed: number
  created: boolean
  deleted: boolean
  hunks: DiffHunk[]
  hunk: HunkDraft | null
  oldPathSeen: boolean
}

// git's default prefixes are a/ and b/, but diff.mnemonicPrefix swaps in i/ w/ c/ o/ 1/ 2/ for
// index, worktree, commit, object and the two merge parents.
const SOURCE_PREFIX = /^[abciow12]\//

const stripPathPrefix = (value: string): string => {
  const untabbed = value.split('\t')[0] ?? value
  return untabbed.replace(SOURCE_PREFIX, '')
}

// `diff --git a/x b/x` separates the two paths with a bare space and never quotes them, so a path
// containing a space is only resolvable by betting the two halves are identical.
const pathFromPreamble = (rest: string): string | null => {
  const middle = (rest.length - 1) / 2
  if (Number.isInteger(middle) && rest[middle] === ' ') {
    const left = rest.slice(0, middle)
    const right = rest.slice(middle + 1)
    if (left === right) return stripPathPrefix(right)
  }

  const last = rest.split(' ').at(-1)
  return last === undefined || last.length === 0 ? null : stripPathPrefix(last)
}

const startFile = (path: string): FileDraft => ({
  path,
  previousPath: null,
  added: 0,
  removed: 0,
  created: false,
  deleted: false,
  hunks: [],
  hunk: null,
  oldPathSeen: false,
})

const startHunk = (header: RegExpExecArray): HunkDraft => {
  const oldStart = Number.parseInt(header[1] ?? '0', 10)
  const newStart = Number.parseInt(header[3] ?? '0', 10)

  return {
    heading: header[5] ?? '',
    oldStart,
    newStart,
    lines: [],
    oldNumber: oldStart,
    newNumber: newStart,
    oldRemaining: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
    newRemaining: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
  }
}

const closeHunk = (file: FileDraft): void => {
  const hunk = file.hunk
  if (hunk === null) return

  file.hunk = null
  if (hunk.lines.length === 0) return

  file.hunks.push({
    heading: hunk.heading,
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines,
  })
}

const closeFile = (args: { file: FileDraft | null; files: DiffFile[] }): void => {
  const { file, files } = args
  if (file === null) return

  closeHunk(file)
  if (file.path.length === 0) return

  files.push({
    path: file.path,
    previousPath: file.previousPath,
    added: file.added,
    removed: file.removed,
    created: file.created,
    deleted: file.deleted,
    hunks: file.hunks,
  })
}

const bodyRemaining = (hunk: HunkDraft): number =>
  Math.max(0, hunk.oldRemaining) + Math.max(0, hunk.newRemaining)

const appendBodyLine = (args: { file: FileDraft; hunk: HunkDraft; line: string }): boolean => {
  const { file, hunk, line } = args
  const text = line.slice(1)

  if (line.startsWith('+')) {
    hunk.lines.push({ kind: EDiffLine.Added, oldNumber: null, newNumber: hunk.newNumber, text })
    hunk.newNumber += 1
    hunk.newRemaining -= 1
    file.added += 1
    return true
  }

  if (line.startsWith('-')) {
    hunk.lines.push({ kind: EDiffLine.Removed, oldNumber: hunk.oldNumber, newNumber: null, text })
    hunk.oldNumber += 1
    hunk.oldRemaining -= 1
    file.removed += 1
    return true
  }

  if (line.startsWith(' ') || line.length === 0) {
    hunk.lines.push({
      kind: EDiffLine.Context,
      oldNumber: hunk.oldNumber,
      newNumber: hunk.newNumber,
      text,
    })
    hunk.oldNumber += 1
    hunk.newNumber += 1
    hunk.oldRemaining -= 1
    hunk.newRemaining -= 1
    return true
  }

  return false
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: FileDraft | null = null

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line.startsWith(GIT_PREAMBLE)) {
      closeFile({ file: current, files })
      const path = pathFromPreamble(line.slice(GIT_PREAMBLE.length))
      current = startFile(path ?? '')
      continue
    }

    if (line.startsWith(NO_NEWLINE_MARKER)) continue

    const hunk = current === null ? null : current.hunk
    if (current !== null && hunk !== null && bodyRemaining(hunk) > 0) {
      if (appendBodyLine({ file: current, hunk, line })) continue
      closeHunk(current)
    }

    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      if (current === null) continue
      closeHunk(current)
      current.hunk = startHunk(header)
      continue
    }

    if (line.startsWith(OLD_PATH_PREFIX)) {
      if (current === null || current.oldPathSeen) {
        closeFile({ file: current, files })
        current = startFile('')
      }
      current.oldPathSeen = true

      const value = line.slice(OLD_PATH_PREFIX.length)
      if (value.startsWith(DEV_NULL)) {
        current.created = true
        continue
      }
      if (current.path.length === 0) current.path = stripPathPrefix(value)
      continue
    }

    if (current === null) continue

    if (line.startsWith(NEW_PATH_PREFIX)) {
      const value = line.slice(NEW_PATH_PREFIX.length)
      if (value.startsWith(DEV_NULL)) current.deleted = true
      else current.path = stripPathPrefix(value)
      continue
    }

    const rename = RENAME_LINE.exec(line)
    if (rename !== null) {
      const renamed = stripPathPrefix(rename[2] ?? '')
      if (rename[1] === 'to') current.path = renamed
      else current.previousPath = renamed
      continue
    }

    if (line.startsWith(NEW_FILE_MODE)) current.created = true
    else if (line.startsWith(DELETED_FILE_MODE)) current.deleted = true
  }

  closeFile({ file: current, files })
  return files
}
