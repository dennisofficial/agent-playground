import { describe, expect, it } from 'bun:test'

import type { ProcessHandle, ProcessPort } from '../process.port'

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text()

const fakeProcesses = (): ProcessPort => ({
  spawn: ({ cmd }) => {
    let terminated = false
    const handle: ProcessHandle = {
      stdout: streamOf(`ran ${cmd.join(' ')}`),
      stderr: streamOf(''),
      exited: Promise.resolve(0),
      terminate: () => {
        terminated = true
      },
    }
    expect('pid' in handle).toBe(false)
    void terminated
    return handle
  },
  which: ({ command }) => (command === 'sh' ? '/bin/sh' : null),
})

describe('ProcessPort', () => {
  it('spawns a handle that streams stdout and resolves an exit code', async () => {
    const handle = fakeProcesses().spawn({ cmd: ['sh', '-c', 'true'], cwd: '/tmp' })

    expect(await textOf(handle.stdout)).toBe('ran sh -c true')
    expect(await textOf(handle.stderr)).toBe('')
    expect(await handle.exited).toBe(0)
  })

  it('stops a process through terminate rather than a pid', () => {
    let calls = 0
    const port = fakeProcesses()
    const handle = port.spawn({ cmd: ['sleep', '30'], cwd: '/tmp' })
    const original = handle.terminate
    handle.terminate = () => {
      calls += 1
      original()
    }

    handle.terminate()

    expect(calls).toBe(1)
  })

  it('locates a command on the path and misses an unknown one', () => {
    const port = fakeProcesses()

    expect(port.which({ command: 'sh' })).toBe('/bin/sh')
    expect(port.which({ command: 'no-such-command' })).toBeNull()
  })
})
