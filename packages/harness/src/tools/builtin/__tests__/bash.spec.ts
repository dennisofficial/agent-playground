import { toThreadId } from '@dltech/atlas-core'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import type { ToolOutcome } from '@dltech/atlas-core'

import { HookChain } from '../../../hooks/registry'
import { BunShellRegistry } from '../../../shells/shell-registry'
import { SystemClock } from '../../../store'
import { BashTool } from '../bash'

const noHooks = () => new HookChain({})

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-bash-'))
})

const submit = (input: unknown): Promise<ToolOutcome> =>
  new BashTool(new BunShellRegistry(root, new SystemClock(), noHooks)).invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'bash-1',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const invoke = (input: Record<string, unknown>): Promise<ToolOutcome> =>
  submit({ description: 'Exercise the shell', ...input })

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

  it('refuses a command that arrives without a name', async () => {
    const outcome = await submit({ command: 'echo unnamed' })

    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.reason).toContain('description')
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

  it('keeps the tail of both streams when each on its own would fill the cap', async () => {
    const outcome = await invoke({
      command: [
        'for i in $(seq 1 4000); do echo "out-$i-padding-padding"; done',
        'for i in $(seq 1 4000); do echo "err-$i-padding-padding" >&2; done',
      ].join('; '),
    })

    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.modelText).toContain('out-4000-padding-padding')
    expect(outcome.modelText).toContain('err-4000-padding-padding')
    expect(outcome.modelText).not.toContain('out-1-padding-padding')
    expect(outputOf(outcome).truncated).toBe(true)
  })

  it('says the command may want a background shell when it runs out of time', async () => {
    const outcome = await invoke({ command: 'sleep 30', timeoutMs: 400 })

    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.modelText).toContain('runInBackground')
  }, 15_000)

  it('abandons a command, and says who stopped it, once the turn is interrupted', async () => {
    const controller = new AbortController()
    const outcome = new BashTool(new BunShellRegistry(root, new SystemClock(), noHooks)).invoke({
      input: { command: 'sleep 30', description: 'Idle for a while' },
      signal: controller.signal,
      idempotencyKey: 'bash-2',
      projectDirectory: root,
      threadId: toThreadId('thread-1'),
    })
    setTimeout(() => controller.abort(), 100)

    expect(await outcome).toEqual({
      ok: false,
      reason: 'the developer interrupted the turn while the command was running',
    })
  }, 15_000)
})

describe('choosing where the command runs', () => {
  it('runs in the directory workdir names', async () => {
    const nested = join(root, 'nested')
    await invoke({ command: `mkdir -p ${nested}` })

    const outcome = await invoke({ command: 'pwd', workdir: nested })

    expect(await realpath((outputOf(outcome).stdout as string).trim())).toBe(await realpath(nested))
  })

  it('starts at the project directory when workdir is left out', async () => {
    const outcome = await invoke({ command: 'pwd' })

    expect(await realpath((outputOf(outcome).stdout as string).trim())).toBe(await realpath(root))
  })

  it('lets a cd move only the command that ran it, never the call that follows', async () => {
    const nested = join(root, 'nested')
    await invoke({ command: `mkdir -p ${nested}` })
    await invoke({ command: 'cd nested && pwd' })

    const outcome = await invoke({ command: 'pwd' })

    expect(await realpath((outputOf(outcome).stdout as string).trim())).toBe(await realpath(root))
  })

  it('starts where it is told rather than at the project root', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'atlas-elsewhere-'))

    const outcome = await new BashTool(new BunShellRegistry(root, new SystemClock(), noHooks)).invoke({
      input: { command: 'pwd', description: 'Print the working directory' },
      signal: new AbortController().signal,
      idempotencyKey: 'bash-elsewhere',
      projectDirectory: elsewhere,
      threadId: toThreadId('thread-1'),
    })

    expect(await realpath((outputOf(outcome).stdout as string).trim())).toBe(await realpath(elsewhere))
  })

  it('names the missing directory rather than blaming the shell', async () => {
    const outcome = await invoke({ command: 'pwd', workdir: join(root, 'nowhere') })

    expect(outcome).toEqual({
      ok: false,
      reason: `workdir ${join(root, 'nowhere')} does not exist, so there is nowhere to run the command`,
    })
  })

  it('refuses a workdir that names a file rather than a directory', async () => {
    const file = join(root, 'not-a-directory.txt')
    await invoke({ command: `echo hi > ${file}` })

    const outcome = await invoke({ command: 'pwd', workdir: file })

    expect(outcome).toEqual({ ok: false, reason: `workdir ${file} is a file, not a directory` })
  })

  it('keeps the exit code of a command that also moved', async () => {
    const outcome = await invoke({ command: 'cd nested && exit 3' })

    expect(outputOf(outcome).exitCode).toBe(3)
  })
})

