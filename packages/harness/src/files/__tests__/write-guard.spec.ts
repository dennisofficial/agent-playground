import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { toThreadId, type ThreadId, type ToolOutcome } from '@dltech/atlas-core'

import { EditTool } from '../../tools/builtin/edit'
import { WriteTool } from '../../tools/builtin/write'
import { digestOf } from '../digest'
import { InMemoryFileReadState, type FileView } from '../read-state'
import { SerializedWrites, VerifyingWriteGuard } from '../write-guard'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-write-guard-'))
})

const parent = toThreadId('thread-parent')
const child = toThreadId('thread-child')

const fileHolding = async ({ name, text }: { name: string; text: string }): Promise<string> => {
  const path = join(root, name)
  await writeFile(path, text)
  return path
}

const viewNow = async ({
  path,
  wholeFile,
}: {
  path: string
  wholeFile: boolean
}): Promise<FileView> => {
  const stats = await stat(path)
  const digest = await digestOf({ path })
  if (digest === undefined) throw new Error(`could not digest ${path}`)

  return { mtimeMs: stats.mtimeMs, size: stats.size, wholeFile, digest }
}

const invoke = (tool: EditTool | WriteTool, input: unknown, threadId: ThreadId): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'write-guard',
    sessionDirectory: root,
    threadId,
  })

const reasonOf = (outcome: ToolOutcome): string => (outcome.ok ? '' : outcome.reason)

describe('two edits of one file landing at the same time', () => {
  it('applies both, because the lock makes each read-modify-write indivisible', async () => {
    const path = await fileHolding({ name: 'two-edits.ts', text: 'alpha\nbeta\n' })
    const tool = new EditTool(new SerializedWrites())

    const [first, second] = await Promise.all([
      invoke(tool, { path, oldString: 'alpha', newString: 'ALPHA' }, parent),
      invoke(tool, { path, oldString: 'beta', newString: 'BETA' }, child),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('ALPHA\nBETA\n')
  })

  it('serializes many writers to one file without losing any of them', async () => {
    const path = await fileHolding({ name: 'many-edits.ts', text: 'l0\nl1\nl2\nl3\nl4\nl5\n' })
    const tool = new EditTool(new SerializedWrites())

    const outcomes = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((n) =>
        invoke(tool, { path, oldString: `l${n}`, newString: `L${n}` }, parent),
      ),
    )

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('L0\nL1\nL2\nL3\nL4\nL5\n')
  })
})

describe('two threads writing one file they have both read', () => {
  it('lets the first through and refuses the second rather than clobbering it', async () => {
    const path = await fileHolding({ name: 'contested.ts', text: 'original\n' })
    const seen = new InMemoryFileReadState()
    const asBothSawIt = await viewNow({ path, wholeFile: true })
    seen.record({ threadId: parent, path, view: asBothSawIt })
    seen.record({ threadId: child, path, view: asBothSawIt })

    const tool = new WriteTool(new VerifyingWriteGuard(seen))

    const outcomes = await Promise.all([
      invoke(tool, { path, content: 'parent wrote this\n' }, parent),
      invoke(tool, { path, content: 'child wrote this\n' }, child),
    ])

    const winners = outcomes.filter((outcome) => outcome.ok)
    const losers = outcomes.filter((outcome) => !outcome.ok)

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(reasonOf(losers[0] as ToolOutcome)).toContain('read it again')

    const landed = await readFile(path, 'utf8')
    expect(['parent wrote this\n', 'child wrote this\n']).toContain(landed)
  })

  it('names the file in the refusal, so the model knows what to re-read', async () => {
    const path = await fileHolding({ name: 'named-in-refusal.ts', text: 'original\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: await viewNow({ path, wholeFile: true }) })

    await writeFile(path, 'somebody else got here first\n')

    const outcome = await invoke(
      new WriteTool(new VerifyingWriteGuard(seen)),
      { path, content: 'too late\n' },
      parent,
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain(path)
    expect(reasonOf(outcome)).toContain('read it again')
  })

  it('leaves the file exactly as the winner left it', async () => {
    const path = await fileHolding({ name: 'untouched-by-loser.ts', text: 'original\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: await viewNow({ path, wholeFile: true }) })

    await writeFile(path, 'the winner\n')

    await invoke(new WriteTool(new VerifyingWriteGuard(seen)), { path, content: 'the loser\n' }, parent)

    expect(await readFile(path, 'utf8')).toBe('the winner\n')
  })
})

describe('a write nothing has read', () => {
  it('goes through, because the guard has no view to contradict it', async () => {
    const path = join(root, 'never-read.ts')
    const seen = new InMemoryFileReadState()

    const outcome = await invoke(
      new WriteTool(new VerifyingWriteGuard(seen)),
      { path, content: 'brand new\n' },
      parent,
    )

    expect(outcome.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('brand new\n')
  })
})

describe('two threads editing a file neither has read', () => {
  it('keeps both edits, because the lock covers what the guard has no view to judge', async () => {
    const path = await fileHolding({ name: 'blind-edits.ts', text: 'alpha\nbeta\n' })
    const tool = new EditTool(new VerifyingWriteGuard(new InMemoryFileReadState()))

    const outcomes = await Promise.all([
      invoke(tool, { path, oldString: 'alpha', newString: 'ALPHA' }, parent),
      invoke(tool, { path, oldString: 'beta', newString: 'BETA' }, child),
    ])

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('ALPHA\nBETA\n')
  })
})

describe('a file whose bytes changed behind an unchanged mtime and size', () => {
  it('is refused, which mtime and size alone would have waved through', async () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const path = await fileHolding({ name: 'same-tick.ts', text: 'export const a = 1\n' })
    await utimes(path, fixed, fixed)

    const seen = new InMemoryFileReadState()
    const asRead = await viewNow({ path, wholeFile: true })
    seen.record({ threadId: parent, path, view: asRead })

    await writeFile(path, 'export const a = 9\n')
    await utimes(path, fixed, fixed)

    const now = await stat(path)
    expect(now.mtimeMs).toBe(asRead.mtimeMs)
    expect(now.size).toBe(asRead.size)

    const outcome = await invoke(
      new WriteTool(new VerifyingWriteGuard(seen)),
      { path, content: 'clobber\n' },
      parent,
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain('read it again')
    expect(await readFile(path, 'utf8')).toBe('export const a = 9\n')
  })
})
