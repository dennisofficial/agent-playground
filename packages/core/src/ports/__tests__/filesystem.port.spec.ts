import { describe, expect, it } from 'bun:test'

import type { FileStat, FileSystemEntry, FileSystemPort } from '../filesystem.port'

type Stored = { content: string; mode: number; mtimeMs: number }

const parentOf = (path: string): string => {
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parent === '' ? '/' : parent
}

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const enoent = (operation: string, path: string): Error =>
  new Error(`ENOENT: no such file or directory, ${operation} '${path}'`)

const fakeFileSystem = (): FileSystemPort => {
  const files = new Map<string, Stored>()
  const directories = new Set<string>(['/'])
  let ticks = 0

  const statOf = (path: string): FileStat => {
    const file = files.get(path)
    if (file !== undefined) {
      return {
        size: file.content.length,
        mode: file.mode,
        mtimeMs: file.mtimeMs,
        isFile: () => true,
        isDirectory: () => false,
      }
    }
    if (directories.has(path)) {
      return { size: 0, mode: 0o755, mtimeMs: 0, isFile: () => false, isDirectory: () => true }
    }
    throw enoent('stat', path)
  }

  return {
    stat: async ({ path }) => statOf(path),
    readFile: async ({ path }) => {
      const file = files.get(path)
      if (file === undefined) throw enoent('open', path)
      return file.content
    },
    readBytes: async ({ path }) => {
      const file = files.get(path)
      if (file === undefined) throw enoent('open', path)
      return new TextEncoder().encode(file.content)
    },
    writeFile: async ({ path, content, mode }) => {
      const existing = files.get(path)
      files.set(path, { content, mode: mode ?? existing?.mode ?? 0o644, mtimeMs: ++ticks })
    },
    removeFile: async ({ path }) => {
      if (!files.delete(path)) throw enoent('unlink', path)
    },
    mkdir: async ({ path }) => {
      let current = ''
      for (const part of path.split('/').filter(Boolean)) {
        current += `/${part}`
        directories.add(current)
      }
    },
    rename: async ({ from, to }) => {
      const file = files.get(from)
      if (file === undefined) throw enoent('rename', from)
      files.delete(from)
      files.set(to, file)
    },
    readDirectory: async ({ path }) => {
      if (!directories.has(path)) throw enoent('scandir', path)
      const entries: FileSystemEntry[] = []
      for (const name of directories) {
        if (name !== '/' && parentOf(name) === path) {
          entries.push({ name: baseOf(name), isFile: () => false, isDirectory: () => true })
        }
      }
      for (const name of files.keys()) {
        if (parentOf(name) === path) {
          entries.push({ name: baseOf(name), isFile: () => true, isDirectory: () => false })
        }
      }
      return entries
    },
    glob: async ({ pattern, cwd }) => {
      const suffix = pattern.startsWith('*') ? pattern.slice(1) : pattern
      return [...files.keys()].filter((name) => parentOf(name) === cwd && name.endsWith(suffix))
    },
  }
}

describe('FileSystemPort', () => {
  it('round-trips content through writeFile and readFile', async () => {
    const files = fakeFileSystem()

    await files.writeFile({ path: '/work/notes.txt', content: 'hello\n' })

    expect(await files.readFile({ path: '/work/notes.txt' })).toBe('hello\n')
  })

  it('reports kind, size and mode through stat', async () => {
    const files = fakeFileSystem()
    await files.writeFile({ path: '/work/notes.txt', content: 'hello\n' })

    const stat = await files.stat({ path: '/work/notes.txt' })

    expect(stat.isFile()).toBe(true)
    expect(stat.isDirectory()).toBe(false)
    expect(stat.size).toBe(6)
    expect(stat.mode).toBe(0o644)
  })

  it('rejects stat of a path nothing occupies', async () => {
    await expect(fakeFileSystem().stat({ path: '/work/absent.txt' })).rejects.toThrow(/ENOENT/)
  })

  it('creates directories recursively and stats them as directories', async () => {
    const files = fakeFileSystem()

    await files.mkdir({ path: '/work/deep/nested' })
    const stat = await files.stat({ path: '/work/deep/nested' })

    expect(stat.isDirectory()).toBe(true)
    expect(stat.isFile()).toBe(false)
  })

  it('moves content through rename', async () => {
    const files = fakeFileSystem()
    await files.writeFile({ path: '/work/before.txt', content: 'moved\n' })

    await files.rename({ from: '/work/before.txt', to: '/work/after.txt' })

    expect(await files.readFile({ path: '/work/after.txt' })).toBe('moved\n')
    await expect(files.stat({ path: '/work/before.txt' })).rejects.toThrow(/ENOENT/)
  })

  it('lists directory entries with their kind', async () => {
    const files = fakeFileSystem()
    await files.mkdir({ path: '/work/sub' })
    await files.writeFile({ path: '/work/notes.txt', content: 'x' })

    const entries = await files.readDirectory({ path: '/work' })
    const byName = new Map(entries.map((entry) => [entry.name, entry]))

    expect(byName.get('sub')?.isDirectory()).toBe(true)
    expect(byName.get('notes.txt')?.isFile()).toBe(true)
  })

  it('finds files by pattern under a directory through glob', async () => {
    const files = fakeFileSystem()
    await files.writeFile({ path: '/work/a.ts', content: 'a' })
    await files.writeFile({ path: '/work/b.md', content: 'b' })

    expect(await files.glob({ pattern: '*.ts', cwd: '/work' })).toEqual(['/work/a.ts'])
  })
})
