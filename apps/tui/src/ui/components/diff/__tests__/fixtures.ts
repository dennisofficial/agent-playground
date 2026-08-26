import { EDiffLine, type DiffFile, type DiffHunk, type DiffLine } from '@dltech/atlas-core'

export const PATH = 'src/auth/auth.service.ts'

export const LONG_LINE = `    const banner = '${'x'.repeat(160)}'`

const context = (args: { old: number; next: number; text: string }): DiffLine => ({
  kind: EDiffLine.Context,
  oldNumber: args.old,
  newNumber: args.next,
  text: args.text,
})

const removed = (args: { old: number; text: string }): DiffLine => ({
  kind: EDiffLine.Removed,
  oldNumber: args.old,
  newNumber: null,
  text: args.text,
})

const added = (args: { next: number; text: string }): DiffLine => ({
  kind: EDiffLine.Added,
  oldNumber: null,
  newNumber: args.next,
  text: args.text,
})

const elision = (elided: number): DiffLine => ({
  kind: EDiffLine.Elision,
  oldNumber: null,
  newNumber: null,
  text: '',
  elided,
})

export const OLD_CALL = '    const user = await this.users.byEmail(email)'

export const NEW_CALL = '    const user = await this.users.byEmail(email, { withSecret: true })'

export const GUARD = '    if (!user) throw new UnauthorizedException()'

export const ROTATE = '  async rotate(token: string) {'

export const ELIDED = 9

export const HUNK: DiffHunk = {
  heading: 'AuthService.validateUser',
  oldStart: 118,
  newStart: 118,
  lines: [
    context({ old: 118, next: 118, text: '  async validateUser(email: string) {' }),
    removed({ old: 119, text: OLD_CALL }),
    added({ next: 119, text: NEW_CALL }),
    added({ next: 120, text: GUARD }),
    context({ old: 120, next: 121, text: '  }' }),
    elision(ELIDED),
    added({ next: 131, text: ROTATE }),
  ],
}

export const FILE: DiffFile = {
  path: PATH,
  previousPath: null,
  added: 34,
  removed: 7,
  created: false,
  deleted: false,
  hunks: [HUNK],
}

export const WIDE_HUNK: DiffHunk = {
  heading: '',
  oldStart: 8,
  newStart: 8,
  lines: [
    context({ old: 8, next: 8, text: '  render() {' }),
    added({ next: 9, text: LONG_LINE }),
    context({ old: 9, next: 10, text: '  }' }),
  ],
}

export const WIDE_FILE: DiffFile = {
  path: PATH,
  previousPath: null,
  added: 1,
  removed: 0,
  created: false,
  deleted: false,
  hunks: [WIDE_HUNK],
}

export const EMPHASIS_START = NEW_CALL.indexOf(', {')

export const EMPHASIS_END = NEW_CALL.length - 1

export function emphasiseNewCall(line: DiffLine): { start: number; end: number } | null {
  if (line.text !== NEW_CALL) return null
  return { start: EMPHASIS_START, end: EMPHASIS_END }
}
