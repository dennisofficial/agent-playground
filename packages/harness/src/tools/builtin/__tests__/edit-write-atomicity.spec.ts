import { toThreadId, type ToolOutcome } from '@dltech/atlas-core'
import { chmod, lstat, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'

import { EditTool } from '../edit'
import { WriteTool } from '../write'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-write-atomicity-'))
})

const invoke = (tool: EditTool | WriteTool, input: unknown): Promise<ToolOutcome> =>
  tool.invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'atomicity',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

const permissionsOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

const fileHolding = async (args: {
  name: string
  text: string
  mode?: number
}): Promise<string> => {
  const path = join(root, args.name)
  await writeFile(path, args.text)
  if (args.mode !== undefined) await chmod(path, args.mode)
  return path
}

describe('edit and write land whole or not at all', () => {
  it('keeps an executable file executable across an edit', async () => {
    const path = await fileHolding({ name: 'hook.sh', text: 'echo old\n', mode: 0o755 })

    const outcome = await invoke(new EditTool(), { path, oldString: 'old', newString: 'new' })

    expect(outcome.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('echo new\n')
    expect(await permissionsOf(path)).toBe(0o755)
  })

  it('keeps an executable file executable across a whole-file write', async () => {
    const path = await fileHolding({ name: 'run.sh', text: 'echo old\n', mode: 0o755 })

    const outcome = await invoke(new WriteTool(), { path, content: 'echo new\n' })

    expect(outcome.ok).toBe(true)
    expect(await permissionsOf(path)).toBe(0o755)
  })

  it('gives a file it creates the default mode rather than an inherited one', async () => {
    const path = join(root, 'fresh.txt')

    expect((await invoke(new WriteTool(), { path, content: 'hello\n' })).ok).toBe(true)
    expect(await permissionsOf(path)).toBe(0o644)
  })

  it('leaves no partial file beside the target after an edit', async () => {
    const path = await fileHolding({ name: 'tidy.ts', text: 'const a = 1\n' })

    await invoke(new EditTool(), { path, oldString: '1', newString: '2' })

    expect(await readdir(root)).toEqual(['tidy.ts'])
  })

  it('creates missing parent directories on the way to a new file', async () => {
    const path = join(root, 'nested', 'deep', 'new.ts')

    expect((await invoke(new WriteTool(), { path, content: 'x\n' })).ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('x\n')
  })

  it('edits through a symlink without breaking the link', async () => {
    const target = await fileHolding({ name: 'real.txt', text: 'old\n' })
    const link = join(root, 'link.txt')
    await symlink(target, link)

    const outcome = await invoke(new EditTool(), { path: link, oldString: 'old', newString: 'new' })

    expect(outcome.ok).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('new\n')
  })

  it('writes through a symlink without breaking the link', async () => {
    const target = await fileHolding({ name: 'real-write.txt', text: 'old\n' })
    const link = join(root, 'link-write.txt')
    await symlink(target, link)

    const outcome = await invoke(new WriteTool(), { path: link, content: 'new\n' })

    expect(outcome.ok).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('new\n')
  })

  it('reports the bytes it wrote, counting UTF-8 rather than characters', async () => {
    const path = join(root, 'unicode.ts')

    const outcome = await invoke(new WriteTool(), { path, content: 'héllo' })

    if (!outcome.ok) throw new Error(outcome.reason)
    expect((outcome.output as { bytes: number }).bytes).toBe(6)
  })
})
