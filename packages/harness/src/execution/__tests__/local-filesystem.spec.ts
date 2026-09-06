import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { chmod, mkdtemp, rm, symlink, writeFile as nodeWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalFileSystemPort } from '../local-filesystem'

describe('LocalFileSystemPort', () => {
  let root: string
  const port = new LocalFileSystemPort()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atlas-fs-port-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('round-trips content through writeFile and readFile', async () => {
    const path = join(root, 'notes.txt')

    await port.writeFile({ path, content: 'hello\n' })

    expect(await port.readFile({ path })).toBe('hello\n')
  })

  it('stats a file with its kind, size and mode', async () => {
    const path = join(root, 'notes.txt')
    await port.writeFile({ path, content: 'hello\n' })

    const stat = await port.stat({ path })

    expect(stat.isFile()).toBe(true)
    expect(stat.isDirectory()).toBe(false)
    expect(stat.size).toBe(6)
    expect(stat.mode).toBe(0o100644)
  })

  it('preserves the mode of a file writeFile overwrites', async () => {
    const path = join(root, 'script.sh')
    await nodeWriteFile(path, '#!/bin/sh\nold\n')
    await chmod(path, 0o750)

    await port.writeFile({ path, content: '#!/bin/sh\nnew\n' })
    const stat = await port.stat({ path })

    expect(stat.mode & 0o777).toBe(0o750)
    expect(await port.readFile({ path })).toBe('#!/bin/sh\nnew\n')
  })

  it('applies a handed mode exactly, whatever the umask would leave', async () => {
    const path = join(root, 'script.sh')

    await port.writeFile({ path, content: '#!/bin/sh\n', mode: 0o755 })

    expect((await port.stat({ path })).mode & 0o777).toBe(0o755)
  })

  it('reads bytes without decoding them', async () => {
    const path = join(root, 'image.bin')
    const bytes = new Uint8Array([0x89, 0x50, 0xfe, 0x00, 0xff])
    await Bun.write(path, bytes)

    expect(await port.readBytes({ path })).toEqual(bytes)
  })

  it('removes a file, and rejects removing what is not there', async () => {
    const path = join(root, 'gone.txt')
    await port.writeFile({ path, content: 'x' })

    await port.removeFile({ path })

    await expect(port.stat({ path })).rejects.toThrow(/ENOENT/)
    await expect(port.removeFile({ path })).rejects.toThrow(/ENOENT/)
  })

  it('stats a directory as a directory', async () => {
    const stat = await port.stat({ path: root })

    expect(stat.isDirectory()).toBe(true)
    expect(stat.isFile()).toBe(false)
  })

  it('rejects stat of a path nothing occupies', async () => {
    await expect(port.stat({ path: join(root, 'absent.txt') })).rejects.toThrow(/ENOENT/)
  })

  it('creates directories recursively through mkdir', async () => {
    const path = join(root, 'deep', 'nested')

    await port.mkdir({ path })

    expect((await port.stat({ path })).isDirectory()).toBe(true)
  })

  it('moves content through rename', async () => {
    const from = join(root, 'before.txt')
    const to = join(root, 'after.txt')
    await port.writeFile({ path: from, content: 'moved\n' })

    await port.rename({ from, to })

    expect(await port.readFile({ path: to })).toBe('moved\n')
    await expect(port.stat({ path: from })).rejects.toThrow(/ENOENT/)
  })

  it('lists directory entries with their kind', async () => {
    await port.mkdir({ path: join(root, 'sub') })
    await port.writeFile({ path: join(root, 'notes.txt'), content: 'x' })

    const entries = await port.readDirectory({ path: root })
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    expect(byName.get('sub')?.isDirectory()).toBe(true)
    expect(byName.get('notes.txt')?.isFile()).toBe(true)
  })

  it('finds files by pattern as absolute paths through glob', async () => {
    await port.writeFile({ path: join(root, 'a.ts'), content: 'a' })
    await port.writeFile({ path: join(root, 'b.ts'), content: 'b' })
    await port.writeFile({ path: join(root, 'c.md'), content: 'c' })

    const found = await port.glob({ pattern: '*.ts', cwd: root })

    expect([...found].sort()).toEqual([join(root, 'a.ts'), join(root, 'b.ts')].sort())
  })

  it('matches only files through glob, never directories', async () => {
    await port.mkdir({ path: join(root, 'sub') })
    await port.writeFile({ path: join(root, 'notes.txt'), content: 'x' })

    const found = await port.glob({ pattern: '*', cwd: root })

    expect(found).toEqual([join(root, 'notes.txt')])
  })

  it('reaches above the cwd when the pattern ascends', async () => {
    await port.mkdir({ path: join(root, 'sub') })
    await port.writeFile({ path: join(root, 'root.txt'), content: 'x' })

    const found = await port.glob({ pattern: '../*.txt', cwd: join(root, 'sub') })

    expect(found).toEqual([join(root, 'root.txt')])
  })

  it('finds files through a symlinked directory', async () => {
    await port.mkdir({ path: join(root, 'real', 'sub') })
    await port.writeFile({ path: join(root, 'real', 'a.txt'), content: 'a' })
    await port.writeFile({ path: join(root, 'real', 'sub', 'b.txt'), content: 'b' })
    await symlink(join(root, 'real'), join(root, 'linked'))

    const found = await port.glob({ pattern: '**/*.txt', cwd: root })

    expect(found).toEqual(
      expect.arrayContaining([join(root, 'real', 'a.txt'), join(root, 'real', 'sub', 'b.txt')]),
    )
    expect(found.some((path) => path.includes('linked'))).toBe(false)
  })

  it('reports a symlink to a file as a match at the link path', async () => {
    await port.mkdir({ path: join(root, 'elsewhere') })
    await port.writeFile({ path: join(root, 'elsewhere', 'real.txt'), content: 'x' })
    await symlink(join(root, 'elsewhere', 'real.txt'), join(root, 'alias.txt'))

    const found = await port.glob({ pattern: '*.txt', cwd: root })

    expect(found).toEqual([join(root, 'alias.txt')])
  })

  it('terminates on a symlink cycle instead of recursing forever', async () => {
    await port.mkdir({ path: join(root, 'loop') })
    await port.writeFile({ path: join(root, 'loop', 'x.txt'), content: 'x' })
    await symlink(join(root, 'loop'), join(root, 'loop', 'self'))

    const found = await port.glob({ pattern: '**/*.txt', cwd: root })

    expect(found).toEqual([join(root, 'loop', 'x.txt')])
  })

  it('skips dangling links rather than failing the scan', async () => {
    await port.writeFile({ path: join(root, 'present.txt'), content: 'x' })
    await symlink(join(root, 'absent.txt'), join(root, 'dangling.txt'))

    const found = await port.glob({ pattern: '**/*.txt', cwd: root })

    expect(found).toEqual([join(root, 'present.txt')])
  })

  it('skips hidden entries unless dot asks for them', async () => {
    await port.mkdir({ path: join(root, '.hidden') })
    await port.writeFile({ path: join(root, '.hidden', 'secret.txt'), content: 'x' })
    await port.writeFile({ path: join(root, '.dotfile.txt'), content: 'x' })
    await port.writeFile({ path: join(root, 'plain.txt'), content: 'x' })

    expect(await port.glob({ pattern: '**/*.txt', cwd: root })).toEqual([join(root, 'plain.txt')])
    expect(await port.glob({ pattern: '**/*.txt', cwd: root, dot: true })).toEqual(
      expect.arrayContaining([
        join(root, 'plain.txt'),
        join(root, '.dotfile.txt'),
        join(root, '.hidden', 'secret.txt'),
      ]),
    )
  })
})
