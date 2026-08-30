import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import {
  EToolEffect,
  SchemaTool,
  idledSeconds,
  waitsBySleeping,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../../container/injection'
import { ShellRegistryPort } from '../../shells/shell-registry'
import {
  countLineBreaks,
  messageOf,
  probeCwd,
  readShell,
  render,
  startShell,
  terminatorFor,
  type ShellOutput,
  type Tail,
} from '../../shells/shell-process'

const DEFAULT_TIMEOUT_MS = 120_000
const MAXIMUM_TIMEOUT_MS = 600_000
const MAXIMUM_OUTPUT_CHARACTERS = 30_000

const inputSchema = z.strictObject({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().optional(),
  runInBackground: z.boolean().optional(),
})

const description = [
  'Run a command in a fresh bash process, starting in the project directory.',
  'Stay there: reach elsewhere by writing absolute paths in the command, not by opening it with cd.',
  'Use cd only when the developer asks you to move.',
  'A cd does carry to your next call; nothing else does, so a shell variable, function or background job dies with the call that made it.',
  'stdout and stderr come back as one string, all of stdout first and then all of stderr, so the two are not interleaved.',
  'Only the tail is kept once the output grows past its cap.',
  'A non-zero exit is reported rather than raised, with the code named at the end.',
  `Times out after ${DEFAULT_TIMEOUT_MS} ms unless timeoutMs says otherwise, and never later than ${MAXIMUM_TIMEOUT_MS} ms.`,
  'Pass description to say in a few words what the command is for.',
  'A command that only sleeps is refused: idling advances nothing, so back the slow thing and end the turn instead.',
  'Set runInBackground to start a long-running command - a dev server, a watch, a slow test suite - and get a shell id back at once instead of waiting.',
  'A background shell has no timeout, interleaves stdout and stderr in arrival order, and outlives the turn that started it.',
  'Its ending wakes you wherever you are, however it ends, carrying everything it printed - whether or not a turn is running when it lands.',
  'So never wait on one: no sleeping, no polling, no idle loop. Move on to other work, or end the turn and be woken.',
  'shell_output reads a shell that will not end on its own, shell_list shows what is running, and shell_kill stops one.',
].join(' ')

function mergeStreams(args: { stdout: Tail; stderr: Tail }): Tail {
  const text = [args.stdout.text, args.stderr.text]
    .map((stream) => stream.replace(/\n+$/, ''))
    .filter((stream) => stream.length > 0)
    .join('\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()

  const merged: Tail = {
    text,
    droppedLines: args.stdout.droppedLines + args.stderr.droppedLines,
    truncated: args.stdout.truncated || args.stderr.truncated,
  }
  if (text.length <= MAXIMUM_OUTPUT_CHARACTERS) return merged

  const kept = text.slice(-MAXIMUM_OUTPUT_CHARACTERS)
  return {
    text: kept,
    droppedLines: merged.droppedLines + countLineBreaks(text.slice(0, text.length - kept.length)),
    truncated: true,
  }
}

function renderModelText(args: {
  merged: string
  exitCode: number
  timedOut: boolean
  timeoutMs: number
  movedTo?: string | undefined
}): string {
  const sections: string[] = []
  if (args.merged.length > 0) sections.push(args.merged)
  if (args.timedOut) sections.push(`The command was killed after exceeding its ${args.timeoutMs} ms timeout.`)
  if (args.exitCode !== 0) sections.push(`Exit code: ${args.exitCode}`)
  if (args.movedTo !== undefined) sections.push(`You are now in ${args.movedTo}, and later commands start there.`)
  if (sections.length === 0) return 'The command completed with no output.'
  return sections.join('\n\n')
}

@injectable()
export class BashTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'bash'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema

  constructor(@inject(portToken(ShellRegistryPort)) private readonly shells: ShellRegistryPort) {
    super()
  }

  private startInBackground(args: {
    command: string
    description?: string | undefined
    cwd: string
  }): ToolOutcome {
    const started = this.shells.start(args)
    if (!started.ok) return started

    const { shellId } = started.snapshot

    return {
      ok: true,
      output: {
        command: args.command,
        description: args.description,
        shellId,
        status: started.snapshot.status,
        pid: started.snapshot.pid,
      },
      modelText: [
        `Started in the background as shell ${shellId}, and it outlives this turn.`,
        'Its ending will be delivered to you with everything it printed, whether or not a turn is running then.',
        'So do not wait on it: no sleeping, no polling, no idle loop. Take up other work, or end the turn and be woken.',
        `Use shell_output({ shellId: "${shellId}" }) only for a shell that will not end on its own, such as a dev server`,
        `whose startup log you need, and shell_kill({ shellId: "${shellId}" }) to stop it.`,
      ].join(' '),
    }
  }

  protected override async run({
    input,
    signal,
    sessionDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    if (signal.aborted) return { ok: false, reason: 'the developer interrupted the turn before the command started' }

    const { command, timeoutMs } = input

    if (input.runInBackground === true) {
      if (timeoutMs !== undefined) {
        return {
          ok: false,
          reason:
            'a background shell has no timeout: drop timeoutMs to start it, or drop runInBackground to wait for the command',
        }
      }
      return this.startInBackground({
        command,
        description: input.description,
        cwd: sessionDirectory,
      })
    }

    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS)

    if (waitsBySleeping({ command, timeoutMs: timeout })) {
      return {
        ok: false,
        reason: `this command spends ${idledSeconds({ command, timeoutMs: timeout })} seconds asleep, and nothing advances while it does: a background shell's ending is delivered to you wherever you are, so end the turn and be woken rather than idling until it lands`,
      }
    }

    const probe = probeCwd({
      command,
      probeFile: join(tmpdir(), `atlas-cwd-${randomUUID()}`),
    })

    const startedIn = await realpath(sessionDirectory).catch(() => sessionDirectory)
    const started = startShell({ command: probe.command, cwd: startedIn })
    if (!started.ok) {
      await probe.discard()
      return started
    }

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
      await probe.discard()
      return { ok: false, reason: `the command could not be read back: ${messageOf(error)}` }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', terminate)
    }

    const settledIn = await probe.settled()
    await probe.discard()
    const movedTo = settledIn !== undefined && settledIn !== startedIn ? settledIn : undefined

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
        ...(movedTo === undefined ? {} : { sessionDirectory: movedTo }),
      },
      modelText: renderModelText({
        merged: render(merged),
        exitCode: read.exitCode,
        timedOut,
        timeoutMs: timeout,
        movedTo,
      }),
    }
  }
}
