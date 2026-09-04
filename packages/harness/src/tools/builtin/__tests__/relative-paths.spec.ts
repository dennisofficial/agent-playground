import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'

import { EditTool } from '../edit'
import { filePathSchema, resolveToolPath } from '../file-text'
import { GlobTool } from '../glob'
import { GrepTool } from '../grep'
import { ReadTool } from '../read'
import { WriteTool } from '../write'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-relative-paths-'))

  await mkdir(join(root, 'composition'), { recursive: true })
  await writeFile(join(root, 'composition', 'app.tsx'), 'export const app = true\n')
  await writeFile(join(root, 'top.ts'), 'const needle = 1\n')
})

const invoke = async (
  tool: ReadTool | EditTool | WriteTool | GlobTool | GrepTool,
  input: Record<string, unknown>,
): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'relative-paths',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

describe('filePathSchema', () => {
  it('accepts a relative path', () => {
    expect(filePathSchema.safeParse('apps/tui/src/app.ts').success).toBe(true)
  })

  it('accepts an absolute path', () => {
    expect(filePathSchema.safeParse(join(root, 'top.ts')).success).toBe(true)
  })

  it('rejects an empty path', () => {
    expect(filePathSchema.safeParse('').success).toBe(false)
  })
})

describe('resolveToolPath', () => {
  it('leaves an absolute path untouched', () => {
    expect(resolveToolPath({ projectDirectory: root, path: '/x/y.ts' })).toBe('/x/y.ts')
  })

  it('anchors a relative path to the project directory', () => {
    expect(resolveToolPath({ projectDirectory: root, path: 'a/b.ts' })).toBe(join(root, 'a/b.ts'))
  })
})

describe('file tools resolve relative paths against the project directory without the hook', () => {
  it('reads a file named relative to the project directory', async () => {
    const outcome = await invoke(new ReadTool(), { path: 'top.ts' })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain('const needle = 1')
  })

  it('writes a file named relative to the project directory', async () => {
    const outcome = await invoke(new WriteTool(), { path: 'made.ts', content: 'const made = 2\n' })

    expect(outcome.ok).toBe(true)
    expect(await readFile(join(root, 'made.ts'), 'utf8')).toBe('const made = 2\n')
  })

  it('edits a file named relative to the project directory', async () => {
    const outcome = await invoke(new EditTool(), {
      path: 'top.ts',
      oldString: 'const needle = 1',
      newString: 'const needle = 2',
    })

    expect(outcome.ok).toBe(true)
    expect(await readFile(join(root, 'top.ts'), 'utf8')).toBe('const needle = 2\n')
  })

  it('globs from a directory named relative to the project directory', async () => {
    const outcome = await invoke(new GlobTool(), { pattern: '*.tsx', path: 'composition' })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain(join(root, 'composition', 'app.tsx'))
  })

  it('greps a path named relative to the project directory', async () => {
    const outcome = await invoke(new GrepTool(), { pattern: 'needle', path: 'top.ts' })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.modelText).toContain('const needle = 2')
  })

  it('teaches the anchor when a relative path misses', async () => {
    const outcome = await invoke(new ReadTool(), { path: 'composition/gone.ts' })

    expect(outcome.ok).toBe(false)
    const reason = outcome.ok ? '' : outcome.reason
    expect(reason).toContain(`File does not exist: ${join(root, 'composition', 'gone.ts')}`)
    expect(reason).toContain(
      `composition/gone.ts resolved against the project directory ${root}`,
    )
  })
})
