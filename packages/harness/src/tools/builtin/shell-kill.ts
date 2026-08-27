import { z } from 'zod'

import { EToolEffect, SchemaTool, type ToolOutcome, type ToolRun } from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../../container/injection'
import { EShellStatus } from '../../shells/background-shell'
import { ShellRegistryPort } from '../../shells/shell-registry'
import { SIGKILL_GRACE_MS } from '../../shells/shell-process'

const inputSchema = z.strictObject({
  shellId: z.string().min(1),
})

const description = [
  'Stop a background shell that is still running.',
  'Takes the shellId that bash returned when it was started with runInBackground.',
  'The whole process group is signalled, so anything the command forked goes with it.',
  `SIGTERM first, then SIGKILL ${SIGKILL_GRACE_MS} ms later if it has not exited.`,
  'Whatever it printed before dying is handed to you the moment it ends, the same as any other ending.',
].join(' ')

@injectable()
export class ShellKillTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'shell_kill'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(@inject(portToken(ShellRegistryPort)) private readonly shells: ShellRegistryPort) {
    super()
  }

  protected override async run({ input }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const killed = this.shells.kill({ shellId: input.shellId })
    if (!killed.ok) return killed

    const { snapshot } = killed
    const alreadyOver = snapshot.status !== EShellStatus.Running && snapshot.status !== EShellStatus.Killed

    return {
      ok: true,
      output: {
        shellId: snapshot.shellId,
        command: snapshot.command,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
      },
      modelText: alreadyOver
        ? `Shell ${snapshot.shellId} had already finished, so nothing was signalled.`
        : `Signalled shell ${snapshot.shellId} and its process group. You will be handed everything it printed the moment it dies.`,
    }
  }
}
