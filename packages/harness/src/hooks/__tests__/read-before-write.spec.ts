import { chmod, mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  EBeforeToolDecision,
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  toCallId,
  type ToolCall,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { InMemoryFileReadState, type FileView } from '../../files/read-state'
import { createReadBeforeWriteHook } from '../read-before-write'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-read-before-write-'))
})

const declaring = ({
  name,
  content,
}: {
  name: string
  content: EContentAccess
}): ToolDeclaration => ({
  name,
  description: `a tool whose path field ${content} the file it names`,
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string() }),
  pathFields: [
    { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute, content },
  ],
})

const undeclaredTool: ToolDeclaration = {
  name: 'mcp-filesystem',
  description: 'an MCP tool that never said which of its inputs hold paths',
  effect: EToolEffect.Write,
  inputSchema: z.strictObject({ path: z.string() }),
}

const tools: readonly ToolDeclaration[] = [
  declaring({ name: 'write', content: EContentAccess.Overwrites }),
  declaring({ name: 'edit', content: EContentAccess.Amends }),
  declaring({ name: 'grep', content: EContentAccess.None }),
  undeclaredTool,
]

const callTo = ({ name, input }: { name: string; input: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input,
  effect: EToolEffect.Write,
})

const decide = ({
  seen,
  name,
  input,
}: {
  seen: InMemoryFileReadState
  name: string
  input: unknown
}) => createReadBeforeWriteHook({ seen, tools }).run({ call: callTo({ name, input }) })

const fileHolding = async ({ name, text }: { name: string; text: string }): Promise<string> => {
  const path = join(root, name)
  await writeFile(path, text)
  return path
}

const viewOnDisk = async ({
  path,
  wholeFile,
}: {
  path: string
  wholeFile: boolean
}): Promise<FileView> => {
  const stats = await stat(path)
  return { mtimeMs: stats.mtimeMs, size: stats.size, wholeFile }
}

const havingRead = async ({ path, wholeFile }: { path: string; wholeFile: boolean }) => {
  const seen = new InMemoryFileReadState()
  seen.record({ path, view: await viewOnDisk({ path, wholeFile }) })
  return seen
}

const settle = () => new Promise((done) => setTimeout(done, 8))

type Outcome = Awaited<ReturnType<typeof decide>>

const denialReasonOf = (outcome: Outcome): string => {
  expect(outcome.decision).toBe(EBeforeToolDecision.Deny)
  return 'reason' in outcome ? outcome.reason : ''
}

