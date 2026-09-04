import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  FileSystemPort,
  ProcessPort,
  SchemaTool,
  doesNothing,
  waitsBySleeping,
  type DeclaredPathField,
  type PortExposure,
  type ThreadId,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../../execution/local-filesystem'
import { LocalProcessPort } from '../../execution/local-process'
import {
  messageOf,
  readShell,
  render,
  startShell,
  terminatorFor,
  type ShellOutput,
} from '../../shells/shell-process'
import { CHECK_IN_EVERY_MS, ShellRegistryPort } from '../../shells/shell-registry'
import { MAXIMUM_OUTPUT_CHARACTERS, mergeStreams, renderModelText } from './bash-output'
import {
  bashDescription,
  ceilingClause,
  checkInClause,
  exposureClause,
  exposureNeedsBackground,
  exposureUnsupported,
  idlingRefusal,
  noOpRefusal,
  watchClause,
} from './bash-prose'

const DEFAULT_TIMEOUT_MS = 120_000
const MAXIMUM_TIMEOUT_MS = 600_000

const inputSchema = z.strictObject({
  command: z.string().min(1),
  workdir: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().min(1),
  runInBackground: z.boolean().optional(),
  watch: z.string().min(1).optional(),
  checkInMs: z.number().int().positive().optional(),
  exposePort: z.number().int().min(1).max(65_535).optional(),
})

const description = bashDescription({
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maximumTimeoutMs: MAXIMUM_TIMEOUT_MS,
  defaultCheckInMs: CHECK_IN_EVERY_MS,
})

export class BashTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'bash'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    {
      field: 'workdir',
      presence: EPathPresence.Optional,
      form: EPathForm.Absolute,
      content: EContentAccess.None,
    },
  ]

  constructor(
    private readonly shells: ShellRegistryPort,
    private readonly files: FileSystemPort = new LocalFileSystemPort(),
    private readonly processes: ProcessPort = new LocalProcessPort(),
  ) {
    super()
  }

  private async resolveExposure(args: {
    containerPort: number | undefined
    threadId: ThreadId
  }): Promise<{ ok: true; exposure: PortExposure | undefined } | { ok: false; reason: string }> {
    if (args.containerPort === undefined) return { ok: true, exposure: undefined }
    if (this.processes.exposePort === undefined) {
      return { ok: false, reason: exposureUnsupported() }
    }

    return await this.processes.exposePort({
      containerPort: args.containerPort,
      threadId: args.threadId,
    })
  }

  private startInBackground(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd: string
    watch?: string | undefined
    timeoutMs?: number | undefined
    checkInMs?: number | undefined
    exposure?: PortExposure | undefined
  }): ToolOutcome {
    const started = this.shells.start(args)
    if (!started.ok) return started

    const { shellId } = started.snapshot
    const checkInMs = args.checkInMs ?? CHECK_IN_EVERY_MS

    return {
      ok: true,
      output: {
        command: args.command,
        description: args.description,
        shellId,
        status: started.snapshot.status,
        pid: started.snapshot.pid,
        checkInMs,
        ...(args.watch === undefined ? {} : { watch: args.watch }),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.exposure === undefined ? {} : { exposure: args.exposure }),
      },
      modelText: [
        `Started in the background as shell ${shellId}, and it outlives this turn.`,
        'It outlives an interrupt too: stopping a turn stops the turn, not the shell, so nothing here needed nohup,',
        'setsid, a detached subprocess or a sentinel file - only shell_kill and the end of the session stop it.',
        'Its ending will be delivered to you with everything it printed, whether or not a turn is running then,',
        'and so will a prompt it stops on, since its stdin is closed and no ending would ever follow.',
        ...watchClause({ watch: args.watch }),
        ...ceilingClause({ timeoutMs: args.timeoutMs }),
        ...checkInClause({ checkInMs }),
        ...exposureClause({ exposure: args.exposure }),
        'So do not wait on it: no sleeping, no polling, no idle loop, and no do-nothing command to pass the time - a tick only spins the turn. Take up other work, or end the turn and be woken.',
        `Use shell_output({ shellId: "${shellId}" }) only for a shell that will not end on its own, such as a dev server`,
        `whose startup log you need, and shell_kill({ shellId: "${shellId}" }) to stop it.`,
      ].join(' '),
    }
  }

  protected override async run({
    input,
    signal,
    projectDirectory,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    if (signal.aborted) return { ok: false, reason: 'the developer interrupted the turn before the command started' }

    const { command, timeoutMs } = input
    const cwd = input.workdir ?? projectDirectory

    if (input.watch !== undefined && input.runInBackground !== true) {
      return {
        ok: false,
        reason:
          'watch reads the lines of a shell that is still running, so it needs runInBackground: true; a foreground command hands you all of its output the moment it returns, so there is nothing for a watch to be earlier than',
      }
    }

    if (input.checkInMs !== undefined && input.runInBackground !== true) {
      return {
        ok: false,
        reason:
          'checkInMs paces the check-ins of a shell that outlives the call, so it needs runInBackground: true; a foreground command is already bounded by timeoutMs and hands you its ending when it returns',
      }
    }

    if (input.exposePort !== undefined && input.runInBackground !== true) {
      return { ok: false, reason: exposureNeedsBackground() }
    }

    if (input.workdir !== undefined) {
      const directory = await this.files.stat({ path: input.workdir }).catch(() => undefined)
      if (directory === undefined) {
        return { ok: false, reason: `workdir ${input.workdir} does not exist, so there is nowhere to run the command` }
      }
      if (!directory.isDirectory()) {
        return { ok: false, reason: `workdir ${input.workdir} is a file, not a directory` }
      }
    }

    if (input.runInBackground === true) {
      const exposure = await this.resolveExposure({
        containerPort: input.exposePort,
        threadId,
      })
      if (!exposure.ok) return exposure

      return this.startInBackground({
        threadId,
        command,
        description: input.description,
        cwd,
        watch: input.watch,
        timeoutMs,
        checkInMs: input.checkInMs,
        exposure: exposure.exposure,
      })
    }

    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS)

    if (doesNothing({ command })) {
      return { ok: false, reason: noOpRefusal() }
    }

    if (waitsBySleeping({ command, timeoutMs: timeout })) {
      return { ok: false, reason: idlingRefusal({ command, timeoutMs: timeout }) }
    }

    const started = startShell({ command, cwd, processes: this.processes, threadId })
    if (!started.ok) return started

    const { shell } = started
    const terminate = terminatorFor(shell)
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeout)
    signal.addEventListener('abort', terminate, { once: true })

    let read: ShellOutput
    try {
      read = await readShell({ shell, limit: MAXIMUM_OUTPUT_CHARACTERS })
    } catch (error) {
      return { ok: false, reason: `the command could not be read back: ${messageOf(error)}` }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', terminate)
    }

    if (signal.aborted && !timedOut) {
      return { ok: false, reason: 'the developer interrupted the turn while the command was running' }
    }

    const merged = mergeStreams({ stdout: read.stdout, stderr: read.stderr })

    return {
      ok: true,
      output: {
        command,
        description: input.description,
        exitCode: read.exitCode,
        stdout: render(read.stdout),
        stderr: render(read.stderr),
        truncated: merged.truncated,
        timedOut,
      },
      modelText: renderModelText({
        merged: merged.text,
        exitCode: read.exitCode,
        timedOut,
        timeoutMs: timeout,
        maximumTimeoutMs: MAXIMUM_TIMEOUT_MS,
      }),
    }
  }
}
