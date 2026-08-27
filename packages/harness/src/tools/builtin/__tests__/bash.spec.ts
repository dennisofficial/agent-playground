import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import type { ToolOutcome } from '@dltech/atlas-core'

import { BunShellRegistry } from '../../../shells/shell-registry'
import { SystemClock } from '../../../store'
import { BashTool } from '../bash'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-bash-'))
})

const invoke = (input: unknown): Promise<ToolOutcome> =>
  new BashTool(root, new BunShellRegistry(root, new SystemClock())).invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'bash-1',
  })

const outputOf = (outcome: ToolOutcome): Record<string, unknown> => {
  if (!outcome.ok) throw new Error(`expected a successful outcome, got: ${outcome.reason}`)
  return outcome.output as Record<string, unknown>
}

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(() => true).catch(() => false)

const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('BashTool', () => {
  it('refuses input the schema does not accept', async () => {
    const outcome = await invoke({ command: '' })

    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.reason).toContain('bash was called with invalid input')
  })

  it('returns what a command printed and the zero it exited with', async () => {
    const outcome = await invoke({ command: 'echo hello; echo trouble >&2' })

    expect(outputOf(outcome)).toMatchObject({
      exitCode: 0,
      stdout: 'hello\n',
      stderr: 'trouble\n',
      truncated: false,
      timedOut: false,
    })
    expect(outcome.ok && outcome.modelText).toBe('hello\ntrouble')
  })

  it('runs the command in the workspace root it was given', async () => {
    await Bun.write(join(root, 'rooted.txt'), 'found by a relative path\n')

    const outcome = await invoke({ command: 'cat rooted.txt' })

    expect(outputOf(outcome).stdout).toBe('found by a relative path\n')
  })

  it('reports a non-zero exit rather than failing the call', async () => {
    const outcome = await invoke({ command: 'echo partial; exit 3' })

    expect(outputOf(outcome)).toMatchObject({ exitCode: 3, stdout: 'partial\n' })
    expect(outcome.ok && outcome.modelText).toBe('partial\n\nExit code: 3')
  })

  it('says so when a command produced nothing at all', async () => {
    const outcome = await invoke({ command: 'true' })

    expect(outcome.ok && outcome.modelText).toBe('The command completed with no output.')
  })

  it('kills the whole process group on timeout instead of waiting on what the shell forked', async () => {
    const marker = join(root, 'orphan-survived')
    const started = Date.now()

    const outcome = await invoke({
      command: `(sleep 2; touch ${marker}) & echo working; sleep 30`,
      timeoutMs: 300,
    })

    expect(outputOf(outcome).timedOut).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain('killed after exceeding its 300 ms timeout')
    expect(Date.now() - started).toBeLessThan(3_000)

    await after(3_000)
    expect(await exists(marker)).toBe(false)
  }, 15_000)

  it('keeps only the tail once the output passes its cap', async () => {
    const outcome = await invoke({
      command: 'for i in $(seq 1 4000); do echo "line-$i-padding-padding"; done',
    })

    const output = outputOf(outcome)
    expect(output).toMatchObject({ exitCode: 0, truncated: true })
    expect(String(output.stdout)).toContain('lines truncated')
    expect(String(output.stdout)).toContain('line-4000-padding-padding')
    expect(String(output.stdout)).not.toContain('line-1-padding-padding')
  })

  it('abandons a command, and says who stopped it, once the turn is interrupted', async () => {
    const controller = new AbortController()
    const outcome = new BashTool(root, new BunShellRegistry(root, new SystemClock())).invoke({
      input: { command: 'sleep 30' },
      signal: controller.signal,
      idempotencyKey: 'bash-2',
    })
    setTimeout(() => controller.abort(), 100)

    expect(await outcome).toEqual({
      ok: false,
      reason: 'the developer interrupted the turn while the command was running',
    })
  }, 15_000)
})