describe('createReadBeforeWriteHook', () => {
  it('allows a write to a path that does not exist, since creating a file destroys nothing', async () => {
    const outcome = await decide({
      seen: new InMemoryFileReadState(),
      name: 'write',
      input: { path: join(root, 'brand-new.ts') },
    })

    expect(outcome.decision).toBe(EBeforeToolDecision.Allow)
  })

  it('denies a write to an existing file that has never been read', async () => {
    const path = await fileHolding({ name: 'unread.ts', text: 'export const a = 1\n' })

    const outcome = await decide({ seen: new InMemoryFileReadState(), name: 'write', input: { path } })

    const reason = denialReasonOf(outcome)
    expect(reason).toContain(path)
    expect(reason).toContain('read it first')
  })

  it('allows a write when the whole file was read and nothing has touched it since', async () => {
    const path = await fileHolding({ name: 'read-whole.ts', text: 'export const a = 1\n' })
    const seen = await havingRead({ path, wholeFile: true })

    expect((await decide({ seen, name: 'write', input: { path } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })

  it('denies a write when the file has been rewritten since it was read', async () => {
    const path = await fileHolding({ name: 'stale.ts', text: 'export const a = 1\n' })
    const seen = await havingRead({ path, wholeFile: true })

    await settle()
    await writeFile(path, 'export const a = 2\n')

    const current = await stat(path)
    expect(seen.viewOf(path)?.mtimeMs).not.toBe(current.mtimeMs)

    const outcome = await decide({ seen, name: 'write', input: { path } })

    const reason = denialReasonOf(outcome)
    expect(reason).toContain(path)
    expect(reason).toContain('read it again')
  })

  it('denies a write when only the size differs, which an mtime-only check would wave through', async () => {
    const path = await fileHolding({ name: 'same-mtime.ts', text: 'a\n' })
    const asRead = await stat(path)

    await writeFile(path, 'a much longer body than before\n')
    await utimes(path, asRead.atime, asRead.mtime)

    const current = await stat(path)
    const seen = new InMemoryFileReadState()
    seen.record({ path, view: { mtimeMs: current.mtimeMs, size: asRead.size, wholeFile: true } })

    expect(current.size).not.toBe(asRead.size)
    expect(seen.viewOf(path)?.mtimeMs).toBe(current.mtimeMs)

    const outcome = await decide({ seen, name: 'write', input: { path } })

    expect(denialReasonOf(outcome)).toContain('read it again')
  })

  it('denies a whole-file overwrite when only part of the file has been read', async () => {
    const path = await fileHolding({ name: 'partly-read.ts', text: 'a\nb\nc\n' })
    const seen = await havingRead({ path, wholeFile: false })

    const outcome = await decide({ seen, name: 'write', input: { path } })

    const reason = denialReasonOf(outcome)
    expect(reason).toContain(path)
    expect(reason).toContain('use edit')
  })

  it('allows an amendment when only part of the file has been read', async () => {
    const path = await fileHolding({ name: 'partly-read-edit.ts', text: 'a\nb\nc\n' })
    const seen = await havingRead({ path, wholeFile: false })

    expect((await decide({ seen, name: 'edit', input: { path } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })

  it('denies an amendment when the file has changed since it was read', async () => {
    const path = await fileHolding({ name: 'stale-edit.ts', text: 'a\nb\nc\n' })
    const seen = await havingRead({ path, wholeFile: false })

    await settle()
    await writeFile(path, 'a\nb\nd\n')

    const outcome = await decide({ seen, name: 'edit', input: { path } })

    expect(denialReasonOf(outcome)).toContain('read it again')
  })

  it('allows a tool whose path field only reads, with no view recorded at all', async () => {
    const path = await fileHolding({ name: 'grepped.ts', text: 'todo\n' })

    expect(
      (await decide({ seen: new InMemoryFileReadState(), name: 'grep', input: { path } })).decision,
    ).toBe(EBeforeToolDecision.Allow)
  })

  it('defers on a tool it has no declaration for, and on one that declared no path fields', async () => {
    const path = await fileHolding({ name: 'somebody-elses-problem.ts', text: 'x\n' })
    const seen = new InMemoryFileReadState()

    expect((await decide({ seen, name: 'some-mcp-tool', input: { path } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ seen, name: 'mcp-filesystem', input: { path } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })

  it('defers on a path field that is missing, not a string, or not absolute', async () => {
    const seen = new InMemoryFileReadState()

    expect((await decide({ seen, name: 'write', input: {} })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ seen, name: 'write', input: { path: 42 } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ seen, name: 'write', input: 'not an object' })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
    expect((await decide({ seen, name: 'write', input: { path: 'relative.ts' } })).decision).toBe(
      EBeforeToolDecision.Allow,
    )
  })

  it('denies a write to a file whose current state cannot be read at all', async () => {
    const locked = join(root, 'locked')
    await mkdir(locked, { recursive: true })
    const path = join(locked, 'unreachable.ts')
    await writeFile(path, 'export const a = 1\n')
    await chmod(locked, 0o000)

    try {
      const fault = await stat(path).then(
        () => 'no failure at all',
        (error: unknown) =>
          error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'unknown',
      )

      expect(fault).not.toBe('no failure at all')
      expect(fault).not.toBe('ENOENT')

      const outcome = await decide({
        seen: new InMemoryFileReadState(),
        name: 'write',
        input: { path },
      })

      const reason = denialReasonOf(outcome)
      expect(reason).toContain(path)
      expect(reason).toContain(fault)
      expect(reason).toContain('refused')
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('allows a path that exists but is not a regular file, leaving that to the tool', async () => {
    const path = join(root, 'a-directory')
    await mkdir(path, { recursive: true })

    expect(
      (await decide({ seen: new InMemoryFileReadState(), name: 'write', input: { path } })).decision,
    ).toBe(EBeforeToolDecision.Allow)
  })

  it('passes the input through untouched on allow', async () => {
    const path = await fileHolding({ name: 'passthrough.ts', text: 'a\n' })
    const seen = await havingRead({ path, wholeFile: true })
    const input = { path, content: 'a\nb\n' }

    expect(await decide({ seen, name: 'write', input })).toEqual({
      decision: EBeforeToolDecision.Allow,
      input,
    })
  })
})
