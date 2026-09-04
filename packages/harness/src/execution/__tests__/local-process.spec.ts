import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readShell, startShell } from '../../shells/shell-process'
import { LocalProcessPort, SIGKILL_GRACE_MS } from '../local-process'

const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text()

type Reader = {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  releaseLock(): void
}

const awaitMarker = async (reader: Reader): Promise<void> => {
  const decoder = new TextDecoder()
  let seen = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    seen += decoder.decode(value, { stream: true })
    if (seen.includes('ready')) return
  }
}

const drainToEof = async (reader: Reader): Promise<void> => {
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

describe('LocalProcessPort', () => {
  it('produces the same stdout, stderr and exit code as startShell', async () => {
    const script = 'echo out; echo err >&2; exit 3'
    const cwd = await mkdtemp(join(tmpdir(), 'atlas-port-parity-'))
    try {
      const started = startShell({ command: script, cwd })
      if (!started.ok) throw new Error(started.reason)
      const expected = await readShell({ shell: started.shell, limit: 10_000 })

      const handle = new LocalProcessPort().spawn({ cmd: ['bash', '-c', script], cwd })
      const [stdout, stderr, exitCode] = await Promise.all([
        textOf(handle.stdout),
        textOf(handle.stderr),
        handle.exited,
      ])

      expect({ stdout, stderr, exitCode }).toEqual({
        stdout: expected.stdout.text,
        stderr: expected.stderr.text,
        exitCode: expected.exitCode,
      })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('reaches stdout EOF only once a forked process holding the pipe exits', async () => {
    const handle = new LocalProcessPort().spawn({
      cmd: ['bash', '-c', '(trap "" TERM; echo ready; exec sleep 2) & exit 0'],
      cwd: '/tmp',
    })
    const reader = handle.stdout.getReader()
    await awaitMarker(reader)

    const beganAt = Date.now()
    handle.terminate()
    await handle.exited
    await drainToEof(reader)

    expect(Date.now() - beganAt).toBeGreaterThanOrEqual(1_500)
  }, 10_000)

  it('escalates to SIGKILL after the grace when SIGTERM is ignored', async () => {
    const handle = new LocalProcessPort().spawn({
      cmd: ['bash', '-c', 'trap "" TERM; echo ready; exec sleep 30'],
      cwd: '/tmp',
    })
    const reader = handle.stdout.getReader()
    await awaitMarker(reader)
    reader.releaseLock()

    const beganAt = Date.now()
    handle.terminate()
    const exitCode = await handle.exited

    expect(exitCode).toBe(137)
    expect(Date.now() - beganAt).toBeGreaterThanOrEqual(SIGKILL_GRACE_MS)
  }, 15_000)

  it('terminates idempotently under repeated calls', async () => {
    const handle = new LocalProcessPort().spawn({ cmd: ['sleep', '30'], cwd: '/tmp' })

    handle.terminate()
    handle.terminate()
    handle.terminate()
    const exitCode = await handle.exited
    handle.terminate()

    expect(exitCode).toBe(143)
  })

  it('locates sh on the path and misses an unknown command', () => {
    const port = new LocalProcessPort()

    expect(port.which({ command: 'sh' })).toEndWith('/sh')
    expect(port.which({ command: 'atlas-no-such-command' })).toBeNull()
  })

  it('passes env through, and inherits the process environment without it', async () => {
    const port = new LocalProcessPort()

    const forwarded = port.spawn({
      cmd: ['bash', '-c', 'echo "$PORT_MARKER"'],
      cwd: '/tmp',
      env: { ...process.env, PORT_MARKER: 'forwarded' },
    })
    expect(await textOf(forwarded.stdout)).toBe('forwarded\n')
    expect(await forwarded.exited).toBe(0)

    const inherited = port.spawn({ cmd: ['bash', '-c', 'echo "$HOME"'], cwd: '/tmp' })
    expect((await textOf(inherited.stdout)).length).toBeGreaterThan(1)
    expect(await inherited.exited).toBe(0)
  })
})
