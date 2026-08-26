import { z } from 'zod'

import { EToolEffect, type ToolDefinition, type ToolOutcome } from '@dltech/atlas-core'

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
  'stdout and stderr come back merged, oldest line first, capped to the tail of the output.',
  'A non-zero exit is reported rather than raised, with the code named at the end.',
  `Times out after ${DEFAULT_TIMEOUT_MS} ms unless timeoutMs says otherwise, and never later than ${MAXIMUM_TIMEOUT_MS} ms.`,
].join(' ')

type Shell = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

type StartedShell = { ok: true; shell: Shell } | { ok: false; reason: string }

type CappedText = { text: string; truncated: boolean }

type Drain = { collected: () => string; stop: () => void; done: Promise<void> }

type ShellOutput = { stdout: string; stderr: string; exitCode: number }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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
 * Spawned detached, so setsid(2) makes the shell a process group leader and a negative pid signals
 * the whole group. Signalling only the shell would strand every process it forked: those are
 * reparented to init the moment it dies, which puts them out of reach of any later kill.
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

function terminate(shell: Shell): void {
  signalGroup({ shell, signal: 'SIGTERM' })
  setTimeout(() => signalGroup({ shell, signal: 'SIGKILL' }), SIGKILL_GRACE_MS).unref()
}

function drain(stream: ReadableStream<Uint8Array>): Drain {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let collected = ''

  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (value !== undefined) collected += decoder.decode(value, { stream: true })
    }
    collected += decoder.decode()
  })()
  done.catch(() => undefined)

  return {
    collected: () => collected,
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
 * holder has exited - long after the shell itself was killed. The streams are therefore abandoned a
 * short while after the shell exits rather than read to completion.
 */
async function readShell(shell: Shell): Promise<ShellOutput> {
  const stdout = drain(shell.stdout)
  const stderr = drain(shell.stderr)

  const exitCode = await shell.exited
  await withinReadGrace(Promise.all([stdout.done, stderr.done]))
  stdout.stop()
  stderr.stop()

  return { stdout: stdout.collected(), stderr: stderr.collected(), exitCode }
}

function capToTail(text: string): CappedText {
  if (text.length <= MAXIMUM_OUTPUT_CHARACTERS) return { text, truncated: false }

  const tail = text.slice(-MAXIMUM_OUTPUT_CHARACTERS)
  const firstBreak = tail.indexOf('\n')
  const kept = firstBreak === -1 ? tail : tail.slice(firstBreak + 1)
  const droppedLines = text.slice(0, text.length - kept.length).split('\n').length - 1
  return {
    text: `... [${Math.max(droppedLines, 1)} lines truncated] ...\n\n${kept}`,
    truncated: true,
  }
}

function mergeStreams(args: { stdout: string; stderr: string }): string {
  return [args.stdout, args.stderr]
    .map((stream) => stream.replace(/\n+$/, ''))
    .filter((stream) => stream.length > 0)
    .join('\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .trimEnd()
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

export function createBashTool(args: { root: string }): ToolDefinition {
  return {
    name: 'bash',
    description,
    effect: EToolEffect.Destructive,
    inputSchema,
    invoke: async ({ input, signal }): Promise<ToolOutcome> => {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, reason: `bash was called with invalid input: ${z.prettifyError(parsed.error)}` }
      }
      if (signal.aborted) return { ok: false, reason: 'the turn was abandoned before the command started' }

      const { command, timeoutMs } = parsed.data
      const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAXIMUM_TIMEOUT_MS)

      const started = startShell({ command, cwd: args.root })
      if (!started.ok) return started

      const { shell } = started
      let timedOut = false
      const deadline = setTimeout(() => {
        timedOut = true
        terminate(shell)
      }, timeout)
      const handleAbort = (): void => terminate(shell)
      signal.addEventListener('abort', handleAbort, { once: true })

      let read: ShellOutput
      try {
        read = await readShell(shell)
      } catch (error) {
        return { ok: false, reason: `the command could not be read back: ${messageOf(error)}` }
      } finally {
        clearTimeout(deadline)
        signal.removeEventListener('abort', handleAbort)
      }
      const { stdout, stderr, exitCode } = read

      if (signal.aborted && !timedOut) {
        return { ok: false, reason: 'the turn was abandoned while the command was running' }
      }

      const merged = capToTail(mergeStreams({ stdout, stderr }))
      const cappedStdout = capToTail(stdout)
      const cappedStderr = capToTail(stderr)

      return {
        ok: true,
        output: {
          command,
          exitCode,
          stdout: cappedStdout.text,
          stderr: cappedStderr.text,
          truncated: merged.truncated || cappedStdout.truncated || cappedStderr.truncated,
          timedOut,
        },
        modelText: renderModelText({ merged: merged.text, exitCode, timedOut, timeoutMs: timeout }),
      }
    },
  }
}
