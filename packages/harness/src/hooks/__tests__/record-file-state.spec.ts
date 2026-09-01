import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  toCallId,
  toThreadId,
  type ThreadId,
  type ToolCall,
  type ToolDeclaration,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { digestOf } from '../../files/digest'
import { InMemoryFileReadState, type FileView } from '../../files/read-state'
import { ABSENT, inputFieldOf } from '../../tools/declared-paths'
import { createRecordFileStateHook } from '../record-file-state'

const NEVER_ABORTED = new AbortController().signal

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-record-file-state-'))
})

const absoluteField = (content: EContentAccess) => ({
  field: 'path',
  presence: EPathPresence.Required,
  form: EPathForm.Absolute,
  content,
})

const reader: ToolDeclaration = {
  name: 'read',
  description: 'reads a file, whole or windowed',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.Reads)],
  revealsWholeFile: ({ input }) =>
    inputFieldOf({ input, field: 'offset' }) === ABSENT &&
    inputFieldOf({ input, field: 'limit' }) === ABSENT,
}

const silentReader: ToolDeclaration = {
  name: 'peek',
  description: 'reads a file but never said how much of it it shows',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.Reads)],
}

const searcher: ToolDeclaration = {
  name: 'grep',
  description: 'searches a directory without revealing any file in full',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.None)],
}

const writer: ToolDeclaration = {
  name: 'write',
  description: 'replaces a file wholesale',
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.Overwrites)],
}

const editor: ToolDeclaration = {
  name: 'edit',
  description: 'replaces one substring of a file',
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.Amends)],
}

const copier: ToolDeclaration = {
  name: 'copy',
  description: 'reads one path and writes another it never shows',
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string(), into: z.string() }),
  pathFields: [
    absoluteField(EContentAccess.Reads),
    { field: 'into', presence: EPathPresence.Required, form: EPathForm.Absolute, content: EContentAccess.None },
  ],
}

const lineSearcher: ToolDeclaration = {
  name: 'rg',
  description: 'searches a directory and names the files it showed lines of',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [absoluteField(EContentAccess.None)],
  revealsLinesOf: ({ output }) =>
    Array.isArray(output) ? output.filter((path): path is string => typeof path === 'string') : [],
}

const tools: readonly ToolDeclaration[] = [
  reader,
  silentReader,
  searcher,
  lineSearcher,
  writer,
  editor,
  copier,
]

const succeeded: ToolOutcome = { ok: true, output: null, modelText: 'done' }

const showing = (paths: readonly string[]): ToolOutcome => ({
  ok: true,
  output: paths,
  modelText: 'matches',
})

const parent = toThreadId('thread-parent')
const child = toThreadId('thread-child')

const callTo = ({
  name,
  input,
  threadId,
}: {
  name: string
  input: unknown
  threadId: ThreadId
}): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: EToolEffect.Read,
  threadId,
})

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

const fileHolding = async ({ name, content }: { name: string; content: string }): Promise<string> => {
  const path = join(root, name)
  await writeFile(path, content)
  return path
}

const recordFor = async ({
  name,
  input,
  result = succeeded,
  seen = new InMemoryFileReadState(),
  threadId = parent,
}: {
  name: string
  input: unknown
  result?: ToolOutcome
  seen?: InMemoryFileReadState
  threadId?: ThreadId
}) => {
  const outcome = await createRecordFileStateHook({ seen, tools }).run({
    call: callTo({ name, input, threadId }),
    result, signal: NEVER_ABORTED })

  return { outcome, seen }
}

