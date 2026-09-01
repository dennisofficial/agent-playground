import { wrapInSystemReminder } from '../../context/render'
import type { ThreadId } from '../../events/ids'
import { shellLabel } from '../../shells/label'
import { defineRule, type Rule } from '../rule'
import { appendedAtTail } from './tail-block'

export type RunningShell = {
  shellId: string
  command: string
  description?: string | undefined
  awaitingInput: boolean
  totalCharacters: number
}

export type RunningShellsSource = (args: { threadId: ThreadId }) => readonly RunningShell[]

const AWAITING_INPUT = 'awaiting input — its stdin is closed, so nothing can answer it and it will never end on its own; kill it and re-run with the input piped in'

const printed = (characters: number): string =>
  characters === 1 ? '1 character printed' : `${characters} characters printed`

const lineFor = (shell: RunningShell): string =>
  `${shell.shellId}  ${shellLabel(shell)}  ${shell.awaitingInput ? AWAITING_INPUT : printed(shell.totalCharacters)}`

export function runningShellsReminder(shells: readonly RunningShell[]): string {
  return wrapInSystemReminder(
    [
      'These background shells are still running:',
      shells.map(lineFor).join('\n'),
      'Each outlives this turn and delivers its ending to you by itself, wherever you are, so never poll one to find out whether it has finished. Use shell_output({ shellId }) only to read a shell that will not end on its own, and shell_kill({ shellId }) to stop one.',
    ].join('\n\n'),
  )
}

export function runningShellsBlock({
  runningShells,
}: {
  runningShells: RunningShellsSource
}): Rule {
  return defineRule({
    name: 'runningShellsBlock',
    apply: (input, ctx) => {
      const shells = runningShells({ threadId: ctx.threadId })
      if (shells.length === 0) return input

      return appendedAtTail({ input, ctx, text: runningShellsReminder(shells) })
    },
  })
}
