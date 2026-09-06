import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { writeFileAtomically } from '../atomic-write'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-atomic-write-'))
})

const permissionsOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

describe('writeFileAtomically', () => {
  it('writes the content and reports the bytes it wrote', async () => {
    const path = join(root, 'plain.txt')
    const bytes = await writeFileAtomically({ path, content: 'hello\n' })

    expect(bytes).toBe(6)
    expect(await readFile(path, 'utf8')).toBe('hello\n')
  })

  it('counts bytes rather than characters', async () => {
    const path = join(root, 'unicode.txt')
    const bytes = await writeFileAtomically({ path, content: 'héllo' })

    expect(bytes).toBe(6)
    expect(await readFile(path, 'utf8')).toBe('héllo')
  })

  it('creates missing parent directories', async () => {
    const path = join(root, 'nested', 'deeper', 'new.txt')
    await writeFileAtomically({ path, content: 'x' })

    expect(await readFile(path, 'utf8')).toBe('x')
  })

  it('keeps the mode it is handed, so an executable file stays executable', async () => {
    const path = join(root, 'script.sh')
    await writeFile(path, 'old\n')
    await chmod(path, 0o755)

    const before = await stat(path)
    await writeFileAtomically({ path, content: 'new\n', mode: before.mode })

    expect(await permissionsOf(path)).toBe(0o755)
    expect(await readFile(path, 'utf8')).toBe('new\n')
  })

  it('leaves no temporary file behind once the write lands', async () => {
    const directory = join(root, 'tidy')
    const path = join(directory, 'file.txt')
    await writeFileAtomically({ path, content: 'a' })
    await writeFileAtomically({ path, content: 'b' })

    expect(await readdir(directory)).toEqual(['file.txt'])
  })

  it('destroys nothing and leaves no debris when the write cannot land', async () => {
    const directory = join(root, 'failing')
    const occupied = join(directory, 'occupied')
    await mkdir(occupied, { recursive: true })
    await writeFile(join(occupied, 'inside.txt'), 'still here\n')

    await expect(writeFileAtomically({ path: occupied, content: 'nope\n' })).rejects.toThrow()

    expect(await readFile(join(occupied, 'inside.txt'), 'utf8')).toBe('still here\n')
    expect(await readdir(directory)).toEqual(['occupied'])
  })

  it('writes through a symlink to its target and keeps the link intact', async () => {
    const directory = join(root, 'linked')
    await mkdir(directory, { recursive: true })
    const target = join(directory, 'real.txt')
    const link = join(directory, 'link.txt')
    await writeFile(target, 'old\n')
    await symlink(target, link)

    await writeFileAtomically({ path: link, content: 'new\n' })

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('new\n')
  })

  it('follows a chain of symlinks to the real file', async () => {
    const directory = join(root, 'chain')
    await mkdir(directory, { recursive: true })
    const target = join(directory, 'real.txt')
    await writeFile(target, 'old\n')
    await symlink(target, join(directory, 'hop-1.txt'))
    await symlink(join(directory, 'hop-1.txt'), join(directory, 'hop-2.txt'))

    await writeFileAtomically({ path: join(directory, 'hop-2.txt'), content: 'new\n' })

    expect((await lstat(join(directory, 'hop-1.txt'))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(directory, 'hop-2.txt'))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('new\n')
  })

  it('resolves a relative link target against the link directory', async () => {
    const directory = join(root, 'relative')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'real.txt'), 'old\n')
    await symlink('real.txt', join(directory, 'link.txt'))

    await writeFileAtomically({ path: join(directory, 'link.txt'), content: 'new\n' })

    expect((await lstat(join(directory, 'link.txt'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(directory, 'real.txt'), 'utf8')).toBe('new\n')
  })

  it('creates the file a dangling link points at instead of replacing the link', async () => {
    const directory = join(root, 'dangling')
    await mkdir(directory, { recursive: true })
    const target = join(directory, 'not-yet.txt')
    const link = join(directory, 'link.txt')
    await symlink(target, link)

    await writeFileAtomically({ path: link, content: 'made\n' })

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('made\n')
  })

  it('refuses a link that loops back on itself', async () => {
    const directory = join(root, 'loop')
    await mkdir(directory, { recursive: true })
    await symlink(join(directory, 'b.txt'), join(directory, 'a.txt'))
    await symlink(join(directory, 'a.txt'), join(directory, 'b.txt'))

    await expect(
      writeFileAtomically({ path: join(directory, 'a.txt'), content: 'nope\n' }),
    ).rejects.toThrow(/too many levels of symbolic links/)
  })

  it('never exposes a partially written file, because the name only ever moves in whole', async () => {
    const directory = join(root, 'concurrent')
    const path = join(directory, 'race.txt')
    const bodies = Array.from(
      { length: 16 },
      (_, index) => `${'line\n'.repeat(200)}writer ${index}\n`,
    )

    await Promise.all(bodies.map((content) => writeFileAtomically({ path, content })))

    expect(bodies).toContain(await readFile(path, 'utf8'))
    expect(await readdir(directory)).toEqual(['race.txt'])
  })
})
