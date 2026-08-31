import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
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
