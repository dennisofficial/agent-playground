import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'

import { absolutePathSchema } from '../file-text'
import { GrepTool, type GrepInput } from '../grep'
import { ReadTool } from '../read'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-missing-path-'))

  await mkdir(join(root, 'composition', 'commands'), { recursive: true })
  await writeFile(join(root, 'composition', 'app.tsx'), 'export const app = true\n')
  await writeFile(join(root, 'composition', 'compose.ts'), 'export const compose = true\n')
  await writeFile(join(root, 'top.ts'), 'const needle = 1\n')
  await mkdir(join(root, 'vacant'))
})

const readTool = new ReadTool()
const grepTool = new GrepTool()

const read = async (path: string): Promise<ToolOutcome> =>
  readTool.invoke({
    input: { path },
    signal: new AbortController().signal,
    idempotencyKey: 'missing-path-read',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const search = async (input: GrepInput): Promise<ToolOutcome> =>
  grepTool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'missing-path-grep',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const reasonOf = (outcome: ToolOutcome): string => {
  expect(outcome.ok).toBe(false)
  return outcome.ok ? '' : outcome.reason
}

describe('a missing path tells the model what is actually there', () => {
  it('names the closest real entries when the file alone is missing', async () => {
    const missing = join(root, 'composition', 'atlas-app.ts')

    const reason = reasonOf(await read(missing))

    expect(reason).toContain(`File does not exist: ${missing}`)
    expect(reason).toContain('app.tsx')
    expect(reason).toContain('compose.ts')
  })

  it('marks directories so a file/directory mix-up is visible', async () => {
    const reason = reasonOf(await read(join(root, 'composition', 'atlas-app.ts')))

    expect(reason).toContain('commands/')
  })

  it('names the deepest existing directory when a middle segment is missing', async () => {
    const missing = join(root, 'composition', 'nested', 'deep.ts')

    const reason = reasonOf(await read(missing))

    expect(reason).toContain(`File does not exist: ${missing}`)
    expect(reason).toContain(join(root, 'composition'))
    expect(reason).toContain('app.tsx')
  })

  it('says so when the containing directory is empty', async () => {
    const reason = reasonOf(await read(join(root, 'vacant', 'gone.ts')))

    expect(reason).toContain('is empty')
  })

  it('fails a grep against a missing path with the same guidance instead of a spawn complaint', async () => {
    const missing = join(root, 'composition', 'atlas-app.ts')

    const reason = reasonOf(await search({ pattern: 'needle', path: missing }))

    expect(reason).toContain(`File does not exist: ${missing}`)
    expect(reason).toContain('app.tsx')
    expect(reason).not.toContain('exited')
  })

  it('still searches an existing path exactly as before', async () => {
    const outcome = await search({ pattern: 'needle', path: join(root, 'top.ts') })

    expect(outcome.ok).toBe(true)
  })
})

describe('absolutePathSchema', () => {
  it('rejects a relative path and says why', () => {
    const parsed = absolutePathSchema.safeParse('apps/tui/src/app.ts')

    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('absolute')
  })

  it('accepts an absolute path', () => {
    expect(absolutePathSchema.safeParse(join(root, 'top.ts')).success).toBe(true)
  })

  it('turns a relative read path into invalid-input feedback', async () => {
    const reason = reasonOf(await read('apps/tui/src/app.ts'))

    expect(reason).toContain('invalid input')
    expect(reason).toContain('absolute')
  })

  it('turns a relative grep path into invalid-input feedback', async () => {
    const reason = reasonOf(await search({ pattern: 'needle', path: 'apps/tui' }))

    expect(reason).toContain('invalid input')
    expect(reason).toContain('absolute')
  })
})
