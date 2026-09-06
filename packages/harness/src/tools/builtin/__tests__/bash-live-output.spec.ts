import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { toThreadId, type ToolOutputChunk, type ToolOutcome } from '@dltech/atlas-core'

import { HookChain } from '../../../hooks/registry'
import { BunShellRegistry } from '../../../shells/shell-registry'
import { SystemClock } from '../../../store'
import { BashTool } from '../bash'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-bash-live-'))
})

const invoke = (args: {
  command: string
  onOutput?: ((chunk: ToolOutputChunk) => void) | undefined
}): Promise<ToolOutcome> =>
  new BashTool(new BunShellRegistry(root, new SystemClock(), () => new HookChain({}))).invoke({
    input: { command: args.command, description: 'Exercise the shell' },
    signal: new AbortController().signal,
    idempotencyKey: 'bash-live-1',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
    ...(args.onOutput === undefined ? {} : { onOutput: args.onOutput }),
  })

describe('a foreground bash call with an output listener', () => {
  it('streams both pipes as they print, while the outcome still carries the tails', async () => {
    const chunks: ToolOutputChunk[] = []

    const outcome = await invoke({
      command: `printf 'one\\n'; sleep 0.2; printf 'two\\n'; printf 'err\\n' >&2`,
      onOutput: (chunk) => chunks.push(chunk),
    })

    if (!outcome.ok) throw new Error(`expected a successful outcome, got: ${outcome.reason}`)
    const output = outcome.output as { stdout: string; stderr: string; exitCode: number }
    expect(output).toMatchObject({ exitCode: 0, stdout: 'one\ntwo\n', stderr: 'err\n' })

    const streamed = (stream: ToolOutputChunk['stream']): string =>
      chunks.flatMap((chunk) => (chunk.stream === stream ? [chunk.text] : [])).join('')
    expect(streamed('stdout')).toBe('one\ntwo\n')
    expect(streamed('stderr')).toBe('err\n')
    expect(chunks.length).toBeGreaterThanOrEqual(3)
  })

  it('streams nothing for a call that the pre-flight checks refuse', async () => {
    const chunks: ToolOutputChunk[] = []

    const outcome = await invoke({ command: 'true', onOutput: (chunk) => chunks.push(chunk) })

    expect(outcome.ok).toBe(false)
    expect(chunks).toEqual([])
  })
})
