import { toThreadId } from '@dltech/atlas-core'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { GlobTool } from '../glob'

let root = ''
let outside = ''

beforeAll(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'atlas-glob-'))
  root = join(parent, 'workspace')
  outside = join(parent, 'secrets.txt')

  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(outside, 'outside')
  await writeFile(join(root, 'inside.txt'), 'inside')
  await writeFile(join(root, 'sub', 'deep.txt'), 'deep')
})

const scan = async (input: unknown) =>
  new GlobTool().invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'glob-1',
    projectDirectory: root,
    threadId: toThreadId('thread-1'),
  })

describe('GlobTool', () => {
  it('returns the matches under the directory it scans', async () => {
    const outcome = await scan({ pattern: '**/*.txt' })

    expect(outcome).toMatchObject({
      ok: true,
      output: {
        paths: expect.arrayContaining([join(root, 'inside.txt'), join(root, 'sub', 'deep.txt')]),
      },
    })
  })

  it('reaches outside the directory it scans when the pattern says to', async () => {
    const outcome = await scan({ pattern: '../*.txt' })

    expect(outcome).toMatchObject({ ok: true, output: { paths: [outside] } })
  })

  it('follows a path argument out of the directory it started in', async () => {
    const outcome = await scan({ path: join(root, 'sub'), pattern: '../../*.txt' })

    expect(outcome).toMatchObject({ ok: true, output: { paths: [outside] } })
  })

  it('finds files through a symlinked directory inside the project', async () => {
    await symlink(join(root, 'sub'), join(root, 'linked-sub'))

    const outcome = await scan({ pattern: '**/*.txt' })

    expect(outcome).toMatchObject({
      ok: true,
      output: { paths: expect.arrayContaining([join(root, 'sub', 'deep.txt')]) },
    })
  })
})