describe('refusing to idle', () => {
  it('names both ways out of a poll loop that has no end', async () => {
    const outcome = await invoke({ command: 'while true; do gh pr checks 272; sleep 30; done' })

    expect(outcome.ok).toBe(false)
    const reason = !outcome.ok ? outcome.reason : ''
    expect(reason).toContain('this loop has no end')
    expect(reason).toContain('runInBackground')
    expect(reason).toContain('gh run watch --exit-status')
    expect(reason).not.toContain('end the turn and be woken')
  })

  it('counts the trips a bounded poll loop would make before it names them', async () => {
    const outcome = await invoke({
      command: 'for i in $(seq 1 60); do gh api runs; sleep 20; done',
      timeoutMs: 600_000,
    })

    expect(outcome.ok).toBe(false)
    const reason = !outcome.ok ? outcome.reason : ''
    expect(reason).toContain('600 seconds asleep across 60 iterations')
    expect(reason).toContain('runInBackground')
    expect(reason).toContain('gh pr checks --watch')
  })

  it('still refuses a plain long sleep, and still points somewhere', async () => {
    const outcome = await invoke({ command: 'sleep 90' })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('90 seconds asleep')
  })
})

describe('watching a background shell', () => {
  it('refuses a watch on a foreground command, and says what it needs', async () => {
    const outcome = await invoke({ command: 'echo hi', watch: 'ERROR' })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('runInBackground')
  })

  it('refuses a pattern that is not a regular expression, before anything starts', async () => {
    const outcome = await invoke({
      command: 'echo hi',
      runInBackground: true,
      watch: '(unclosed',
    })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('not a regular expression')
  })

  it('starts a watched shell and says what the watch will and will not do', async () => {
    const outcome = await invoke({
      command: 'sleep 30',
      runInBackground: true,
      watch: 'ERROR|FAILED',
    })

    expect(outputOf(outcome)).toMatchObject({ watch: 'ERROR|FAILED' })
    expect(outcome.ok && outcome.modelText).toContain('Lines matching ERROR|FAILED')
    expect(outcome.ok && outcome.modelText).toContain('neither consumes nor is consumed')
  })
})

describe('giving a background shell a ceiling', () => {
  it('takes timeoutMs rather than refusing it', async () => {
    const outcome = await invoke({ command: 'sleep 30', runInBackground: true, timeoutMs: 5_000 })

    expect(outputOf(outcome)).toMatchObject({ timeoutMs: 5_000 })
    expect(outcome.ok && outcome.modelText).toContain('killed if it outlives 5000 ms')
  })

  it('says a background shell outlives an interrupt, so nothing needs detaching', async () => {
    const outcome = await invoke({ command: 'sleep 30', runInBackground: true })

    expect(outcome.ok && outcome.modelText).toContain('outlives an interrupt')
    expect(outcome.ok && outcome.modelText).toContain('nohup')
  })
})

describe('what the tool tells the model about watching', () => {
  it('warns that a watch on the success marker alone is silent through a crash', () => {
    const { description } = new BashTool(new BunShellRegistry(root, new SystemClock(), noHooks))

    expect(description).toContain('silence from a watch is indistinguishable from progress')
    expect(description).toContain('widen the alternation rather than narrow it')
    expect(description).toContain('Traceback')
  })
})
