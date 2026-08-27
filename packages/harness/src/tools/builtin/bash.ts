import { z } from 'zod'

import {
  EToolEffect,
  TAKES_NO_PATHS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'

const DEFAULT_TIMEOUT_MS = 120_000
const MAXIMUM_TIMEOUT_MS = 600_000
const SIGKILL_GRACE_MS = 5_000
const MAXIMUM_OUTPUT_CHARACTERS = 30_000
const READ_GRACE_MS = 1_000

const inputSchema = z.strictObject({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  description: z.string().optional(),
})

const description = [
  'Run a command in a fresh bash process rooted at the workspace.',
  'State does not carry between calls: no directory change, shell variable or background job survives.',
  'stdout and stderr come back as one string, all of stdout first and then all of stderr, so the two are not interleaved.',
  'Only the tail is kept once the output grows past its cap.',
  'A non-zero exit is reported rather than raised, with the code named at the end.',
  `Times out after ${DEFAULT_TIMEOUT_MS} ms unless timeoutMs says otherwise, and never later than ${MAXIMUM_TIMEOUT_MS} ms.`,
  'Pass description to say in a few words what the command is for.',
].join(' ')

type Shell = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

type StartedShell = { ok: true; shell: Shell } | { ok: false; reason: string }

type Tail = { text: string; droppedLines: number; truncated: boolean }

type TailBuffer = { append: (chunk: string) => void; tail: () => Tail }

type Drain = { tail: () => Tail; stop: () => void; done: Promise<void> }

type ShellOutput = { stdout: Tail; stderr: Tail; exitCode: number }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const countLineBreaks = (text: string): number => text.split('\n').length - 1

function startShell(args: { command: string; cwd: string }): StartedShell {
  try {
    return {
      ok: true,
      shell: Bun.spawn({
        cmd: ['bash', '-c', args.command],
        cwd: args.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      }),
    }
  } catch (error) {
    return { ok: false, reason: `could not start a shell in ${args.cwd}: ${messageOf(error)}` }
  }
}

/**
 * setsid(2) makes the shell a process group leader, so a negative pid signals the whole group.
 * Signalling only the shell would strand every process it forked: those are reparented to init the
 * moment it dies, which puts them out of reach of any later kill.
 */
function signalGroup(args: { shell: Shell; signal: 'SIGTERM' | 'SIGKILL' }): void {
  try {
    process.kill(-args.shell.pid, args.signal)
  } catch {
    try {
      args.shell.kill(args.signal)
    } catch {
      return
    }
  }
}

function terminatorFor(shell: Shell): () => void {
  let fired = false

  return () => {
    if (fired) return
    fired = true
    signalGroup({ shell, signal: 'SIGTERM' })
    setTimeout(() => signalGroup({ shell, signal: 'SIGKILL' }), SIGKILL_GRACE_MS).unref()
  }
}

function tailBuffer(limit: number): TailBuffer {
  let text = ''
  let droppedLines = 0
  let truncated = false

  return {
    append: (chunk) => {
      text += chunk
      if (text.length <= limit) return

      const overflow = text.length - limit
      droppedLines += countLineBreaks(text.slice(0, overflow))
      text = text.slice(overflow)
      truncated = true
    },
    tail: () => ({ text, droppedLines, truncated }),
  }
}

function drain(stream: ReadableStream<Uint8Array>): Drain {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const buffer = tailBuffer(MAXIMUM_OUTPUT_CHARACTERS)

  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (value !== undefined) buffer.append(decoder.decode(value, { stream: true }))
    }
    buffer.append(decoder.decode())
  })()
  done.catch(() => undefined)

  return {
    tail: buffer.tail,
    stop: () => void reader.cancel().catch(() => undefined),
    done,
  }
}

async function withinReadGrace(reads: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, READ_GRACE_MS)
  })

  await Promise.race([reads.then(() => undefined).catch(() => undefined), grace])
  clearTimeout(timer)
}

/**
 * A process the shell forked inherits the stdout pipe, so the read side reaches EOF only once every
 * holder has exited - long after the shell itself was killed. Measured at 61 s for a `sleep 61` the
 * shell left behind under a 400 ms timeout.
 */
async function readShell(shell: Shell): Promise<ShellOutput> {
  const stdout = drain(shell.stdout)
  const stderr = drain(shell.stderr)

  const exitCode = await shell.exited
  await withinReadGrace(Promise.all([stdout.done, stderr.done]))
  stdout.stop()
  stderr.stop()

  return { stdout: stdout.tail(), stderr: stderr.tail(), exitCode }
}

function render(tail: Tail): string {
  if (!tail.truncated) return tail.text

  const firstBreak = tail.text.indexOf('\n')
  const kept = firstBreak === -1 ? tail.text : tail.text.slice(firstBreak + 1)
  const dropped = Math.max(tail.droppedLines + (firstBreak === -1 ? 0 : 1), 1)
  return `... [${dropped} lines truncated] ...\n\n${kept}`
}

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
}): string {
  const sections: string[] = []
  if (args.merged.length > 0) sections.push(args.merged)
  if (args.timedOut) sections.push(`The command was killed after exceeding its ${args.timeoutMs} ms timeout.`)
  if (args.exitCode !== 0) sections.push(`Exit code: ${args.exitCode}`)
  if (sections.length === 0) return 'The command completed with no output.'
  return sections.join('\n\n')
}

@injectable()
export class BashTool implements ToolDefinition {
  readonly name = 'bash'
  readonly description = description
  readonly effect = EToolEffect.Destructive
  readonly inputSchema = inputSchema
  readonly pathFields = TAKES_NO_PATHS

  constructor(@inject(WorkspaceRoot) private readonly root: string) {}
  async invoke({ input, signal }: ToolInvocation): Promise<ToolOutcome> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, reason: `bash was called with invalid input: ${z.prettifyError(parsed.error)}` }
    }
    if (signal.aborted) return { ok: false, reason: 'the turn was abandoned before the command started' }

    const { command, timeoutMs } = parsed.data
    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS)

    const started = startShell({ command, cwd: this.root })
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
      read = await readShell(shell)
    } catch (error) {
      return { ok: false, reason: `the command could not be read back: ${messageOf(error)}` }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', terminate)
    }

    if (signal.aborted && !timedOut) {
      return { ok: false, reason: 'the turn was abandoned while the command was running' }
    }

    const merged = mergeStreams({ stdout: read.stdout, stderr: read.stderr })

    return {
      ok: true,
      output: {
        command,
        description: parsed.data.description,
        exitCode: read.exitCode,
        stdout: render(read.stdout),
        stderr: render(read.stderr),
        truncated: merged.truncated,
        timedOut,
      },
      modelText: renderModelText({
        merged: render(merged),
        exitCode: read.exitCode,
        timedOut,
        timeoutMs: timeout,
      }),
    }
  }
}

export const createBashTool = ({ root }: { root: string }): ToolDefinition => new BashTool(root)
