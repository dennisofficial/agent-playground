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
  type ToolCall,
  type ToolDeclaration,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { InMemoryFileReadState } from '../../files/read-state'
import { ABSENT, inputFieldOf } from '../../tools/declared-paths'
import { createRecordFileStateHook } from '../record-file-state'

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
  revealsWholeFile: (input) =>
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

const tools: readonly ToolDeclaration[] = [reader, silentReader, searcher, writer, editor, copier]

const succeeded: ToolOutcome = { ok: true, output: null, modelText: 'done' }

const callTo = ({ name, input }: { name: string; input: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: EToolEffect.Read,
})

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
}: {
  name: string
  input: unknown
  result?: ToolOutcome
  seen?: InMemoryFileReadState
}) => {
  const outcome = await createRecordFileStateHook({ seen, tools }).run({
    call: callTo({ name, input }),
    result,
  })

  return { outcome, seen }
}

describe('createRecordFileStateHook', () => {
  it('records a whole-file view for a read that asked for neither offset nor limit', async () => {
    const path = await fileHolding({ name: 'whole.ts', content: 'export const a = 1\n' })
    const { seen } = await recordFor({ name: 'read', input: { path } })
    const stats = await stat(path)

    expect(seen.viewOf(path)).toEqual({ mtimeMs: stats.mtimeMs, size: stats.size, wholeFile: true })
  })

  it('records a partial view for a read that asked for an offset', async () => {
    const path = await fileHolding({ name: 'windowed.ts', content: 'a\nb\nc\n' })
    const { seen } = await recordFor({ name: 'read', input: { path, offset: 2 } })

    expect(seen.viewOf(path)?.wholeFile).toBe(false)
  })

  it('records a partial view for a reader that declares no whole-file predicate', async () => {
    const path = await fileHolding({ name: 'peeked.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'peek', input: { path } })

    expect(seen.viewOf(path)?.wholeFile).toBe(false)
  })

  it('records nothing when the tool failed', async () => {
    const path = await fileHolding({ name: 'failed.ts', content: 'a\n' })
    const { seen } = await recordFor({
      name: 'read',
      input: { path },
      result: { ok: false, reason: 'nope' },
    })

    expect(seen.viewOf(path)).toBeUndefined()
  })

  it('leaves an existing view exactly as it was when the tool failed', async () => {
    const path = await fileHolding({ name: 'stale-stands.ts', content: 'a\n' })
    const standing = { mtimeMs: 1, size: 2, wholeFile: false }
    const seen = new InMemoryFileReadState()
    seen.record({ path, view: standing })

    await recordFor({ name: 'write', input: { path }, result: { ok: false, reason: 'nope' }, seen })

    expect(seen.viewOf(path)).toEqual(standing)
  })

  it('records nothing for a field that never reveals content', async () => {
    const path = await fileHolding({ name: 'searched.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'grep', input: { path } })

    expect(seen.viewOf(path)).toBeUndefined()
  })

  it('records nothing for a tool it has no declaration for', async () => {
    const path = await fileHolding({ name: 'unregistered.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'some-mcp-tool', input: { path } })

    expect(seen.viewOf(path)).toBeUndefined()
  })

  it('records a whole-file view for an overwrite, even over a partial one', async () => {
    const path = await fileHolding({ name: 'overwritten.ts', content: 'a\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ path, view: { mtimeMs: 1, size: 2, wholeFile: false } })

    await recordFor({ name: 'write', input: { path }, seen })

    expect(seen.viewOf(path)?.wholeFile).toBe(true)
  })

  it('carries a partial view forward through an amend rather than widening it', async () => {
    const path = await fileHolding({ name: 'amended-partially.ts', content: 'a\n' })
    const seen = new InMemoryFileReadState()
    seen.record({ path, view: { mtimeMs: 1, size: 2, wholeFile: false } })

    await recordFor({ name: 'edit', input: { path }, seen })

    expect(seen.viewOf(path)?.wholeFile).toBe(false)
  })

  it('records a whole-file view for an amend that had no prior view, which created the file', async () => {
    const path = await fileHolding({ name: 'created-by-edit.ts', content: 'a\n' })
    const { seen } = await recordFor({ name: 'edit', input: { path } })

    expect(seen.viewOf(path)?.wholeFile).toBe(true)
  })

  it('records the file as it stands after the write, not as it stood before', async () => {
    const path = await fileHolding({ name: 'twice-edited.ts', content: 'before\n' })
    const before = await stat(path)
    const seen = new InMemoryFileReadState()
    seen.record({ path, view: { mtimeMs: before.mtimeMs, size: before.size, wholeFile: true } })

    await writeFile(path, 'after the edit landed\n')
    await recordFor({ name: 'edit', input: { path }, seen })

    const after = await stat(path)

    expect(seen.viewOf(path)).toEqual({ mtimeMs: after.mtimeMs, size: after.size, wholeFile: true })
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

    expect(seen.viewOf(path)?.wholeFile).toBe(false)
    expect(seen.viewOf(into)).toBeUndefined()
  })

  it('records nothing for a path that is missing, a directory, or not a string', async () => {
    const { seen } = await recordFor({ name: 'read', input: { path: join(root, 'never-written.ts') } })

    expect(seen.viewOf(join(root, 'never-written.ts'))).toBeUndefined()
    expect((await recordFor({ name: 'read', input: { path: root } })).seen.viewOf(root)).toBeUndefined()
    expect((await recordFor({ name: 'read', input: { path: 42 } })).outcome).toEqual({})
    expect((await recordFor({ name: 'read', input: { path: 'relative.ts' } })).outcome).toEqual({})
  })
})
