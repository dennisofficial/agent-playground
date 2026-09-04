import type { ProcessHandle, ProcessPort, ThreadId } from '@dltech/atlas-core'

import { LocalProcessPort } from '../execution/local-process'
import { atlasBinDirectory } from '../store/paths'

export { SIGKILL_GRACE_MS, signalGroup, type Signalable } from '../execution/local-process'

const READ_GRACE_MS = 1_000

const localProcesses = new LocalProcessPort()

const withAtlasBinOnPath = (): Record<string, string | undefined> => ({
  ...process.env,
  PATH: `${atlasBinDirectory()}:${process.env.PATH ?? ''}`,
})

export type Shell = ProcessHandle & { readonly pid?: number | undefined }

export type StartedShell = { ok: true; shell: Shell } | { ok: false; reason: string }

export type Tail = { text: string; droppedLines: number; truncated: boolean }

export type TailBuffer = { append: (chunk: string) => void; tail: () => Tail }

export type Drain = { stop: () => void; done: Promise<void> }

export type ShellOutput = { stdout: Tail; stderr: Tail; exitCode: number }

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const countLineBreaks = (text: string): number => text.split('\n').length - 1

export function startShell(args: {
  command: string
  cwd: string
  processes?: ProcessPort | undefined
  threadId?: ThreadId | undefined
}): StartedShell {
  const processes = args.processes ?? localProcesses
  try {
    return {
      ok: true,
      shell: processes.spawn({
        cmd: ['bash', '-c', args.command],
        cwd: args.cwd,
        env: withAtlasBinOnPath(),
        threadId: args.threadId,
      }),
    }
  } catch (error) {
    return { ok: false, reason: `could not start a shell in ${args.cwd}: ${messageOf(error)}` }
  }
}

export function terminatorFor(shell: Shell): () => void {
  return () => shell.terminate()
}

export function tailBuffer(limit: number): TailBuffer {
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

export function drainInto(args: {
  stream: ReadableStream<Uint8Array>
  append: (chunk: string) => void
}): Drain {
  const reader = args.stream.getReader()
  const decoder = new TextDecoder()

  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (value !== undefined) args.append(decoder.decode(value, { stream: true }))
    }
    args.append(decoder.decode())
  })()
  done.catch(() => undefined)

  return {
    stop: () => void reader.cancel().catch(() => undefined),
    done,
  }
}

export function drainTail(args: { stream: ReadableStream<Uint8Array>; limit: number }): Drain & {
  tail: () => Tail
} {
  const buffer = tailBuffer(args.limit)
  return { ...drainInto({ stream: args.stream, append: buffer.append }), tail: buffer.tail }
}

export async function withinReadGrace(reads: Promise<unknown>): Promise<void> {
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
export async function readShell(args: { shell: Shell; limit: number }): Promise<ShellOutput> {
  const stdout = drainTail({ stream: args.shell.stdout, limit: args.limit })
  const stderr = drainTail({ stream: args.shell.stderr, limit: args.limit })

  const exitCode = await args.shell.exited
  await withinReadGrace(Promise.all([stdout.done, stderr.done]))
  stdout.stop()
  stderr.stop()

  return { stdout: stdout.tail(), stderr: stderr.tail(), exitCode }
}

export function render(tail: Tail): string {
  if (!tail.truncated) return tail.text

  const firstBreak = tail.text.indexOf('\n')
  const kept = firstBreak === -1 ? tail.text : tail.text.slice(firstBreak + 1)
  const dropped = Math.max(tail.droppedLines + (firstBreak === -1 ? 0 : 1), 1)
  return `... [${dropped} lines truncated] ...\n\n${kept}`
}

