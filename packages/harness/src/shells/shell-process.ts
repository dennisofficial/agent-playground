export const SIGKILL_GRACE_MS = 5_000

const READ_GRACE_MS = 1_000

export type Shell = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

export type StartedShell = { ok: true; shell: Shell } | { ok: false; reason: string }

export type Tail = { text: string; droppedLines: number; truncated: boolean }

export type TailBuffer = { append: (chunk: string) => void; tail: () => Tail }

export type Drain = { stop: () => void; done: Promise<void> }

export type ShellOutput = { stdout: Tail; stderr: Tail; exitCode: number }

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const countLineBreaks = (text: string): number => text.split('\n').length - 1

export function startShell(args: { command: string; cwd: string }): StartedShell {
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
export function signalGroup(args: { shell: Shell; signal: 'SIGTERM' | 'SIGKILL' }): void {
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

export function terminatorFor(shell: Shell): () => void {
  let fired = false

  return () => {
    if (fired) return
    fired = true
    signalGroup({ shell, signal: 'SIGTERM' })
    setTimeout(() => signalGroup({ shell, signal: 'SIGKILL' }), SIGKILL_GRACE_MS).unref()
  }
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

export type CwdProbe = {
  command: string
  settled: () => Promise<string | undefined>
  discard: () => Promise<void>
}

/**
 * bash leaves a `$?` of its own behind once the trailer runs, so the user's exit code is captured
 * before anything else touches it and re-raised at the end. A command that calls `exit` itself, or
 * dies under `set -e`, never reaches the trailer - the probe then reports nothing and the caller
 * keeps the directory it started in.
 */
export function probeCwd(args: { command: string; probeFile: string }): CwdProbe {
  const quoted = `'${args.probeFile.replaceAll("'", `'\\''`)}'`

  return {
    command: [
      args.command,
      '__atlas_exit=$?',
      `pwd -P > ${quoted} 2>/dev/null`,
      'exit $__atlas_exit',
    ].join('\n'),

    settled: async () => {
      try {
        const text = (await Bun.file(args.probeFile).text()).trim()
        return text.length > 0 ? text : undefined
      } catch {
        return undefined
      }
    },

    discard: async () => {
      try {
        await Bun.file(args.probeFile).delete()
      } catch {
        return
      }
    },
  }
}
