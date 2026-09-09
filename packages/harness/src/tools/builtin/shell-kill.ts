import { z } from 'zod'

import {
  EToolEffect,
  SchemaTool,
  TAKES_NO_PATHS,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import {  portToken } from '../../container/injection'
import {
  EKilledBy,
  EShellStatus,
  type ShellDelta,
  type ShellSnapshot,
} from '../../shells/background-shell'
import { KILL_SETTLE_MS, ShellRegistryPort } from '../../shells/shell-registry'
import { SIGKILL_GRACE_MS } from '../../shells/shell-process'

const inputSchema = z.strictObject({
  shellId: z.string().min(1),
})

const description = [
  'Stop a background shell that is still running.',
  'Takes the shellId that bash returned when it was started with runInBackground.',
  'The whole process group is signalled, so anything the command forked goes with it.',
  `SIGTERM first, then SIGKILL ${SIGKILL_GRACE_MS} ms later if it has not exited.`,
  'The call waits for the shell to die and hands you everything it printed as its result - no separate ending arrives for a shell you stopped.',
].join(' ')

function renderClaimed(args: { snapshot: ShellSnapshot; delta: ShellDelta }): string {
  const { snapshot, delta } = args
  const exit = snapshot.exitCode === undefined ? '' : `, exit code ${snapshot.exitCode}`
  const sections = [
    `Killed shell ${snapshot.shellId} and its process group${exit}. Everything it printed follows.`,
  ]

  if (delta.droppedCharacters > 0) {
    sections.push(
      `[${delta.droppedCharacters} characters were lost before this point: the shell printed faster than it was read.]`,
    )
  }

  sections.push(delta.text.trimEnd() === '' ? 'It printed nothing.' : delta.text.trimEnd())

  if (delta.remainingCharacters > 0) {
    sections.push(
      `[${delta.remainingCharacters} more characters are waiting — call shell_output({ shellId: "${snapshot.shellId}" }) for the rest.]`,
    )
  }

  return sections.join('\n\n')
}

export class ShellKillTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'shell_kill'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema
  override readonly pathFields = TAKES_NO_PATHS

  constructor( private readonly shells: ShellRegistryPort) {
    super()
  }

  protected override async run({
    input,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const killed = this.shells.kill({ shellId: input.shellId, by: EKilledBy.Model, threadId })
    if (!killed.ok) return killed

    const { snapshot } = killed

    if (killed.settled === undefined) {
      return {
        ok: true,
        output: {
          shellId: snapshot.shellId,
          command: snapshot.command,
          status: snapshot.status,
          exitCode: snapshot.exitCode,
        },
        modelText:
          snapshot.status === EShellStatus.Killed
            ? `Shell ${snapshot.shellId} was already being killed, so nothing more was signalled; its ending will arrive when it dies.`
            : `Shell ${snapshot.shellId} had already finished, so nothing was signalled.`,
      }
    }

    const ending = await killed.settled

    if (!ending.died) {
      return {
        ok: true,
        output: {
          shellId: snapshot.shellId,
          command: snapshot.command,
          status: snapshot.status,
          exitCode: snapshot.exitCode,
        },
        modelText: `Signalled shell ${snapshot.shellId} and its process group, but it had not died within ${KILL_SETTLE_MS} ms. If it dies later, its ending will arrive then, the same as any other ending.`,
      }
    }

    return {
      ok: true,
      output: {
        shellId: ending.snapshot.shellId,
        command: ending.snapshot.command,
        status: ending.snapshot.status,
        exitCode: ending.snapshot.exitCode,
        text: ending.delta.text,
        droppedCharacters: ending.delta.droppedCharacters,
        remainingCharacters: ending.delta.remainingCharacters,
      },
      modelText: renderClaimed({ snapshot: ending.snapshot, delta: ending.delta }),
    }
  }
}