describe('createRecordFileStateHook', () => {
  it('records a whole-file view for a read that asked for neither offset nor limit', async () => {
    const path = await fileHolding({ name: 'whole.ts', content: 'export const a = 1\n' })
    const { seen } = await recordFor({ name: 'read', input: { path } })
    const stats = await stat(path)

    expect(seen.viewOf({ threadId: parent, path })).toEqual(await viewNow({ path, wholeFile: true }))
  })

  it('records a partial view for a read that asked for an offset', async () => {
    const path = await fileHolding({ name: 'windowed.ts', content: 'a\nb\nc\n' })
    const { seen } = await recordFor({ name: 'read', input: { path, offset: 2 } })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(false)
  })

  it('records a partial view for a reader that declares no whole-file predicate', async () => {
    const path = await fileHolding({ name: 'peeked.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'peek', input: { path } })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(false)
  })

  it('records nothing when the tool failed', async () => {
    const path = await fileHolding({ name: 'failed.ts', content: 'a\n' })
    const { seen } = await recordFor({
      name: 'read',
      input: { path },
      result: { ok: false, reason: 'nope' },
    })

    expect(seen.viewOf({ threadId: parent, path })).toBeUndefined()
  })

  it('leaves an existing view exactly as it was when the tool failed', async () => {
    const path = await fileHolding({ name: 'stale-stands.ts', content: 'a\n' })
    const standing = { mtimeMs: 1, size: 2, wholeFile: false, digest: 'stale' }
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: standing })

    await recordFor({ name: 'write', input: { path }, result: { ok: false, reason: 'nope' }, seen })

    expect(seen.viewOf({ threadId: parent, path })).toEqual(standing)
  })

  it('records nothing for a field that never reveals content', async () => {
    const path = await fileHolding({ name: 'searched.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'grep', input: { path } })

    expect(seen.viewOf({ threadId: parent, path })).toBeUndefined()
  })

  it('records nothing for a tool it has no declaration for', async () => {
    const path = await fileHolding({ name: 'unregistered.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'some-mcp-tool', input: { path } })

    expect(seen.viewOf({ threadId: parent, path })).toBeUndefined()
  })

  it('records a whole-file view for an overwrite, even over a partial one', async () => {
    const path = await fileHolding({ name: 'overwritten.ts', content: 'a\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: { mtimeMs: 1, size: 2, wholeFile: false, digest: 'stale' } })

    await recordFor({ name: 'write', input: { path }, seen })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(true)
  })

  it('carries a partial view forward through an amend rather than widening it', async () => {
    const path = await fileHolding({ name: 'amended-partially.ts', content: 'a\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: { mtimeMs: 1, size: 2, wholeFile: false, digest: 'stale' } })

    await recordFor({ name: 'edit', input: { path }, seen })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(false)
  })

  it('records a whole-file view for an amend that had no prior view, which created the file', async () => {
    const path = await fileHolding({ name: 'created-by-edit.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'edit', input: { path } })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(true)
  })

  it('records the file as it stands after the write, not as it stood before', async () => {
    const path = await fileHolding({ name: 'twice-edited.ts', content: 'before\n' })
    const before = await stat(path)
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: await viewNow({ path, wholeFile: true }) })

    await writeFile(path, 'after the edit landed\n')
    await recordFor({ name: 'edit', input: { path }, seen })

    const after = await stat(path)

    expect(seen.viewOf({ threadId: parent, path })).toEqual(await viewNow({ path, wholeFile: true }))
    expect(after.size).not.toBe(before.size)
  })

  it('appends nothing to the event log', async () => {
    const path = await fileHolding({ name: 'no-drafts.ts', content: 'a\n' })
    const { outcome } = await recordFor({ name: 'read', input: { path } })

    expect(outcome).toEqual({})
  })

  it('records only the field that reveals content when a tool declares two', async () => {
    const path = await fileHolding({ name: 'copied-from.ts', content: 'a\n' })
    const into = await fileHolding({ name: 'copied-into.ts', content: 'b\n' })
    const { seen } = await recordFor({ name: 'copy', input: { path, into } })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(false)
    expect(seen.viewOf({ threadId: parent, path: into })).toBeUndefined()
  })

  it('records nothing for a path that is missing, a directory, or not a string', async () => {
    const { seen } = await recordFor({ name: 'read', input: { path: join(root, 'never-written.ts') } })

    expect(seen.viewOf({ threadId: parent, path: join(root, 'never-written.ts') })).toBeUndefined()
    expect((await recordFor({ name: 'read', input: { path: root } })).seen.viewOf({ threadId: parent, path: root })).toBeUndefined()
    expect((await recordFor({ name: 'read', input: { path: 42 } })).outcome).toEqual({})
    expect((await recordFor({ name: 'read', input: { path: 'relative.ts' } })).outcome).toEqual({})
  })

  it('records a partial view of each file a search showed lines of', async () => {
    const shown = await fileHolding({ name: 'matched.ts', content: 'todo\n' })
    const { seen } = await recordFor({ name: 'rg', input: { path: root }, result: showing([shown]) })
    const stats = await stat(shown)

    expect(seen.viewOf({ threadId: parent, path: shown })).toEqual(await viewNow({ path: shown, wholeFile: false }))
  })

  it('keeps a whole-file view that a search only re-confirmed, so a later overwrite still stands', async () => {
    const path = await fileHolding({ name: 'read-then-matched.ts', content: 'todo\n' })
    const stats = await stat(path)
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: await viewNow({ path, wholeFile: true }) })

    await recordFor({ name: 'rg', input: { path: root }, result: showing([path]), seen })

    expect(seen.viewOf({ threadId: parent, path })?.wholeFile).toBe(true)
  })

  it('drops a whole-file view the file has since outgrown, since only the matched lines were seen', async () => {
    const path = await fileHolding({ name: 'changed-then-matched.ts', content: 'todo\n' })
    const asRead = await stat(path)
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: await viewNow({ path, wholeFile: true }) })

    await writeFile(path, 'todo\nand a second line nobody has read\n')

    await recordFor({ name: 'rg', input: { path: root }, result: showing([path]), seen })

    expect(seen.viewOf({ threadId: parent, path })).toEqual(await viewNow({ path, wholeFile: false }))
  })

  it('ignores a revealed path that is relative, missing, or not a regular file', async () => {
    const { seen } = await recordFor({
      name: 'rg',
      input: { path: root },
      result: showing(['relative.ts', join(root, 'never-existed.ts'), root]),
    })

    expect(seen.viewOf({ threadId: parent, path: 'relative.ts' })).toBeUndefined()
    expect(seen.viewOf({ threadId: parent, path: join(root, 'never-existed.ts') })).toBeUndefined()
    expect(seen.viewOf({ threadId: parent, path: root })).toBeUndefined()
  })
})

describe('createRecordFileStateHook attributing each view to its own thread', () => {
  it('records a read under the reading thread and nowhere else', async () => {
    const path = await fileHolding({ name: 'read-by-one-thread.ts', content: 'export const a = 1\n' })
    const { seen } = await recordFor({ name: 'read', input: { path }, threadId: child })
    const stats = await stat(path)

    expect(seen.viewOf({ threadId: child, path })).toEqual(await viewNow({ path, wholeFile: true }))
    expect(seen.viewOf({ threadId: parent, path })).toBeUndefined()
  })

  it('records the lines a search showed under the searching thread only', async () => {
    const shown = await fileHolding({ name: 'matched-by-one-thread.ts', content: 'todo\n' })
    const { seen } = await recordFor({
      name: 'rg',
      input: { path: root },
      result: showing([shown]),
      threadId: child,
    })

    expect(seen.viewOf({ threadId: child, path: shown })?.wholeFile).toBe(false)
    expect(seen.viewOf({ threadId: parent, path: shown })).toBeUndefined()
  })

  it('widens an amend to whole-file only against the amending thread’s own prior view', async () => {
    const path = await fileHolding({ name: 'amended-by-child.ts', content: 'a\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ threadId: parent, path, view: { mtimeMs: 1, size: 2, wholeFile: false, digest: 'stale' } })

    await recordFor({ name: 'edit', input: { path }, seen, threadId: child })

    expect(seen.viewOf({ threadId: child, path })?.wholeFile).toBe(true)
    expect(seen.viewOf({ threadId: parent, path })).toEqual({ mtimeMs: 1, size: 2, wholeFile: false, digest: 'stale' })
  })

  it('leaves the other thread’s view untouched when a write moves the file on disk', async () => {
    const path = await fileHolding({ name: 'written-by-child.ts', content: 'before\n' })
    const before = await stat(path)
    const seen = new InMemoryFileReadState()
    const asParentSawIt = await viewNow({ path, wholeFile: true })
    seen.record({ threadId: parent, path, view: asParentSawIt })

    await writeFile(path, 'after the child wrote it\n')
    await recordFor({ name: 'write', input: { path }, seen, threadId: child })

    const after = await stat(path)

    expect(seen.viewOf({ threadId: child, path })).toEqual(await viewNow({ path, wholeFile: true }))
    expect(seen.viewOf({ threadId: parent, path })).toEqual(asParentSawIt)
    expect(after.size).not.toBe(before.size)
  })
})