import { z } from 'zod'

import {
  EToolEffect,
  quotedShellCommand,
  SchemaTool,
  shellEnding,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import {  portToken } from '../../container/injection'
import { EShellStatus, type ShellSnapshot } from '../../shells/background-shell'
import { ShellRegistryPort } from '../../shells/shell-registry'

const inputSchema = z.strictObject({
  runningOnly: z.boolean().optional(),
})

const description = [
  'List the background shells this conversation has started, running and finished alike.',
  'Set runningOnly to leave out the ones that have already ended.',
  'Each entry names its shellId, its command, whether it is still running, and how much it has printed.',
  'A shell marked as awaiting input is stuck: its stdin is closed, so nothing can answer it and it must be killed.',
  'Reading a shell with shell_output does not appear here; this only says what exists.',
].join(' ')

const AWAITING_INPUT = 'awaiting input — its stdin is closed, so kill it and re-run with input piped in'

function lineFor(snapshot: ShellSnapshot): string {
  const state =
    snapshot.status === EShellStatus.Running
      ? snapshot.awaitingInput
        ? AWAITING_INPUT
        : 'running'
      : shellEnding(snapshot)

  return `${snapshot.shellId}  ${quotedShellCommand(snapshot.command)}  ${state}  (${snapshot.totalCharacters} characters printed)`
}

export class ShellListTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'shell_list'
  readonly description = description
  readonly effect = EToolEffect.Read
  override readonly isConcurrencySafe = (): boolean => true

  readonly inputSchema = inputSchema

  constructor( private readonly shells: ShellRegistryPort) {
    super()
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const all = this.shells.list({ threadId })
    const shown =
      input.runningOnly === true ? all.filter((one) => one.status === EShellStatus.Running) : all

    if (shown.length === 0) {
      return {
        ok: true,
        output: { shells: [] },
        modelText:
          input.runningOnly === true
            ? 'No background shell is running.'
            : 'This conversation has started no background shells.',
      }
    }

    return {
      ok: true,
      output: {
        shells: shown.map((snapshot) => ({
          shellId: snapshot.shellId,
          command: snapshot.command,
          description: snapshot.description,
          status: snapshot.status,
          exitCode: snapshot.exitCode,
          startedAt: snapshot.startedAt,
          lastOutputAt: snapshot.lastOutputAt,
          totalCharacters: snapshot.totalCharacters,
          awaitingInput: snapshot.awaitingInput,
        })),
      },
      modelText: shown.map(lineFor).join('\n'),
    }
  }
}
