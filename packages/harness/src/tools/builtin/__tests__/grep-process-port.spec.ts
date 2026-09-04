import { describe, expect, it } from 'bun:test'

import {
  toThreadId,
  type ProcessHandle,
  type ProcessPort,
  type SpawnCommand,
  type ThreadId,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { GrepTool } from '../grep'

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

class FakeProcesses implements ProcessPort {
  readonly spawned: SpawnCommand[] = []
  readonly probed: { command: string; threadId?: ThreadId | undefined }[] = []

  constructor(
    private readonly ripgrep: string | null,
    private readonly stdout = '',
    private readonly exitCode = 1,
  ) {}

  which(args: { command: string; threadId?: ThreadId | undefined }): string | null {
    this.probed.push(args)
    return args.command === 'rg' ? this.ripgrep : null
  }

  spawn(args: SpawnCommand): ProcessHandle {
    this.spawned.push(args)
    return {
      stdout: streamOf(this.stdout),
      stderr: streamOf(''),
      exited: Promise.resolve(this.exitCode),
      terminate: () => undefined,
    }
  }
}

const searchWith = (processes: FakeProcesses): Promise<ToolOutcome> =>
  new GrepTool(processes).invoke({
    input: { pattern: 'needle' },
    signal: new AbortController().signal,
    idempotencyKey: 'grep-process-port',
    projectDirectory: '/work',
    threadId: toThreadId('thread-1'),
  })

describe('GrepTool over a ProcessPort', () => {
  it('asks the port whether ripgrep exists and spawns the binary it names', async () => {
    const processes = new FakeProcesses('/container/bin/rg')

    const outcome = await searchWith(processes)

    expect(outcome.ok).toBe(true)
    expect(processes.spawned[0]?.cmd[0]).toBe('/container/bin/rg')
  })

  it('falls back to POSIX grep when the port has no ripgrep', async () => {
    const processes = new FakeProcesses(null)

    const outcome = await searchWith(processes)

    expect(outcome.ok).toBe(true)
    expect(processes.spawned[0]?.cmd[0]).toBe('grep')
  })

  it('reads the matches the spawned search printed', async () => {
    const processes = new FakeProcesses('/container/bin/rg', '/work/a.ts:2:const needle = 1\n', 0)

    const outcome = await searchWith(processes)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.output).toMatchObject({ matches: ['/work/a.ts:2:const needle = 1'], paths: ['/work/a.ts'] })
  })

  it('carries the calling thread onto the probe and the spawn, so a router can place both', async () => {
    const processes = new FakeProcesses('/container/bin/rg')

    const outcome = await searchWith(processes)

    expect(outcome.ok).toBe(true)
    expect(processes.spawned[0]?.threadId).toBe(toThreadId('thread-1'))
    expect(processes.probed[0]?.threadId).toBe(toThreadId('thread-1'))
  })
})
