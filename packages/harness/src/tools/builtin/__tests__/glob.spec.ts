import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  new GlobTool(root).invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'glob-1',
  })

describe('GlobTool', () => {
  it('returns the matches inside the workspace', async () => {
    const outcome = await scan({ pattern: '**/*.txt' })

    expect(outcome).toMatchObject({
      ok: true,
      output: {
        paths: expect.arrayContaining([join(root, 'inside.txt'), join(root, 'sub', 'deep.txt')]),
      },
    })
  })

  it('drops a match outside the workspace root, whatever the pattern was', async () => {
    const outcome = await scan({ pattern: '../*.txt' })

    expect(outcome).toMatchObject({ ok: true, output: { paths: [] } })
    expect(JSON.stringify(outcome)).not.toContain(outside)
  })

  it('returns nothing outside the root for patterns whose escape resolve cannot see', async () => {
    for (const pattern of ['{.,..}/*.txt', '[.][.]/*.txt', '@(..)/*.txt']) {
      const outcome = await scan({ pattern })

      expect(JSON.stringify(outcome)).not.toContain(outside)
    }
  })

  it('drops a match reached through a path that escapes the root', async () => {
    const outcome = await scan({ path: join(root, 'sub'), pattern: '../../*.txt' })

    expect(outcome).toMatchObject({ ok: true, output: { paths: [] } })
  })
})
