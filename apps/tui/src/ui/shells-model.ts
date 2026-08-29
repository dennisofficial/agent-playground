import { EKilledBy, EShellStatus, type ShellSnapshot } from '@dltech/atlas-harness'

export type ShellsState = { index: number }

export const AWAITING_INPUT_LABEL = 'awaiting input'

export const isShellRunning = (shell: ShellSnapshot): boolean =>
  shell.status === EShellStatus.Running

export const runningCount = (shells: readonly ShellSnapshot[]): number =>
  shells.filter(isShellRunning).length

export function openShells(args: { shells: readonly ShellSnapshot[]; shellId?: string }): ShellsState {
  const asked = args.shells.findIndex((shell) => shell.shellId === args.shellId)
  if (asked >= 0) return { index: asked }

  const running = args.shells.findIndex(isShellRunning)
  return { index: running >= 0 ? running : 0 }
}

export function moveShellSelection(args: {
  state: ShellsState
  count: number
  delta: number
}): ShellsState {
  if (args.count <= 0) return { index: 0 }

  const moved = args.state.index + Math.trunc(args.delta)
  return { index: Math.min(Math.max(moved, 0), args.count - 1) }
}

export function selectShell(args: {
  shells: readonly ShellSnapshot[]
  shellId: string
}): ShellsState {
  const found = args.shells.findIndex((shell) => shell.shellId === args.shellId)
  return { index: found < 0 ? 0 : found }
}

export function selectedShell(args: {
  state: ShellsState
  shells: readonly ShellSnapshot[]
}): ShellSnapshot | undefined {
  return args.shells[Math.min(Math.max(args.state.index, 0), args.shells.length - 1)]
}

export function shellStateLabel(shell: ShellSnapshot): string {
  if (shell.status === EShellStatus.Running) {
    return shell.awaitingInput ? AWAITING_INPUT_LABEL : 'running'
  }
  if (shell.status === EShellStatus.Killed) {
    return shell.killedBy === EKilledBy.User ? 'killed by you' : 'killed'
  }
  if (shell.status === EShellStatus.Overflowed) return 'killed — too much output'
  if (shell.exitCode === undefined || shell.exitCode === 0) return 'done'
  return `exit ${shell.exitCode}`
}

export const shellCommandLabel = (command: string): string => command.replace(/\s+/g, ' ').trim()

/**
 * What a human scanning the panel reads. The description is the name the model gave the job, so it
 * wins over the command it happened to spell.
 */
export function shellNameLabel(shell: Pick<ShellSnapshot, 'command' | 'description'>): string {
  const named = shell.description?.trim() ?? ''
  return named === '' ? shellCommandLabel(shell.command) : named
}

function wrapped(args: { line: string; cells: number }): string[] {
  if (args.cells <= 0) return ['']
  if (args.line.length <= args.cells) return [args.line]

  const pieces: string[] = []
  for (let at = 0; at < args.line.length; at += args.cells) {
    pieces.push(args.line.slice(at, at + args.cells))
  }
  return pieces
}

/**
 * The tail of a shell's output, hard-wrapped and cut to the scrollback on offer. Wrapping rather
 * than clipping because a shell prints progress bars and stack traces, where the end of the line is
 * usually the part worth reading.
 */
export function outputRows(args: { text: string; cells: number; limit: number }): readonly string[] {
  if (args.limit <= 0) return []

  const printed = args.text.replace(/\n+$/, '')
  if (printed === '') return []

  const lines = printed.split('\n')
  const laid = lines.flatMap((line) => wrapped({ line: line.replace(/\t/g, '  '), cells: args.cells }))

  return laid.slice(-args.limit)
}

export enum EOutputScroll {
  Lines = 'lines',
  Pages = 'pages',
  ToStart = 'to-start',
  ToEnd = 'to-end',
}

export type OutputScrollCommand =
  | { kind: EOutputScroll.Lines; amount: number }
  | { kind: EOutputScroll.Pages; amount: number }
  | { kind: EOutputScroll.ToStart }
  | { kind: EOutputScroll.ToEnd }

const LINES_PER_PRESS = 3

/**
 * Bare arrows already walk the shells, so reading one shell's scrollback is spelled with the keys a
 * pager uses. Shift is the modifier because a terminal reports it for arrows without a Kitty
 * handshake, which alt and ctrl are not guaranteed to survive.
 */
export function outputScrollCommand(key: {
  name?: string | undefined
  shift?: boolean | undefined
}): OutputScrollCommand | null {
  if (key.name === 'pageup') return { kind: EOutputScroll.Pages, amount: -1 }
  if (key.name === 'pagedown') return { kind: EOutputScroll.Pages, amount: 1 }
  if (key.name === 'home') return { kind: EOutputScroll.ToStart }
  if (key.name === 'end') return { kind: EOutputScroll.ToEnd }

  if (key.shift !== true) return null
  if (key.name === 'up') return { kind: EOutputScroll.Lines, amount: -LINES_PER_PRESS }
  if (key.name === 'down') return { kind: EOutputScroll.Lines, amount: LINES_PER_PRESS }

  return null
}
