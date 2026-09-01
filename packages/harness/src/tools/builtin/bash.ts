import { stat } from 'node:fs/promises'

import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  SchemaTool,
  idledSeconds,
  waitsBySleeping,
  type DeclaredPathField,
  type ThreadId,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../../container/injection'
import { ShellRegistryPort } from '../../shells/shell-registry'
import {
  countLineBreaks,
  messageOf,
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
  workdir: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().min(1),
  runInBackground: z.boolean().optional(),
})

const description = [
  'Run a command in bash.',
  'Every call starts in the project directory.',
  'To run somewhere else, pass that directory as workdir rather than opening the command with a cd - a cd moves only the process that runs it, and that process ends with the call.',
  'A relative workdir resolves against the project directory.',
  'Good: workdir "packages/core" with command "bun test". Bad: command "cd packages/core && bun test".',
  'Nothing carries between calls: the process is new each time, so a shell variable, function, background job or cd dies with the call that made it.',
  'stdout and stderr come back as one string, all of stdout first and then all of stderr, so the two are not interleaved.',
  'Only the tail is kept once the output grows past its cap.',
  'A non-zero exit is reported rather than raised, with the code named at the end.',
  `Times out after ${DEFAULT_TIMEOUT_MS} ms unless timeoutMs says otherwise, and never later than ${MAXIMUM_TIMEOUT_MS} ms.`,
  'Every call carries a description: a few imperative words naming the job - Run the core tests, Rebase onto main - which is what the developer reads in place of the command.',
  'A command that only sleeps is refused: idling advances nothing, so back the slow thing and end the turn instead.',
  'Set runInBackground to start a long-running command - a dev server, a watch, a slow test suite - and get a shell id back at once instead of waiting.',
  'A background shell starts in the same directory workdir names, has no timeout, interleaves stdout and stderr in arrival order, and outlives the turn that started it.',
  'Its ending wakes you wherever you are, however it ends, carrying everything it printed - whether or not a turn is running when it lands.',
  'Its stdin is closed, so a command that stops to ask something can never be answered and will never end; that too is delivered to you, so a prompt is reported rather than waited out.',
  'So never wait on one: no sleeping, no polling, no idle loop. Move on to other work, or end the turn and be woken.',
  'shell_output reads a shell that will not end on its own, shell_list shows what is running, and shell_kill stops one.',
].join(' ')

const HALF_OUTPUT_CHARACTERS = Math.floor(MAXIMUM_OUTPUT_CHARACTERS / 2)

/**
 * Each stream is budgeted rather than the joined text: keeping the last N characters of stdout
 * followed by stderr throws stdout away first, so a command loud on both showed only stderr.
 */
function budgetsFor(args: { stdout: number; stderr: number }): { stdout: number; stderr: number } {
  if (args.stdout + args.stderr <= MAXIMUM_OUTPUT_CHARACTERS) return args
  if (args.stdout <= HALF_OUTPUT_CHARACTERS) {
    return { stdout: args.stdout, stderr: MAXIMUM_OUTPUT_CHARACTERS - args.stdout }
  }
  if (args.stderr <= HALF_OUTPUT_CHARACTERS) {
    return { stdout: MAXIMUM_OUTPUT_CHARACTERS - args.stderr, stderr: args.stderr }
  }

  return {
    stdout: HALF_OUTPUT_CHARACTERS,
    stderr: MAXIMUM_OUTPUT_CHARACTERS - HALF_OUTPUT_CHARACTERS,
  }
}

const withoutTrailingBreaks = (text: string): string => text.replace(/\n+$/, '')

function clampTail(args: { tail: Tail; budget: number }): Tail {
  const text = withoutTrailingBreaks(args.tail.text)
  if (text.length <= args.budget) return { ...args.tail, text }

  const kept = text.slice(-args.budget)
  return {
    text: kept,
    droppedLines: args.tail.droppedLines + countLineBreaks(text.slice(0, text.length - kept.length)),
    truncated: true,
  }
}

function mergeStreams(args: { stdout: Tail; stderr: Tail }): { text: string; truncated: boolean } {
  const budgets = budgetsFor({
    stdout: withoutTrailingBreaks(args.stdout.text).length,
    stderr: withoutTrailingBreaks(args.stderr.text).length,
  })

  const streams = [
    clampTail({ tail: args.stdout, budget: budgets.stdout }),
    clampTail({ tail: args.stderr, budget: budgets.stderr }),
  ]

  const text = streams
    .filter((stream) => stream.text.length > 0)
    .map(render)
    .join('\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()

  return { text, truncated: streams.some((stream) => stream.truncated) }
}

function renderModelText(args: {
  merged: string
  exitCode: number
  timedOut: boolean
  timeoutMs: number
}): string {
  const sections: string[] = []
  if (args.merged.length > 0) sections.push(args.merged)
  if (args.timedOut) {
    sections.push(
      `The command was killed after exceeding its ${args.timeoutMs} ms timeout. If it needs longer than ${MAXIMUM_TIMEOUT_MS} ms, start it again with runInBackground and its ending will be delivered to you whenever it lands.`,
    )
  }
  if (args.exitCode !== 0) sections.push(`Exit code: ${args.exitCode}`)
  if (sections.length === 0) return 'The command completed with no output.'
  return sections.join('\n\n')
}

@injectable()
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

  constructor(@inject(portToken(ShellRegistryPort)) private readonly shells: ShellRegistryPort) {
    super()
  }

  private startInBackground(args: {
    threadId: ThreadId
    command: string
    description: string
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
        'Its ending will be delivered to you with everything it printed, whether or not a turn is running then,',
        'and so will a prompt it stops on, since its stdin is closed and no ending would ever follow.',
        'So do not wait on it: no sleeping, no polling, no idle loop. Take up other work, or end the turn and be woken.',
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

    if (input.workdir !== undefined) {
      const directory = await stat(input.workdir).catch(() => undefined)
      if (directory === undefined) {
        return { ok: false, reason: `workdir ${input.workdir} does not exist, so there is nowhere to run the command` }
      }
      if (!directory.isDirectory()) {
        return { ok: false, reason: `workdir ${input.workdir} is a file, not a directory` }
      }
    }

    if (input.runInBackground === true) {
      if (timeoutMs !== undefined) {
        return {
          ok: false,
          reason:
            'a background shell has no timeout: drop timeoutMs to start it, or drop runInBackground to wait for the command',
        }
      }
      return this.startInBackground({
        threadId,
        command,
        description: input.description,
        cwd,
      })
    }

    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS)

    if (waitsBySleeping({ command, timeoutMs: timeout })) {
      return {
        ok: false,
        reason: `this command spends ${idledSeconds({ command, timeoutMs: timeout })} seconds asleep, and nothing advances while it does: a background shell's ending is delivered to you wherever you are, so end the turn and be woken rather than idling until it lands`,
      }
    }

    const started = startShell({ command, cwd })
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
      }),
    }
  }
}
